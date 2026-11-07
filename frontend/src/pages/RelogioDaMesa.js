import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import { useFilaDeCartoes } from '../hooks/useFilaDeCartoes';
import { usePresencaDoRelogio } from '../hooks/usePresencaDoRelogio';
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh';
import { useTelaAcesa } from '../hooks/useTelaAcesa';
import { pendentesDoJogador } from '../utils/filaDeCartoes';
import {
  FASE, RUA, estadoInicial, nivelDeAlerta, relogioReducer, segundosRestantes,
} from '../utils/relogioDeAcao';
import './RelogioDaMesa.css';

// Mais rápido que o segundo, para o número não pular dois de uma vez.
const TIQUE_MS = 200;
const ULTIMOS_SEGUNDOS_COM_BIPE = 3;
// Folga para o servidor já estar no nível novo quando a tela reler.
const FOLGA_DA_VIRADA_MS = 1500;

const preferenciaDoAparelho = (chave) => {
  try {
    return localStorage.getItem(chave) === '1';
  } catch {
    return false;
  }
};

const guardarPreferencia = (chave, ligado) => {
  try {
    localStorage.setItem(chave, ligado ? '1' : '0');
  } catch (erro) {
    console.warn('[Relógio] preferência não guardada:', erro);
  }
};

const bipar = (contexto) => {
  if (!contexto) return;
  const som = contexto.createOscillator();
  const volume = contexto.createGain();
  som.frequency.value = 880;
  volume.gain.value = 0.2;
  som.connect(volume).connect(contexto.destination);
  som.start();
  som.stop(contexto.currentTime + 0.12);
};

const nomeDoJogador = (assento) => assento.nickname || assento.name;

