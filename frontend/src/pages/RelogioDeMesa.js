import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import Icon from '../components/Icon';
import Card from '../components/Card';
import Button from '../components/Button';
import EmptyState from '../components/EmptyState';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { usePermissions } from '../contexts/PermissionContext';
import { useStage } from '../contexts/StageContext';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { usePresencaDoRelogio } from '../hooks/usePresencaDoRelogio';
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh';
import './RelogioDeMesa.css';

/** Mesmas chaves da rota `GERIR` do backend (routers/table_clock.py). */
export const PERMISSOES_DE_GESTAO = ['tables', 'tournaments', 'employees'];

const CAMPOS_DO_RELOGIO = [
  { chave: 'preflop_seconds', rotulo: ['tableClock.preflopSeconds', 'Pré-flop (segundos)'], min: 5, max: 300 },
  { chave: 'postflop_seconds', rotulo: ['tableClock.postflopSeconds', 'Pós-flop (segundos)'], min: 5, max: 300 },
  { chave: 'called_clock_seconds', rotulo: ['tableClock.calledClockSeconds', 'Relógio chamado (segundos)'], min: 5, max: 300 },
  { chave: 'start_level', rotulo: ['tableClock.startLevel', 'Começa no nível'], min: 1, max: 200 },
];

const CAMPOS_DO_BANCO = [
  { chave: 'card_seconds', rotulo: ['tableClock.cardSeconds', 'Segundos por cartão'], min: 5, max: 300 },
  { chave: 'initial_cards', rotulo: ['tableClock.initialCards', 'Cartões iniciais'], min: 0, max: 50 },
  { chave: 'cards_per_break', rotulo: ['tableClock.cardsPerBreak', 'Cartões por intervalo'], min: 0, max: 20 },
  { chave: 'max_cards_per_decision', rotulo: ['tableClock.maxPerDecision', 'Máximo por decisão'], min: 1, max: 50 },
];

const CamposNumericos = ({ campos, config, aoMudar, t }) => (
  <div className="rcm-campos">
    {campos.map(({ chave, rotulo, min, max }) => (
      <div className="form-group" key={chave}>
        <label htmlFor={`rcm-${chave}`}>{t(...rotulo)}</label>
        <input
          id={`rcm-${chave}`}
          type="number"
          min={min}
          max={max}
          value={config[chave]}
          onChange={(e) => aoMudar(chave, e.target.value)}
          required
        />
      </div>
    ))}
  </div>
);

/**
 * A mesma etapa do resto do app. Fica aqui também porque o login do dealer não
 * abre a tela de Etapas, e sem isso o tablet dele veria todas misturadas.
 */
