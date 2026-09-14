import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import Sidebar from '../components/Sidebar';
import CashboxBanner from '../components/CashboxBanner';
import EmptyState from '../components/EmptyState';
import Icon from '../components/Icon';
import { SkeletonStatCard, SkeletonBlock } from '../components/SkeletonLoader';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { useCashDay } from '../contexts/CashDayContext';
import useRealtimeRefresh from '../hooks/useRealtimeRefresh';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { aoMudarOCaixa } from '../utils/eventosDoCaixa';
import { hojeLocal } from '../utils/datasLocais';
import './CashFloor.css';

/**
 * O SALÃO: a tela que fica aberta a noite inteira.
 *
 * Ela responde três perguntas, nesta ordem de urgência:
 *   1. a operação está no ar? (dia aberto + caixa do operador aberto)
 *   2. onde tem lugar livre? (o grid de mesas)
 *   3. como está o dinheiro? (os indicadores do dia)
 *
 * FATURAMENTO É O RAKE, não os buy-ins. Buy-in é troca de dinheiro por ficha e
 * a maior parte volta ao jogador no cash-out; mostrá-lo como receita faria o
 * clube achar que fatura dez vezes mais do que fatura. Os buy-ins aparecem —
 * são o giro da noite —, mas rotulados como o que são.
 */