const RelogioDaMesa = () => {
  const { dayId, tableId } = useParams();
  const { t } = useTranslation();
  useTelaAcesa();
  usePresencaDoRelogio(dayId, tableId);

  const [mesa, setMesa] = useState(null);
  const [falha, setFalha] = useState('');
  const [relogio, despachar] = useReducer(relogioReducer, estadoInicial);
  const [agora, setAgora] = useState(() => Date.now());
  const [escolhendo, setEscolhendo] = useState(false);
  const [ultimoCartao, setUltimoCartao] = useState(null);
  const [espelhar, setEspelhar] = useState(() => preferenciaDoAparelho('relogio_espelhar'));
  const [comSom, setComSom] = useState(() => preferenciaDoAparelho('relogio_som'));
  const audio = useRef(null);
  const ultimoBipe = useRef(null);

  const carregar = useCallback(async () => {
    try {
      const res = await api.get(`/table-clock/table/${tableId}`);
      setMesa(res.data);
      setFalha('');
    } catch (erro) {
      // Com a mesa já na tela, a rede fora não atrapalha: o relógio é local.
      setFalha(erro.userMessage || t('tableClock.loadError', 'Não deu para abrir esta mesa.'));
    }
  }, [tableId, t]);

  const { fila, usar, desfazer } = useFilaDeCartoes(carregar);

  useEffect(() => {
    carregar();
  }, [carregar]);

  useRealtimeRefresh({
    canal: `relogio-mesa-${tableId}`,
    tabelas: [
      { table: 'tournament_days', filter: `id=eq.${dayId}` },
      { table: 'tournament_players', filter: `tournament_day_id=eq.${dayId}` },
      { table: 'tournament_tables', filter: `tournament_day_id=eq.${dayId}` },
      { table: 'seat_allocations', filter: `table_id=eq.${tableId}` },
      { table: 'time_bank_events', filter: `tournament_day_id=eq.${dayId}` },
      { table: 'table_clock_settings', filter: `tournament_day_id=eq.${dayId}` },
    ],
    aoMudar: carregar,
    ativo: !!dayId,
  });

  // O nível vira pelo relógio, sem nada mudar no banco: nenhum evento avisaria
  // que o intervalo começou.
  const fimDoNivel = mesa?.timer?.level_ends_at;
  const horaDoServidor = mesa?.timer?.server_time;
  useEffect(() => {
    if (!fimDoNivel || !horaDoServidor) return undefined;
    const espera = setTimeout(carregar, (fimDoNivel - horaDoServidor) * 1000 + FOLGA_DA_VIRADA_MS);
    return () => clearTimeout(espera);
  }, [fimDoNivel, horaDoServidor, carregar]);

  const config = mesa?.settings;
  const timer = mesa?.timer;
  const travado = !!timer && (timer.is_break || timer.is_paused);
  const podeContar = !!mesa?.clock_active && !travado;
  const comBanco = !!mesa?.time_bank?.available;

  useEffect(() => {
    if (travado) {
      despachar({ tipo: 'PARAR' });
      setEscolhendo(false);
      setUltimoCartao(null);
    }
  }, [travado]);

  const contando = relogio.fase === FASE.CONTANDO;
  useEffect(() => {
    if (!contando) return undefined;
    const tique = setInterval(() => {
      const instante = Date.now();
      setAgora(instante);
      despachar({ tipo: 'TIQUE', agora: instante });
    }, TIQUE_MS);
    return () => clearInterval(tique);
  }, [contando]);

  const segundos = segundosRestantes(relogio, agora);

  useEffect(() => {
    if (relogio.fase === FASE.ESGOTADO) setEscolhendo(true);
  }, [relogio.fase]);

  useEffect(() => {
    if (!comSom || !contando || segundos > ULTIMOS_SEGUNDOS_COM_BIPE || segundos === ultimoBipe.current) return;
    ultimoBipe.current = segundos;
    bipar(audio.current);
  }, [comSom, contando, segundos]);

  const comandar = (tipo) => {
    const instante = Date.now();
    setAgora(instante);
    ultimoBipe.current = null;
    despachar({ tipo, agora: instante, config });
  };

  const novaAcao = (tipo) => {
    setUltimoCartao(null);
    comandar(tipo);
  };

  const usarCartao = (assento) => {
    const clientEventId = usar(tableId, assento.tournament_player_id);
    setUltimoCartao({ clientEventId, nome: nomeDoJogador(assento) });
    setEscolhendo(false);
    comandar('CARTAO');
  };

  const desfazerCartao = async () => {
    const alvo = ultimoCartao;
    setUltimoCartao(null);
    comandar('DESFAZER_CARTAO');
    await desfazer(alvo.clientEventId);
  };

  const fecharEscolha = () => {
    setEscolhendo(false);
    if (relogio.fase === FASE.ESGOTADO) despachar({ tipo: 'PARAR' });
  };

  const alternarEspelho = (ligado) => {
    setEspelhar(ligado);
    guardarPreferencia('relogio_espelhar', ligado);
  };

  const alternarSom = (ligado) => {
    // O navegador só libera áudio depois de um toque: é este.
    const Contexto = window.AudioContext || window.webkitAudioContext;
    if (ligado && !audio.current && Contexto) audio.current = new Contexto();
    setComSom(ligado);
    guardarPreferencia('relogio_som', ligado);
  };

  if (!mesa) {
    return (
      <div className="rm-tela rm-tela--carregando">
        {falha
          ? <p role="alert">{falha}</p>
          : <p>{t('common.loading')}</p>}
      </div>
    );
  }

  const saldoDe = (assento) => Math.max(0, assento.cards - pendentesDoJogador(fila, assento.tournament_player_id));
  const noLimite = relogio.cartoesNaDecisao >= config.max_cards_per_decision;
  const esgotado = relogio.fase === FASE.ESGOTADO;
  const pausado = relogio.fase === FASE.PAUSADO;

  const motivoDoAviso = () => {
    if (timer.is_break) return t('tableClock.onBreak', 'Intervalo');
    if (timer.is_paused) return t('tableClock.tournamentPaused', 'Torneio pausado');
    if (!config.enabled) return t('tableClock.turnedOff', 'Relógio desligado neste dia. Só o relógio chamado funciona.');
    if (!mesa.clock_active) {
      return t('tableClock.startsAtLevel', {
        defaultValue: 'O relógio começa no nível {{level}}. Até lá, só o relógio chamado funciona.',
        level: config.start_level,
      });
    }
    return '';
  };

  const rotulo = () => {
    if (esgotado) return t('tableClock.timeUp', 'Tempo!');
    if (pausado) return t('tableClock.paused', 'Pausado');
    if (relogio.fase === FASE.PARADO) return t('tableClock.waiting', 'Aguardando');
    if (relogio.chamado) return t('tableClock.calledClock', 'Relógio chamado');
    return relogio.rua === RUA.POS
      ? t('tableClock.postflop', 'Pós-flop')
      : t('tableClock.preflop', 'Pré-flop');
  };

  const aviso = motivoDoAviso();
  const alerta = nivelDeAlerta(relogio.fase, segundos);
  // Parado não é "acabou o tempo": um zero enorme na mesa diria isso ao jogador.
  const numero = relogio.fase === FASE.PARADO ? '--' : segundos;

  return (
    <div className={`rm-tela${alerta ? ` rm-tela--${alerta}` : ''}`}>
      <header className="rm-topo">
        <Link className="rm-voltar" to={`/relogio-mesa/${dayId}`} aria-label={t('tableClock.backToTables', 'Voltar para as mesas')}>‹</Link>
        <strong className="rm-mesa">
          {t('tableClock.table', { defaultValue: 'Mesa {{number}}', number: mesa.table.table_number })}
        </strong>
        <span className="rm-nivel">
          {t('tableClock.level', { defaultValue: 'Nível {{level}}', level: timer.display_level })}
          {!timer.is_break && timer.big_blind ? ` · ${timer.small_blind}/${timer.big_blind}` : ''}
          {!timer.is_break && timer.ante ? ` (${timer.ante})` : ''}
        </span>
        {fila.length > 0 && (
          <span className="rm-pendentes">
            {t('tableClock.pendingCards', { defaultValue: 'Cartões a enviar: {{total}}', total: fila.length })}
          </span>
        )}
        <div className="rm-opcoes">
          <label>
            <input type="checkbox" checked={comSom} onChange={(e) => alternarSom(e.target.checked)} />
            {t('tableClock.sound', 'Som')}
          </label>
          <label>
            <input type="checkbox" checked={espelhar} onChange={(e) => alternarEspelho(e.target.checked)} />
            {t('tableClock.mirror', 'Espelhar')}
          </label>
        </div>
      </header>

      {aviso && <p className="rm-aviso">{aviso}</p>}

      <main className="rm-centro">
        {espelhar && <div className="rm-digitos rm-digitos--invertido" aria-hidden="true">{numero}</div>}
        <div className="rm-digitos" role="timer" aria-live="off">{numero}</div>
        <p className="rm-rotulo">{rotulo()}</p>
      </main>

      {ultimoCartao && (
        <div className="rm-ultimo">
          <span>
            {t('tableClock.cardUsed', { defaultValue: '{{name}} usou um cartão', name: ultimoCartao.nome })}
          </span>
          <button type="button" onClick={desfazerCartao}>{t('tableClock.undo', 'Desfazer')}</button>
        </div>
      )}

      <nav className="rm-comandos">
        <button type="button" disabled={!podeContar} onClick={() => novaAcao('NOVA_MAO')}>
          {t('tableClock.newHand', 'Nova mão')}
        </button>
        <button type="button" disabled={!podeContar} onClick={() => novaAcao('FLOP')}>
          {t('tableClock.flop', 'Flop')}
        </button>
        <button type="button" className="rm-principal" disabled={!podeContar} onClick={() => novaAcao('PROXIMA')}>
          {t('tableClock.nextAction', 'Próxima ação')}
        </button>
        {comBanco && (
          <button
            type="button"
            disabled={!(contando || pausado)}
            onClick={() => setEscolhendo(true)}
          >
            {t('tableClock.timeBank', 'Time bank')}
          </button>
        )}
        <button
          type="button"
          disabled={!(contando || pausado)}
          onClick={() => comandar(pausado ? 'RETOMAR' : 'PAUSAR')}
        >
          {pausado ? t('tableClock.resume', 'Retomar') : t('tableClock.pause', 'Pausar')}
        </button>
        <button type="button" disabled={travado} onClick={() => novaAcao('CHAMAR')}>
          {t('tableClock.calledClock', 'Relógio chamado')}
        </button>
      </nav>

      {escolhendo && (
        <div className="rm-escolha" role="dialog" aria-modal="true" aria-label={t('tableClock.whoUsesCard', 'Quem vai usar o cartão?')}>
          {contando && <p className="rm-escolha-tempo" aria-hidden="true">{segundos}</p>}
          <h2>
            {comBanco
              ? t('tableClock.whoUsesCard', 'Quem vai usar o cartão?')
              : t('tableClock.callFloorHint', 'Tempo esgotado. Chame o floor.')}
          </h2>
          {comBanco && noLimite && (
            <p className="rm-limite">
              {t('tableClock.maxReached', {
                defaultValue: 'Chegou ao máximo de {{max}} cartões nesta decisão.',
                max: config.max_cards_per_decision,
              })}
            </p>
          )}
          {comBanco && (
            <div className="rm-assentos">
              {mesa.seats.map((assento) => {
                const saldo = saldoDe(assento);
                return (
                  <button
                    key={assento.tournament_player_id}
                    type="button"
                    disabled={saldo <= 0 || noLimite}
                    onClick={() => usarCartao(assento)}
                  >
                    <span className="rm-assento-numero">{assento.seat_number}</span>
                    <span className="rm-assento-nome">{nomeDoJogador(assento)}</span>
                    <span className="rm-assento-cartoes">
                      {t('tableClock.cardsLeft', { defaultValue: 'Cartões: {{cards}}', cards: saldo })}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          <button type="button" className="rm-fechar" onClick={fecharEscolha}>
            {esgotado ? t('tableClock.callFloor', 'Chamar o floor') : t('tableClock.back', 'Voltar')}
          </button>
        </div>
      )}
    </div>
  );
};

export default RelogioDaMesa;
