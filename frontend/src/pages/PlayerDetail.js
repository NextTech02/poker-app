import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import Breadcrumb from '../components/Breadcrumb';
import { SkeletonPlayersTable } from '../components/SkeletonLoader';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import './PlayerDetail.css';

const getInitials = (name = '') =>
  name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || '').join('');

const fmtPct = (v) => `${Math.round((Number(v) || 0) * 100)}%`;

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
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [pRes, sRes, hRes] = await Promise.all([
        api.get(`/players/${id}`),
        api.get('/players/statistics', { params: { player_id: id } }),
        api.get(`/players/${id}/history`),
      ]);
      setPlayer(pRes.data);
      setStats((sRes.data && sRes.data[0]) || null);
      setHistory(hRes.data || []);
    } catch (err) {
      toast.error(t('playerDetail.errorLoad', 'Erro ao carregar o histórico do jogador'));
    } finally {
      setLoading(false);
    }
  }, [id, toast, t]);

  useEffect(() => { load(); }, [load]);

  const s = stats || {};
  const positive = (Number(s.net_profit) || 0) >= 0;

  const metricCards = [
    { key: 'tournaments', label: t('playerDetail.tournaments', 'Torneios'), value: s.tournaments_played ?? 0 },
    { key: 'entries', label: t('playerDetail.entries', 'Participações'), value: s.entries ?? 0 },
    { key: 'days', label: t('playerDetail.daysPlayed', 'Dias jogados'), value: s.days_played ?? 0 },
    { key: 'rebuys', label: t('playerDetail.rebuys', 'Rebuys'), value: s.total_rebuys ?? 0 },
    { key: 'addons', label: t('playerDetail.addons', 'Add-ons'), value: s.total_addons ?? 0 },
    { key: 'itm', label: t('playerDetail.itm', 'No dinheiro (ITM)'), value: s.itm_count ?? 0 },
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

            {/* ── Grade de métricas ── */}
            <div className="pd-grid">
              {[...metricCards, ...rateCards].map((c) => (
                <div className="pd-metric" key={c.key}>
                  <span className="pd-metric-value">{c.value}</span>
                  <span className="pd-metric-label">{c.label}</span>
                </div>
              ))}
            </div>

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