const SeletorDeEtapa = ({ t }) => {
  const { selectedStage, selectStage, clearStage } = useStage();
  const [etapas, setEtapas] = useState([]);

  useEffect(() => {
    api.get('/stages', { _silentError: true })
      .then((res) => setEtapas(Array.isArray(res?.data) ? res.data : []))
      .catch(() => setEtapas([]));
  }, []);

  if (etapas.length === 0) return null;
  const escolher = (id) => {
    const etapa = etapas.find((e) => e.id === id);
    if (etapa) selectStage(etapa);
    else clearStage();
  };
  return (
    <div className="form-group rcm-etapa">
      <label htmlFor="rcm-etapa">{t('tableClock.stage', 'Etapa')}</label>
      <select id="rcm-etapa" value={selectedStage?.id || ''} onChange={(e) => escolher(e.target.value)}>
        <option value="">{t('tableClock.allStages', 'Todas as etapas')}</option>
        {etapas.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
      </select>
    </div>
  );
};

/** Os dias abertos da etapa, juntos por torneio, na ordem em que chegam. */
const porTorneio = (dias) => {
  const torneios = new Map();
  dias.forEach((dia) => {
    if (!torneios.has(dia.tournament_id)) {
      torneios.set(dia.tournament_id, { id: dia.tournament_id, nome: dia.tournament_name, dias: [] });
    }
    torneios.get(dia.tournament_id).dias.push(dia);
  });
  return Array.from(torneios.values());
};

const situacaoDoDia = (dia, t) => (dia.status === 'active'
  ? t('tableClock.dayActive', 'Em andamento')
  : t('tableClock.dayPending', 'Ainda não começou'));

/**
 * Escolher o torneio e, se ele tiver mais de um dia aberto, o dia. Torneio de
 * um dia só leva direto às mesas: é o caso mais comum, e um passo a mais ali
 * não escolheria nada.
 */
const EscolhaDoTorneio = ({ tournamentId, t }) => {
  const { selectedStage } = useStage();
  const etapaId = selectedStage?.id || '';
  const [dias, setDias] = useState(null);

  useEffect(() => {
    setDias(null);
    // A API filtra pela etapa do cabeçalho X-Stage-ID, que o app já manda.
    api.get('/table-clock/days')
      .then((res) => setDias(res.data || []))
      .catch(() => setDias([]));
  }, [etapaId]);

  if (!dias) return <p className="loading">{t('common.loading')}</p>;

  if (tournamentId) {
    const doTorneio = dias
      .filter((d) => d.tournament_id === tournamentId)
      .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
    return (
      <>
        <Link className="rcm-voltar" to="/relogio-mesa">{t('tableClock.otherTournaments', 'Outros torneios')}</Link>
        {doTorneio.length === 0 ? (
          <EmptyState icon={<Icon name="clock" />} title={t('tableClock.noDaysInTournament', 'Nenhum dia aberto neste torneio.')} />
        ) : (
          <div className="rcm-lista">
            {doTorneio.map((dia) => (
              <Link className="rcm-item" key={dia.id} to={`/relogio-mesa/${dia.id}`}>
                <strong>{dia.day_name}</strong>
                <span>{situacaoDoDia(dia, t)}</span>
              </Link>
            ))}
          </div>
        )}
      </>
    );
  }

  const torneios = porTorneio(dias);
  if (torneios.length === 0) {
    return <EmptyState icon={<Icon name="clock" />} title={t('tableClock.noOpenTournaments', 'Nenhum torneio com dia aberto nesta etapa.')} />;
  }
  return (
    <div className="rcm-lista">
      {torneios.map((torneio) => {
        const unico = torneio.dias.length === 1 ? torneio.dias[0] : null;
        return (
          <Link
            className="rcm-item"
            key={torneio.id}
            to={unico ? `/relogio-mesa/${unico.id}` : `/relogio-mesa/torneio/${torneio.id}`}
          >
            <strong>{torneio.nome}</strong>
            <span>
              {/* Dia com o nome do torneio (comum em torneio de um dia só) não repete o nome. */}
              {unico && (unico.day_name && unico.day_name !== torneio.nome
                ? `${unico.day_name} · ${situacaoDoDia(unico, t)}`
                : situacaoDoDia(unico, t))}
              {!unico && t('tableClock.daysOpen', { defaultValue: '{{total}} dias abertos', total: torneio.dias.length })}
            </span>
          </Link>
        );
      })}
    </div>
  );
};

const ListaDeMesas = ({ dayId, t }) => {
  const [mesas, setMesas] = useState(null);
  const abertas = usePresencaDoRelogio(dayId);

  useEffect(() => {
    api.get(`/tables/day/${dayId}`)
      .then((res) => setMesas(res.data || []))
      .catch(() => setMesas([]));
  }, [dayId]);

  if (!mesas) return <p className="loading">{t('common.loading')}</p>;
  if (mesas.length === 0) {
    return <EmptyState icon={<Icon name="grid" />} title={t('tableClock.noTables', 'Este dia ainda não tem mesas.')} />;
  }
  return (
    <div className="rcm-lista rcm-lista--mesas">
      {mesas.map((mesa) => (
        <Link className="rcm-item" key={mesa.id} to={`/relogio-mesa/${dayId}/mesa/${mesa.id}`}>
          <strong>{t('tableClock.table', { defaultValue: 'Mesa {{number}}', number: mesa.table_number })}</strong>
          {abertas.includes(mesa.id) && (
            <span className="rcm-aberto">{t('tableClock.clockOpen', 'Relógio aberto')}</span>
          )}
        </Link>
      ))}
    </div>
  );
};

const Configuracao = ({ dayId, atual, banco, aoSalvar, t }) => {
  const { toast } = useToast();
  const [config, setConfig] = useState(atual);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => setConfig(atual), [atual]);

  const mudarNumero = (chave, valor) => setConfig((c) => ({ ...c, [chave]: valor }));
  const mudarCaixa = (chave, ligado) => setConfig((c) => ({ ...c, [chave]: ligado }));

  const salvar = async (evento) => {
    evento.preventDefault();
    setSalvando(true);
    const corpo = { ...config };
    [...CAMPOS_DO_RELOGIO, ...CAMPOS_DO_BANCO].forEach(({ chave }) => {
      corpo[chave] = Number(config[chave]);
    });
    try {
      await api.put(`/table-clock/day/${dayId}/settings`, corpo);
      toast.success(t('tableClock.saved', 'Configuração salva.'));
      aoSalvar();
    } catch (erro) {
      toast.error(erro.userMessage || t('tableClock.saveError', 'Não deu para salvar.'));
    } finally {
      setSalvando(false);
    }
  };

  return (
    <Card title={t('tableClock.settings', 'Configuração do dia')}>
      <form onSubmit={salvar}>
        <label className="rcm-caixa">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => mudarCaixa('enabled', e.target.checked)}
          />
          {t('tableClock.enable', 'Ligar o relógio neste dia')}
        </label>
        <CamposNumericos campos={CAMPOS_DO_RELOGIO} config={config} aoMudar={mudarNumero} t={t} />

        <label className="rcm-caixa">
          <input
            type="checkbox"
            checked={config.time_bank_enabled}
            onChange={(e) => mudarCaixa('time_bank_enabled', e.target.checked)}
          />
          {t('tableClock.enableTimeBank', 'Usar time bank')}
        </label>
        {banco.reason === 'eliminacao_em_massa' && (
          <p className="rcm-aviso">
            {t('tableClock.bulkEliminationHint', 'Este torneio usa eliminação em massa: o sistema não sabe quem saiu da mesa, então só o relógio funciona. Para ter time bank, crie o torneio com eliminação por mesa.')}
          </p>
        )}
        {config.time_bank_enabled && (
          <CamposNumericos campos={CAMPOS_DO_BANCO} config={config} aoMudar={mudarNumero} t={t} />
        )}

        <Button type="submit" disabled={salvando}>{t('common.save', 'Salvar')}</Button>
      </form>
    </Card>
  );
};

