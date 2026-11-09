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
  assentosDaMesa, formatarTempo, posicaoDoAssento, segundosDoNivel,
} from '../utils/mesaDesenhada';
import {
  FASE, RUA, estadoInicial, nivelDeAlerta, relogioReducer, segundosRestantes,
} from '../utils/relogioDeAcao';
import './RelogioDaMesa.css';

// Contando, mais rápido que o segundo, para o número não pular dois de uma vez.
// Parado, basta o segundo do relógio do nível.
const TIQUE_CONTANDO_MS = 200;
const TIQUE_PARADO_MS = 1000;
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
  // Quanto o servidor está à frente do aparelho: o tempo do nível conta pelo dele.
  const [diferenca, setDiferenca] = useState(0);
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
      const horaDoServidor = res.data?.timer?.server_time;
      if (horaDoServidor) setDiferenca(horaDoServidor - Date.now() / 1000);
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
    const tique = setInterval(() => {
      const instante = Date.now();
      setAgora(instante);
      despachar({ tipo: 'TIQUE', agora: instante });
    }, contando ? TIQUE_CONTANDO_MS : TIQUE_PARADO_MS);
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
  const assentos = assentosDaMesa(mesa.table.seats, mesa.seats, mesa.table.blocked_seats || []);
  const semListaDaMesa = mesa.time_bank?.reason === 'eliminacao_em_massa';

  // Por que os botões estão travados, e o que fazer. Fica no centro da mesa: na
  // faixa do topo o dealer não via, e achava que o botão estava quebrado.
  const motivoDoBloqueio = () => {
    if (timer.is_break) return { texto: t('tableClock.onBreak', 'Intervalo') };
    // `started` falso, e não ausente: servidor antigo não manda, e aí vale pausado.
    if (timer.is_paused && timer.started === false) {
      return {
        texto: t('tableClock.notStarted', 'O torneio ainda não começou.'),
        dica: t('tableClock.notStartedHint', 'O relógio libera quando o nível 1 começar no Controle do torneio.'),
      };
    }
    if (timer.is_paused) {
      return {
        texto: t('tableClock.tournamentPaused', 'Torneio pausado'),
        dica: t('tableClock.pausedHint', 'O relógio volta quando o Controle retomar o nível.'),
      };
    }
    if (!config.enabled) {
      return {
        texto: t('tableClock.turnedOff', 'Relógio desligado neste dia. Só o relógio chamado funciona.'),
        dica: t('tableClock.turnedOffHint', 'Para ligar: Relógio de Mesa, Configuração do dia.'),
      };
    }
    if (!mesa.clock_active) {
      return {
        texto: t('tableClock.startsAtLevel', {
          defaultValue: 'O relógio começa no nível {{level}}. Até lá, só o relógio chamado funciona.',
          level: config.start_level,
        }),
      };
    }
    return null;
  };

  const rotulo = () => {
    if (esgotado) return t('tableClock.timeUp', 'Tempo!');
    if (pausado) return t('tableClock.paused', 'Pausado');
    if (relogio.chamado) return t('tableClock.calledClock', 'Relógio chamado');
    return relogio.rua === RUA.POS
      ? t('tableClock.postflop', 'Pós-flop')
      : t('tableClock.preflop', 'Pré-flop');
  };

  const nivelEBlinds = () => {
    const nivel = t('tableClock.level', { defaultValue: 'Nível {{level}}', level: timer.display_level });
    if (timer.is_break || !timer.big_blind) return nivel;
    return `${nivel} · ${timer.small_blind}/${timer.big_blind}${timer.ante ? ` (${timer.ante})` : ''}`;
  };

  const aviso = motivoDoBloqueio();
  const alerta = nivelDeAlerta(relogio.fase, segundos);
  const comContagem = relogio.fase !== FASE.PARADO;

  const conteudoDoAssento = ({ numero, jogador, bloqueado }) => {
    if (jogador) {
      return (
        <>
          <span className="rm-assento-nome">{nomeDoJogador(jogador)}</span>
          {comBanco && (
            <span className="rm-assento-cartoes">
              {t('tableClock.cardsLeft', { defaultValue: 'Cartões: {{cards}}', cards: saldoDe(jogador) })}
            </span>
          )}
        </>
      );
    }
    // Na eliminação em massa a lista não vem: "Livre" diria que a mesa está vazia.
    if (!bloqueado && semListaDaMesa) return null;
    return (
      <span className="rm-assento-nome rm-assento-nome--vazio">
        {bloqueado ? t('tableClock.blockedSeat', 'Bloqueado') : t('tableClock.emptySeat', 'Livre')}
      </span>
    );
  };

  return (
    <div className={`rm-tela${alerta ? ` rm-tela--${alerta}` : ''}`}>
      <header className="rm-topo">
        <Link className="rm-voltar" to={`/relogio-mesa/${dayId}`} aria-label={t('tableClock.backToTables', 'Voltar para as mesas')}>‹</Link>
        <strong className="rm-mesa">
          {t('tableClock.table', { defaultValue: 'Mesa {{number}}', number: mesa.table.table_number })}
        </strong>
        <span className="rm-nivel">{nivelEBlinds()}</span>
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

      <main className={`rm-mesa-area${escolhendo ? ' rm-mesa-area--escolhendo' : ''}`}>
        <div className={`rm-oval${espelhar && comContagem ? ' rm-oval--espelho' : ''}`}>
          {comContagem ? (
            <>
              {espelhar && <div className="rm-digitos rm-digitos--invertido" aria-hidden="true">{segundos}</div>}
              <div className="rm-digitos" role="timer" aria-live="off">{segundos}</div>
              <p className="rm-rotulo">{rotulo()}</p>
            </>
          ) : (
            <div className="rm-nivel-relogio">
              <span className="rm-nivel-tempo">
                {formatarTempo(segundosDoNivel(timer, diferenca, agora))}
              </span>
              {!timer.is_break && <span className="rm-nivel-blinds">{nivelEBlinds()}</span>}
              {aviso && (
                <p className="rm-aviso">
                  {aviso.texto}
                  {aviso.dica && <small>{aviso.dica}</small>}
                </p>
              )}
            </div>
          )}

          {escolhendo && (
            <div className="rm-pergunta">
              <strong>
                {comBanco
                  ? t('tableClock.whoUsesCard', 'Quem vai usar o cartão?')
                  : t('tableClock.callFloorHint', 'Tempo esgotado. Chame o floor.')}
              </strong>
              {comBanco && (
                <small className={noLimite ? 'rm-limite' : undefined}>
                  {noLimite
                    ? t('tableClock.maxReached', {
                      defaultValue: 'Chegou ao máximo de {{max}} cartões nesta decisão.',
                      max: config.max_cards_per_decision,
                    })
                    : t('tableClock.whoUsesCardHint', 'Toque no assento de quem usa o cartão.')}
                </small>
              )}
              <button type="button" className="rm-fechar" onClick={fecharEscolha}>
                {esgotado ? t('tableClock.callFloor', 'Chamar o floor') : t('tableClock.back', 'Voltar')}
              </button>
            </div>
          )}
        </div>

        {assentos.map((lugar, indice) => {
          const { x, y } = posicaoDoAssento(indice, assentos.length);
          // O dealer só usa cartão, e só na hora da escolha: fora dela a mão
          // dele passa pela tela o tempo todo.
          const disponivel = escolhendo && comBanco && !!lugar.jogador && saldoDe(lugar.jogador) > 0 && !noLimite;
          const classes = ['rm-assento'];
          if (!lugar.jogador) classes.push('rm-assento--vazio');
          if (lugar.bloqueado) classes.push('rm-assento--bloqueado');
          if (disponivel) classes.push('rm-assento--disponivel');
          return (
            <button
              key={lugar.numero}
              type="button"
              className={classes.join(' ')}
              style={{ left: `${x}%`, top: `${y}%` }}
              disabled={!disponivel}
              onClick={() => usarCartao(lugar.jogador)}
            >
              <span className="rm-assento-numero">{lugar.numero}</span>
              {conteudoDoAssento(lugar)}
            </button>
          );
        })}
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
    </div>
  );
};

export default RelogioDaMesa;