const CashFloor = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { formatCurrency } = useCurrency();
  const { day, cashDayId, isOpen, loading: dayLoading, reload: reloadDay } = useCashDay();

  const [tables, setTables] = useState([]);
  const [summary, setSummary] = useState(null);
  const [gameTypes, setGameTypes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [myCashbox, setMyCashbox] = useState(undefined);

  const [openDayModal, setOpenDayModal] = useState(false);
  const [openTableModal, setOpenTableModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [dayForm, setDayForm] = useState({ business_date: hojeLocal(), label: '' });
  const [tableForm, setTableForm] = useState({ game_type_id: '', table_number: '', seats: '' });

  useEscapeKey(openDayModal || openTableModal, () => {
    if (submitting) return;
    setOpenDayModal(false);
    setOpenTableModal(false);
  });

  const cashboxBlocked = myCashbox !== undefined && myCashbox !== null && myCashbox.status !== 'open';

  const loadFloor = useCallback(async () => {
    if (!cashDayId) { setTables([]); setSummary(null); setLoading(false); return; }
    // Uma falha não pode derrubar as outras: sem o resumo a tela ainda mostra
    // as mesas, que é o que o operador usa para sentar gente.
    const [mesas, resumo, tipos] = await Promise.all([
      api.get('/cash-game/tables', { params: { cash_day_id: cashDayId }, _silentError: true })
        .catch(() => ({ data: [] })),
      api.get(`/cash-game/days/${cashDayId}/summary`, { _silentError: true })
        .catch(() => ({ data: null })),
      api.get('/cash-game/game-types', { params: { active: true }, _silentError: true })
        .catch(() => ({ data: [] })),
    ]);
    setTables(mesas.data || []);
    setSummary(resumo.data || null);
    setGameTypes(tipos.data || []);
    setLoading(false);
  }, [cashDayId]);

  useEffect(() => { setLoading(true); loadFloor(); }, [loadFloor]);

  // O salão é estado COMPARTILHADO: outro caixa senta alguém na mesa 3 e esta
  // tela precisa saber. Agora quem avisa é o banco, e não um relógio — sentar
  // um jogador aparece aqui em ~100ms em vez de levar até 5 segundos.
  //
  // Sentar alguém escreve em três tabelas de uma vez; o hook junta a rajada
  // num único refetch.
  useRealtimeRefresh({
    canal: `cash-floor-${cashDayId || 'sem-dia'}`,
    tabelas: [
      { table: 'cash_tables', filter: cashDayId ? `cash_day_id=eq.${cashDayId}` : undefined },
      { table: 'cash_seats' },
      { table: 'cash_player_sessions', filter: cashDayId ? `cash_day_id=eq.${cashDayId}` : undefined },
      { table: 'cash_days' },
    ],
    aoMudar: () => loadFloor(),
    ativo: !!cashDayId,
  });
  useEffect(() => aoMudarOCaixa(() => loadFloor()), [loadFloor]);

  const abrirDia = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await api.post('/cash-game/days', {
        business_date: dayForm.business_date,
        label: dayForm.label || null,
      });
      toast.success(t('cash.dayOpened', 'Dia de operação aberto'));
      setOpenDayModal(false);
      await reloadDay();
      return res;
    } catch (err) {
      toast.error(err.userMessage || t('cash.dayOpenError', 'Não foi possível abrir o dia'));
      return null;
    } finally {
      setSubmitting(false);
    }
  };

  const abrirMesa = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await api.post('/cash-game/tables', {
        cash_day_id: cashDayId,
        game_type_id: tableForm.game_type_id,
        table_number: parseInt(tableForm.table_number, 10),
        seats: tableForm.seats ? parseInt(tableForm.seats, 10) : null,
      });
      toast.success(t('cash.tableOpened', 'Mesa aberta'));
      setOpenTableModal(false);
      setTableForm({ game_type_id: '', table_number: '', seats: '' });
      await loadFloor();
    } catch (err) {
      toast.error(err.userMessage || t('cash.tableOpenError', 'Não foi possível abrir a mesa'));
    } finally {
      setSubmitting(false);
    }
  };

  // O próximo número livre poupa o operador de conferir o salão a cada mesa.
  const proximoNumero = useMemo(() => {
    const usados = new Set(tables.filter((m) => m.status !== 'closed').map((m) => m.table_number));
    let n = 1;
    while (usados.has(n)) n += 1;
    return n;
  }, [tables]);

  const abrirModalDeMesa = () => {
    setTableForm({
      game_type_id: gameTypes[0]?.id || '',
      table_number: String(proximoNumero),
      seats: '',
    });
    setOpenTableModal(true);
  };

  // Memoizado: esta tela recarrega a cada evento do salão (Realtime), e a
  // lista alimenta o grid de mesas — identidade nova a cada render refaz
  // trabalho em toda a árvore abaixo.
  const abertas = useMemo(() => tables.filter((m) => m.status !== 'closed'), [tables]);

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div>
            <h1><Icon name="chips" className="page-header-icon" /> {t('cash.floor', 'Salão')}</h1>
            <p className="subtitle">
              {isOpen
                ? t('cash.floorSubtitleOpen', 'Operação do dia {{date}}', { date: day?.business_date })
                : t('cash.floorSubtitle', 'Mesas de cash game, fila e caixa do dia')}
            </p>
          </div>
          {isOpen && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={abrirModalDeMesa}
              disabled={cashboxBlocked || gameTypes.length === 0}
              title={gameTypes.length === 0
                ? t('cash.noGameTypesHint', 'Cadastre uma modalidade antes de abrir mesas')
                : undefined}
            >
              {t('cash.openTable', 'Abrir mesa')}
            </button>
          )}
        </div>

        {/* O caixa do operador é a mesma gaveta do torneio, ancorada no dia. */}
        {isOpen && <CashboxBanner cashDayId={cashDayId} onStateChange={setMyCashbox} />}

        {cashboxBlocked && (
          <div className="cf-warning" role="status">
            {t('cash.cashboxClosedHint', 'Abra o seu caixa antes de movimentar dinheiro.')}
          </div>
        )}

        {dayLoading ? (
          <SkeletonBlock />
        ) : !isOpen ? (
          <EmptyState
            icon={null}
            title={t('cash.noDayOpen', 'Nenhum dia de operação aberto')}
            subtitle={t(
              'cash.noDayOpenHint',
              'O cash game é medido por dia. Abra o dia para liberar as mesas — a data é a da NOITE: uma sessão que vira a meia-noite continua sendo o mesmo dia.',
            )}
            ctaLabel={t('cash.openDay', 'Abrir dia')}
            onCta={() => { setDayForm({ business_date: hojeLocal(), label: '' }); setOpenDayModal(true); }}
          />
        ) : (
          <>
            <div className="stats-grid">
              {loading ? (
                <>
                  <SkeletonStatCard /><SkeletonStatCard />
                  <SkeletonStatCard /><SkeletonStatCard />
                </>
              ) : (
                <>
                  {/* O rake vem PRIMEIRO e é o único rotulado como receita. */}
                  <div className="stat-card stat-card--highlight">
                    <span className="stat-label">{t('cash.revenue', 'Faturamento (rake)')}</span>
                    <span className="stat-value">{formatCurrency(summary?.revenue || 0)}</span>
                  </div>
                  <div className="stat-card">
                    <span className="stat-label">{t('cash.inPlay', 'Fichas na mesa')}</span>
                    <span className="stat-value">{formatCurrency(summary?.cash_in_play || 0)}</span>
                    <span className="stat-hint">
                      {t('cash.buyInsTurnover', 'Giro: {{value}}', {
                        value: formatCurrency(summary?.total_buy_ins || 0),
                      })}
                    </span>
                  </div>
                  <div className="stat-card">
                    <span className="stat-label">{t('cash.playersSeated', 'Jogadores sentados')}</span>
                    <span className="stat-value">{summary?.players_seated ?? 0}</span>
                    <span className="stat-hint">
                      {t('cash.tablesOpen', '{{count}} mesa(s) aberta(s)', {
                        count: summary?.tables_open ?? 0,
                      })}
                    </span>
                  </div>
                  <div className="stat-card">
                    <span className="stat-label">{t('cash.jackpotFund', 'Jackpot acumulado hoje')}</span>
                    <span className="stat-value">{formatCurrency(summary?.jackpot_collected || 0)}</span>
                    {/* Passivo, não receita: é dinheiro dos jogadores. */}
                    <span className="stat-hint">{t('cash.jackpotNotRevenue', 'Não é receita')}</span>
                  </div>
                </>
              )}
            </div>

            {loading ? (
              <SkeletonBlock />
            ) : abertas.length === 0 ? (
              <EmptyState
                icon={null}
                title={t('cash.noTables', 'Nenhuma mesa aberta')}
                subtitle={
                  gameTypes.length === 0
                    ? t('cash.noGameTypes', 'Cadastre uma modalidade (stakes, buy-in e rake) antes de abrir a primeira mesa.')
                    : t('cash.noTablesHint', 'Abra a primeira mesa para começar a sentar jogadores.')
                }
                ctaLabel={gameTypes.length === 0
                  ? t('cash.config', 'Modalidades')
                  : t('cash.openTable', 'Abrir mesa')}
                onCta={gameTypes.length === 0
                  ? () => navigate('/cash/configuracao')
                  : abrirModalDeMesa}
              />
            ) : (
              <div className="cf-tables">
                {abertas.map((mesa) => (
                  <Link key={mesa.id} to={`/cash/mesas/${mesa.id}`} className="cf-table">
                    <div className="cf-table-head">
                      <span className="cf-table-number">{mesa.table_number}</span>
                      <span className="cf-table-stakes">
                        {formatCurrency(mesa.small_blind)}/{formatCurrency(mesa.big_blind)}
                      </span>
                    </div>
                    <div className="cf-table-name">{mesa.game_type_name || mesa.game_variant}</div>
                    <div className="cf-seats" aria-hidden="true">
                      {Array.from({ length: mesa.seats }).map((_, i) => (
                        <span
                          key={i}
                          className={`cf-seat ${i < mesa.occupied_seats ? 'busy' : 'free'}`}
                        />
                      ))}
                    </div>
                    <div className="cf-table-foot">
                      <span>
                        {t('cash.seatsFree', '{{free}} de {{total}} livres', {
                          free: mesa.free_seats, total: mesa.seats,
                        })}
                      </span>
                      <span className="cf-table-rake">
                        {t('cash.rakeSoFar', 'Rake {{value}}', {
                          value: formatCurrency(mesa.rake_partial || 0),
                        })}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </>
        )}

        {openDayModal && (
          <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget && !submitting) setOpenDayModal(false); }}>
            <div className="modal" role="dialog" aria-modal="true" aria-label={t('cash.openDay', 'Abrir dia')}>
              <h2>{t('cash.openDay', 'Abrir dia')}</h2>
              <form onSubmit={abrirDia}>
                <div className="form-group">
                  <label htmlFor="cf-date">{t('cash.businessDate', 'Data da operação')}</label>
                  <input
                    id="cf-date"
                    type="date"
                    value={dayForm.business_date}
                    onChange={(e) => setDayForm({ ...dayForm, business_date: e.target.value })}
                    required
                  />
                  {/* O aviso é a regra inteira: sem ele alguém abre um dia novo
                      às 00h05 e parte o faturamento da mesma noite em dois. */}
                  <small className="form-hint">
                    {t('cash.businessDateHint', 'É a data da NOITE. Uma sessão que atravessa a meia-noite continua no mesmo dia.')}
                  </small>
                </div>
                <div className="form-group">
                  <label htmlFor="cf-label">{t('cash.dayLabel', 'Identificação (opcional)')}</label>
                  <input
                    id="cf-label"
                    type="text"
                    value={dayForm.label}
                    onChange={(e) => setDayForm({ ...dayForm, label: e.target.value })}
                    placeholder={t('cash.dayLabelPlaceholder', 'Ex.: Sexta do NLH')}
                  />
                </div>
                <div className="modal-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setOpenDayModal(false)} disabled={submitting}>
                    {t('common.cancel', 'Cancelar')}
                  </button>
                  <button type="submit" className="btn btn-primary" disabled={submitting}>
                    {submitting ? t('common.saving', 'Salvando...') : t('cash.openDay', 'Abrir dia')}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {openTableModal && (
          <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget && !submitting) setOpenTableModal(false); }}>
            <div className="modal" role="dialog" aria-modal="true" aria-label={t('cash.openTable', 'Abrir mesa')}>
              <h2>{t('cash.openTable', 'Abrir mesa')}</h2>
              <form onSubmit={abrirMesa}>
                <div className="form-group">
                  <label htmlFor="cf-type">{t('cash.gameType', 'Modalidade')}</label>
                  <select
                    id="cf-type"
                    value={tableForm.game_type_id}
                    onChange={(e) => setTableForm({ ...tableForm, game_type_id: e.target.value })}
                    required
                  >
                    {gameTypes.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name} — {formatCurrency(g.small_blind)}/{formatCurrency(g.big_blind)} ·{' '}
                        {t('cash.minMax', 'buy-in {{min}}–{{max}}', {
                          min: formatCurrency(g.min_buy_in),
                          max: g.max_buy_in ? formatCurrency(g.max_buy_in) : '∞',
                        })}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label htmlFor="cf-number">{t('cash.tableNumber', 'Número da mesa')}</label>
                  <input
                    id="cf-number"
                    type="number"
                    min="1"
                    value={tableForm.table_number}
                    onChange={(e) => setTableForm({ ...tableForm, table_number: e.target.value })}
                    required
                  />
                  <small className="form-hint">
                    {t('cash.tableNumberHint', 'É o número que está no salão — o operador leva as fichas por ele.')}
                  </small>
                </div>
                <div className="form-group">
                  <label htmlFor="cf-seats">{t('cash.seats', 'Lugares')}</label>
                  <input
                    id="cf-seats"
                    type="number"
                    min="2"
                    max="10"
                    value={tableForm.seats}
                    onChange={(e) => setTableForm({ ...tableForm, seats: e.target.value })}
                    placeholder={String(gameTypes.find((g) => g.id === tableForm.game_type_id)?.default_seats || 9)}
                  />
                </div>
                <div className="modal-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setOpenTableModal(false)} disabled={submitting}>
                    {t('common.cancel', 'Cancelar')}
                  </button>
                  <button type="submit" className="btn btn-primary" disabled={submitting}>
                    {submitting ? t('common.saving', 'Salvando...') : t('cash.openTable', 'Abrir mesa')}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default CashFloor;