const ModalDeAjuste = ({ dayId, jogador, aoFechar, aoSalvar, t }) => {
  const { toast } = useToast();
  const [cartoes, setCartoes] = useState('1');
  const [motivo, setMotivo] = useState('');
  const [salvando, setSalvando] = useState(false);
  useEscapeKey(!salvando, aoFechar);

  const quantidade = Number(cartoes);
  const valido = Number.isInteger(quantidade) && quantidade !== 0 && motivo.trim().length > 0;

  const confirmar = async (evento) => {
    evento.preventDefault();
    setSalvando(true);
    try {
      await api.post(`/table-clock/day/${dayId}/players/${jogador.tournament_player_id}/adjust`, {
        cards: quantidade,
        reason: motivo.trim(),
      });
      aoSalvar();
      aoFechar();
    } catch (erro) {
      toast.error(erro.userMessage || t('tableClock.adjustError', 'Não deu para ajustar.'));
      setSalvando(false);
    }
  };

  return (
    <div
      className="modal-overlay"
      role="presentation"
      onClick={(e) => { if (e.target === e.currentTarget && !salvando) aoFechar(); }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label={t('tableClock.adjustCards', 'Ajustar cartões')}>
        <div className="modal-header">
          <h2>{t('tableClock.adjustCards', 'Ajustar cartões')}</h2>
          <button type="button" className="close-btn" onClick={aoFechar} aria-label={t('common.close')}>
            <span className="close-icon"></span>
          </button>
        </div>
        <form onSubmit={confirmar}>
          <p className="rcm-quem">{jogador.nickname || jogador.name}</p>
          <div className="form-group">
            <label htmlFor="rcm-ajuste-cartoes">
              {t('tableClock.adjustAmount', 'Cartões (use negativo para tirar)')}
            </label>
            <input
              id="rcm-ajuste-cartoes"
              type="number"
              min={-50}
              max={50}
              value={cartoes}
              onChange={(e) => setCartoes(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label htmlFor="rcm-ajuste-motivo">{t('tableClock.adjustReason', 'Motivo')}</label>
            <input
              id="rcm-ajuste-motivo"
              type="text"
              maxLength={200}
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
            />
          </div>
          <div className="modal-actions">
            <Button variant="secondary" onClick={aoFechar}>{t('common.cancel', 'Cancelar')}</Button>
            <Button type="submit" disabled={!valido || salvando}>{t('common.confirm', 'Confirmar')}</Button>
          </div>
        </form>
      </div>
    </div>
  );
};

const CartoesDosJogadores = ({ dayId, painel, aoMudar, t }) => {
  const [ajustando, setAjustando] = useState(null);

  return (
    <Card title={t('tableClock.playerCards', 'Cartões dos jogadores')}>
      <p className="rcm-direito">
        {t('tableClock.entitled', {
          defaultValue: 'Cada jogador tem direito a {{cards}} cartões agora.',
          cards: painel.entitled,
        })}
      </p>
      <div className="rcm-tabela">
        <table className="transactions-table">
          <thead>
            <tr>
              <th>{t('tableClock.player', 'Jogador')}</th>
              <th>{t('tableClock.tableColumn', 'Mesa')}</th>
              <th>{t('tableClock.seat', 'Assento')}</th>
              <th>{t('tableClock.cards', 'Cartões')}</th>
              <th>{t('tableClock.used', 'Usados')}</th>
              <th aria-label={t('tableClock.adjust', 'Ajustar')} />
            </tr>
          </thead>
          <tbody>
            {painel.players.map((jogador) => (
              <tr key={jogador.tournament_player_id}>
                <td>{jogador.nickname || jogador.name}</td>
                <td>{jogador.table_number ?? '--'}</td>
                <td>{jogador.seat_number ?? '--'}</td>
                <td><strong>{jogador.cards}</strong></td>
                <td>{jogador.used}</td>
                <td>
                  <Button variant="secondary" size="small" onClick={() => setAjustando(jogador)}>
                    {t('tableClock.adjust', 'Ajustar')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {ajustando && (
        <ModalDeAjuste
          dayId={dayId}
          jogador={ajustando}
          aoFechar={() => setAjustando(null)}
          aoSalvar={aoMudar}
          t={t}
        />
      )}
    </Card>
  );
};

const Historico = ({ eventos, t }) => {
  const { i18n } = useTranslation();
  const tipos = {
    use: t('tableClock.kindUse', 'Usou'),
    undo: t('tableClock.kindUndo', 'Desfeito'),
    adjust: t('tableClock.kindAdjust', 'Ajuste'),
  };
  const hora = (valor) => new Date(valor).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' });

  return (
    <Card title={t('tableClock.history', 'Histórico de cartões')}>
      {eventos.length === 0 ? (
        <p className="rcm-direito">{t('tableClock.noHistory', 'Nenhum cartão usado ainda.')}</p>
      ) : (
        <div className="rcm-tabela">
          <table className="transactions-table">
            <thead>
              <tr>
                <th>{t('tableClock.time', 'Hora')}</th>
                <th>{t('tableClock.player', 'Jogador')}</th>
                <th>{t('tableClock.tableColumn', 'Mesa')}</th>
                <th>{t('tableClock.what', 'O quê')}</th>
                <th>{t('tableClock.cards', 'Cartões')}</th>
                <th>{t('tableClock.adjustReason', 'Motivo')}</th>
              </tr>
            </thead>
            <tbody>
              {eventos.map((evento) => (
                <tr key={evento.id}>
                  <td>{hora(evento.created_at)}</td>
                  <td>{evento.player_name}</td>
                  <td>{evento.table_number ?? '--'}</td>
                  <td>{tipos[evento.kind]}</td>
                  <td>{evento.cards > 0 ? `+${evento.cards}` : evento.cards}</td>
                  <td>{evento.reason || '--'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
};

const Gestao = ({ dayId, t }) => {
  const [painel, setPainel] = useState(null);
  const [eventos, setEventos] = useState([]);

  const carregar = useCallback(async () => {
    const [resPainel, resEventos] = await Promise.all([
      api.get(`/table-clock/day/${dayId}/panel`),
      api.get(`/table-clock/day/${dayId}/events`),
    ]);
    setPainel(resPainel.data);
    setEventos(resEventos.data || []);
  }, [dayId]);

  useEffect(() => {
    carregar().catch((erro) => console.error('[Relógio] painel não carregou:', erro));
  }, [carregar]);

  const recarregar = useRealtimeRefresh({
    canal: `relogio-painel-${dayId}`,
    tabelas: [
      { table: 'time_bank_events', filter: `tournament_day_id=eq.${dayId}` },
      { table: 'tournament_players', filter: `tournament_day_id=eq.${dayId}` },
      { table: 'tournament_tables', filter: `tournament_day_id=eq.${dayId}` },
    ],
    aoMudar: carregar,
  });

  if (!painel) return <p className="loading">{t('common.loading')}</p>;

  return (
    <>
      <Configuracao
        dayId={dayId}
        atual={painel.settings}
        banco={painel.time_bank}
        aoSalvar={recarregar}
        t={t}
      />
      {painel.time_bank.available && (
        <CartoesDosJogadores dayId={dayId} painel={painel} aoMudar={recarregar} t={t} />
      )}
      {painel.time_bank.available && <Historico eventos={eventos} t={t} />}
    </>
  );
};

const RelogioDeMesa = () => {
  const { dayId, tournamentId } = useParams();
  const { t } = useTranslation();
  const { hasPermission } = usePermissions();
  const podeGerir = PERMISSOES_DE_GESTAO.some(hasPermission);

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content rcm-tela">
        <div className="cx-header">
          <div className="cx-header-left">
            <div className="cx-header-icon"><Icon name="clock" /></div>
            <div>
              <h1 className="cx-title">{t('tableClock.title', 'Relógio de mesa')}</h1>
              <p className="cx-subtitle">
                {dayId && t('tableClock.chooseTable', 'Escolha a mesa deste tablet.')}
                {!dayId && tournamentId && t('tableClock.chooseDay', 'Escolha o dia do torneio.')}
                {!dayId && !tournamentId && t('tableClock.chooseTournament', 'Escolha o torneio.')}
              </p>
            </div>
          </div>
          {dayId && (
            <div className="rcm-links">
              {podeGerir && (
                <Link className="rcm-outro-dia" to={`/painel-mesas/${dayId}`}>{t('floorPanel.title', 'Painel de mesas')}</Link>
              )}
              <Link className="rcm-outro-dia" to="/relogio-mesa">{t('tableClock.otherDay', 'Trocar de dia')}</Link>
            </div>
          )}
        </div>

        {!dayId && <SeletorDeEtapa t={t} />}
        {!dayId && <EscolhaDoTorneio tournamentId={tournamentId} t={t} />}
        {dayId && <ListaDeMesas dayId={dayId} t={t} />}
        {dayId && podeGerir && <Gestao dayId={dayId} t={t} />}
      </main>
    </div>
  );
};

export default RelogioDeMesa;
