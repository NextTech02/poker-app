import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import Breadcrumb from '../components/Breadcrumb';
import { SkeletonPlayersTable } from '../components/SkeletonLoader';
import PlayerStatsCharts from '../components/PlayerStatsCharts';
import PlayerLoyaltyCard from '../components/PlayerLoyaltyCard';
import PlayerSelect from '../components/PlayerSelect';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import './PlayerDetail.css';

const getInitials = (name = '') =>
  name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || '').join('');

const fmtPct = (v) => `${Math.round((Number(v) || 0) * 100)}%`;

const fmtHours = (v) => {
  const n = Number(v) || 0;
  if (n <= 0) return '0h';
  const hrs = Math.floor(n);
  const mins = Math.round((n - hrs) * 60);
  return mins ? `${hrs}h ${mins}m` : `${hrs}h`;
};

const fmtDate = (iso, locale) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString(locale, { day: '2-digit', month: 'short', year: 'numeric' });
  } catch {
    return '—';
  }
};

/**
 * Perfil / histórico de um jogador: métricas agregadas (view player_statistics)
 * + tabela de participações (endpoint /players/{id}/history). Org-scoped no
 * backend via RLS.
 */
const PlayerDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const { formatCurrency } = useCurrency();

  const [player, setPlayer] = useState(null);
  const [stats, setStats] = useState(null);
  const [history, setHistory] = useState([]);
  const [loyalty, setLoyalty] = useState(null);
  const [loyaltyEnabled, setLoyaltyEnabled] = useState(false);
  const [loyaltyBusy, setLoyaltyBusy] = useState(false);
  const [giftingCredit, setGiftingCredit] = useState(null); // crédito sendo presenteado
  const [giftTarget, setGiftTarget] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [pRes, sRes, hRes, cfgRes, loyRes] = await Promise.all([
        api.get(`/players/${id}`),
        api.get('/players/statistics', { params: { player_id: id } }),
        api.get(`/players/${id}/history`),
        api.get('/loyalty/config').catch(() => ({ data: { enabled: false } })),
        api.get(`/loyalty/players/${id}`).catch(() => ({ data: null })),
      ]);
      setPlayer(pRes.data);
      setStats((sRes.data && sRes.data[0]) || null);
      setHistory(hRes.data || []);
      setLoyaltyEnabled(!!cfgRes.data?.enabled);
      setLoyalty(loyRes.data);
    } catch (err) {
      toast.error(t('playerDetail.errorLoad', 'Erro ao carregar o histórico do jogador'));
    } finally {
      setLoading(false);
    }
  }, [id, toast, t]);

  useEffect(() => { load(); }, [load]);

  const reloadLoyalty = useCallback(async () => {
    try {
      const r = await api.get(`/loyalty/players/${id}`);
      setLoyalty(r.data);
    } catch { /* silencioso */ }
  }, [id]);

  const handleRedeem = async (rewardId) => {
    setLoyaltyBusy(true);
    try {
      await api.post(`/loyalty/players/${id}/redeem`, { reward_id: rewardId });
      toast.success(t('loyalty.redeemed', 'Recompensa resgatada! Crédito adicionado ao caixa do jogador.'));
      await reloadLoyalty();
    } catch (err) {
      toast.error(err.userMessage || t('loyalty.redeemError', 'Não foi possível resgatar.'));
    } finally {
      setLoyaltyBusy(false);
    }
  };

  const handleConvertCashback = async () => {
    setLoyaltyBusy(true);
    try {
      await api.post(`/loyalty/players/${id}/convert-cashback`);
      toast.success(t('loyalty.converted', 'Cashback convertido em crédito no caixa.'));
      await reloadLoyalty();
    } catch (err) {
      toast.error(err.userMessage || t('loyalty.convertError', 'Não foi possível converter o cashback.'));
    } finally {
      setLoyaltyBusy(false);
    }
  };

  const handleRedeemCoupon = async (code) => {
    setLoyaltyBusy(true);
    try {
      await api.post(`/loyalty/players/${id}/coupon`, { code });
      toast.success(t('loyalty.couponApplied', 'Cupom aplicado!'));
      await reloadLoyalty();
    } catch (err) {
      toast.error(err.userMessage || t('loyalty.couponError', 'Cupom inválido.'));
    } finally {
      setLoyaltyBusy(false);
    }
  };

  const handleClaimGoal = async (goalId) => {
    setLoyaltyBusy(true);
    try {
      await api.post(`/loyalty/players/${id}/goals/${goalId}/claim`);
      toast.success(t('loyalty.goalClaimed', 'Meta concluída! Pontos adicionados.'));
      await reloadLoyalty();
    } catch (err) {
      toast.error(err.userMessage || t('loyalty.goalError', 'Não foi possível resgatar a meta.'));
    } finally {
      setLoyaltyBusy(false);
    }
  };

  const confirmGift = async () => {
    if (!giftingCredit || !giftTarget) return;
    setLoyaltyBusy(true);
    try {
      await api.post(`/loyalty/players/${id}/gift`, {
        credit_id: giftingCredit.id, to_player_id: giftTarget,
      });
      toast.success(t('loyalty.gifted', 'Crédito presenteado!'));
      setGiftingCredit(null);
      setGiftTarget('');
      await reloadLoyalty();
    } catch (err) {
      toast.error(err.userMessage || t('loyalty.giftError', 'Não foi possível presentear.'));
    } finally {
      setLoyaltyBusy(false);
    }
  };

  const s = stats || {};
  const positive = (Number(s.net_profit) || 0) >= 0;

  const metricCards = [
    { key: 'tournaments', label: t('playerDetail.tournaments', 'Torneios'), value: s.tournaments_played ?? 0 },
    { key: 'entries', label: t('playerDetail.entries', 'Participações'), value: s.entries ?? 0 },
    { key: 'days', label: t('playerDetail.daysPlayed', 'Dias jogados'), value: s.days_played ?? 0 },
    { key: 'hours', label: t('playerDetail.hoursPlayed', 'Horas jogadas'), value: fmtHours(s.hours_played) },
    { key: 'finalTables', label: t('playerDetail.finalTables', 'Mesas finais'), value: s.final_tables ?? 0 },
    { key: 'top3', label: t('playerDetail.top3', 'Top 3'), value: s.top_3_finishes ?? 0 },
    { key: 'itm', label: t('playerDetail.itm', 'No dinheiro (ITM)'), value: s.itm_count ?? 0 },
    { key: 'rebuys', label: t('playerDetail.rebuys', 'Rebuys'), value: s.total_rebuys ?? 0 },
    { key: 'addons', label: t('playerDetail.addons', 'Add-ons'), value: s.total_addons ?? 0 },
  ];

  const rateCards = [
    { key: 'winRate', label: t('playerDetail.winRate', 'Taxa de vitória'), value: fmtPct(s.win_rate) },
    { key: 'itmRate', label: t('playerDetail.itmRate', 'Taxa ITM'), value: fmtPct(s.itm_rate) },
    { key: 'rebuyRate', label: t('playerDetail.rebuyRate', 'Rebuys/entrada'), value: (Number(s.rebuy_rate) || 0).toFixed(2) },
    { key: 'best', label: t('playerDetail.bestPosition', 'Melhor posição'), value: s.best_position != null ? `${s.best_position}º` : '—' },
    { key: 'avg', label: t('playerDetail.avgPosition', 'Posição média'), value: s.avg_position != null ? Number(s.avg_position).toFixed(1) : '—' },
    { key: 'roi', label: t('playerDetail.roi', 'ROI'), value: fmtPct(s.roi) },
  ];

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content">
        <Breadcrumb items={[
          { label: t('players.title'), to: '/jogadores' },
          { label: player?.name || t('playerDetail.title', 'Histórico do jogador') },
        ]} />

        {loading ? (
          <SkeletonPlayersTable rows={6} />
        ) : !player ? (
          <div className="pd-empty">
            <h3>{t('playerDetail.notFound', 'Jogador não encontrado')}</h3>
            <button className="pd-btn-back" onClick={() => navigate('/jogadores')}>
              {t('playerDetail.back', 'Voltar')}
            </button>
          </div>
        ) : (
          <>
            {/* ── Cabeçalho do jogador ── */}
            <div className="pd-header">
              <div className="pd-avatar">{getInitials(player.name)}</div>
              <div className="pd-header-info">
                <h1 className="pd-name">{player.name}</h1>
                <div className="pd-meta">
                  {player.nickname && <span className="pd-nick">@{player.nickname}</span>}
                  {player.nationality && <span className="pd-meta-item">{player.nationality}</span>}
                  <span className="pd-meta-item">
                    {t('playerDetail.since', 'Desde')} {fmtDate(s.first_played, i18n.language)}
                  </span>
                </div>
              </div>
            </div>

            {/* ── Destaques financeiros ── */}
            <div className="pd-finance">
              <div className="pd-finance-box">
                <span className="pd-finance-label">{t('playerDetail.totalSpent', 'Total investido')}</span>
                <span className="pd-finance-value">{formatCurrency(s.total_spent || 0)}</span>
              </div>
              <div className="pd-finance-box">
                <span className="pd-finance-label">{t('playerDetail.totalPrizes', 'Total em prêmios')}</span>
                <span className="pd-finance-value pd-positive">{formatCurrency(s.total_prizes || 0)}</span>
              </div>
              <div className="pd-finance-box">
                <span className="pd-finance-label">{t('playerDetail.netProfit', 'Lucro líquido')}</span>
                <span className={`pd-finance-value ${positive ? 'pd-positive' : 'pd-negative'}`}>
                  {formatCurrency(s.net_profit || 0)}
                </span>
              </div>
            </div>

            {/* ── Fidelidade (só PRO/PREMIUM) ── */}
            {loyaltyEnabled && (
              <PlayerLoyaltyCard
                data={loyalty}
                t={t}
                locale={i18n.language}
                formatCurrency={formatCurrency}
                onRedeem={handleRedeem}
                onConvertCashback={handleConvertCashback}
                onRedeemCoupon={handleRedeemCoupon}
                onClaimGoal={handleClaimGoal}
                onGiftCredit={(c) => { setGiftingCredit(c); setGiftTarget(''); }}
                birthDate={player?.birth_date}
                busy={loyaltyBusy}
              />
            )}

            {giftingCredit && (
              <div className="pd-gift-overlay" onClick={() => !loyaltyBusy && setGiftingCredit(null)}>
                <div className="pd-gift-modal" onClick={(e) => e.stopPropagation()}>
                  <h3>{t('loyalty.giftTitle', 'Presentear crédito')}</h3>
                  <p className="pd-gift-hint">
                    {t('loyalty.giftHint', 'Presenteie {{amount}} de crédito para outro jogador (ex.: um novo indicado).', {
                      amount: formatCurrency(giftingCredit.original_amount),
                    })}
                  </p>
                  <PlayerSelect
                    value={giftTarget}
                    name="gift_target"
                    onChange={(e) => setGiftTarget(e.target.value)}
                    excludeId={id}
                  />
                  <div className="pd-gift-actions">
                    <button className="pd-btn-back" onClick={() => setGiftingCredit(null)} disabled={loyaltyBusy}>
                      {t('common.cancel', 'Cancelar')}
                    </button>
                    <button className="plc-btn" onClick={confirmGift} disabled={loyaltyBusy || !giftTarget} type="button">
                      {t('loyalty.gift', 'Presentear')}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* ── Grade de métricas ── */}
            <div className="pd-grid">
              {[...metricCards, ...rateCards].map((c) => (
                <div className="pd-metric" key={c.key}>
                  <span className="pd-metric-value">{c.value}</span>
                  <span className="pd-metric-label">{c.label}</span>
                </div>
              ))}
            </div>

            {/* ── Gráficos: evolução do lucro + resultado por torneio ── */}
            <PlayerStatsCharts
              history={history}
              formatCurrency={formatCurrency}
              locale={i18n.language}
              labels={{
                evolution: t('playerDetail.chartEvolution', 'Evolução do lucro acumulado'),
                perTournament: t('playerDetail.chartPerTournament', 'Resultado por torneio'),
              }}
            />

            {/* ── Histórico por torneio ── */}
            <div className="pd-history-card">
              <div className="pd-history-header">
                <h2>{t('playerDetail.historyTitle', 'Histórico de participações')}</h2>
                <span className="pd-history-count">{history.length}</span>
              </div>
              {history.length === 0 ? (
                <p className="pd-history-empty">{t('playerDetail.noHistory', 'Nenhuma participação registrada.')}</p>
              ) : (
                <div className="pd-table-wrap">
                  <table className="pd-table">
                    <thead>
                      <tr>
                        <th>{t('playerDetail.colTournament', 'Torneio')}</th>
                        <th>{t('playerDetail.colDate', 'Data')}</th>
                        <th className="pd-num">{t('playerDetail.colRebuys', 'Rebuys')}</th>
                        <th className="pd-num">{t('playerDetail.colAddons', 'Add-ons')}</th>
                        <th className="pd-num">{t('playerDetail.colSpent', 'Investido')}</th>
                        <th className="pd-num">{t('playerDetail.colPosition', 'Posição')}</th>
                        <th className="pd-num">{t('playerDetail.colPrize', 'Prêmio')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.map((h) => (
                        <tr key={h.tournament_player_id}>
                          <td data-label={t('playerDetail.colTournament', 'Torneio')}>
                            <div className="pd-t-cell">
                              <span className="pd-t-name">{h.tournament_name || '—'}</span>
                              {h.day_name && <span className="pd-t-day">{h.day_name}</span>}
                            </div>
                          </td>
                          <td data-label={t('playerDetail.colDate', 'Data')}>{fmtDate(h.registered_at, i18n.language)}</td>
                          <td className="pd-num" data-label={t('playerDetail.colRebuys', 'Rebuys')}>{h.rebuy_count}</td>
                          <td className="pd-num" data-label={t('playerDetail.colAddons', 'Add-ons')}>{h.addon_count}</td>
                          <td className="pd-num" data-label={t('playerDetail.colSpent', 'Investido')}>{formatCurrency(h.total_spent || 0)}</td>
                          <td className="pd-num" data-label={t('playerDetail.colPosition', 'Posição')}>
                            {h.final_position != null ? `${h.final_position}º` : '—'}
                          </td>
                          <td className="pd-num" data-label={t('playerDetail.colPrize', 'Prêmio')}>
                            {h.prize_won > 0
                              ? <span className="pd-positive">{formatCurrency(h.prize_won)}</span>
                              : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
};

export default PlayerDetail;
