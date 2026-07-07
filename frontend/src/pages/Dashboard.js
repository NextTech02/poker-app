import React, { useEffect, useState } from 'react';
import { usePolling } from '../hooks/usePolling';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import api from '../config/api';
import { useCurrency } from '../contexts/CurrencyContext';
import { SkeletonStatCard, SkeletonActivityList } from '../components/SkeletonLoader';
import './Dashboard.css';

const DeltaBadge = ({ delta }) => {
  if (delta == null) return null;
  const positive = delta >= 0;
  return (
    <span className={`db-delta ${positive ? 'db-delta--up' : 'db-delta--down'}`}>
      {positive ? '↗' : '↘'} {Math.abs(delta)}%
    </span>
  );
};

const StatCard = ({ icon, value, label, delta, badge }) => (
  <div className="db-stat-card">
    <div className="db-stat-icon">{icon}</div>
    <div className="db-stat-info">
      <div className="db-stat-value-row">
        <div className="db-stat-value">{value}</div>
        {badge && <span className="db-stat-badge">{badge}</span>}
      </div>
      <div className="db-stat-label">{label}</div>
      {delta != null && <DeltaBadge delta={delta} />}
    </div>
  </div>
);

const Dashboard = () => {
  const { t } = useTranslation();
  const { formatCurrency } = useCurrency();
  const fmt = (n) => formatCurrency(n ?? 0);
  const [stats, setStats] = useState(null);
  const [recentTournaments, setRecentTournaments] = useState([]);
  const [recentTransactions, setRecentTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  // ISSUE-001 fix: track per-section error state so we don't show "Nenhum torneio
  // criado ainda" when the request actually failed with 503.
  const [tournamentsError, setTournamentsError] = useState(false);
  const [transactionsError, setTransactionsError] = useState(false);
  const retryRef = React.useRef(null);

  useEffect(() => {
    loadAll();
    return () => {
      if (retryRef.current) clearTimeout(retryRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Polling que pausa quando a aba está oculta (reduz carga em produção).
  usePolling(() => loadAll(), 30000);

  const loadAll = async (isRetry = false) => {
    // Track which sections succeeded / failed independently.
    const [statsResult, tourneysResult, txResult] = await Promise.allSettled([
      api.get('/dashboard/stats'),
      api.get('/tournaments'),
      api.get('/transactions'),
    ]);

    if (statsResult.status === 'fulfilled') {
      setStats(statsResult.value.data);
    }
    if (tourneysResult.status === 'fulfilled') {
      setRecentTournaments((tourneysResult.value.data || []).slice(0, 3));
      setTournamentsError(false);
    } else {
      setTournamentsError(true);
    }
    if (txResult.status === 'fulfilled') {
      setRecentTransactions((txResult.value.data || []).slice(0, 5));
      setTransactionsError(false);
    } else {
      setTransactionsError(true);
    }

    const anyFailed = [statsResult, tourneysResult, txResult].some(r => r.status === 'rejected');
    if (anyFailed && !isRetry) {
      retryRef.current = setTimeout(() => loadAll(true), 5000);
    }

    setLoading(false);
  };

  const renderActivityError = (onRetry) => (
    <div className="db-activity-empty">
      <p>{t('dashboard.loadError', 'Não foi possível carregar os dados. Tentando novamente...')}</p>
      <button type="button" className="db-activity-link" onClick={onRetry}>
        {t('dashboard.retry', 'Tentar novamente')}
      </button>
    </div>
  );

  const getTournamentStatusBadge = (status) => {
    const map = {
      active: { label: t('common.active', 'Ativo'), cls: 'db-status--active' },
      pending: { label: t('common.pending', 'Pendente'), cls: 'db-status--pending' },
      completed: { label: t('common.completed', 'Concluído'), cls: 'db-status--done' },
      cancelled: { label: t('common.cancelled', 'Cancelado'), cls: 'db-status--cancelled' },
    };
    const s = map[status] || map.pending;
    return <span className={`db-status ${s.cls}`}>{s.label}</span>;
  };

  const formatTxType = (type) => {
    const map = { buy_in: 'Buy-in', rebuy: 'Rebuy', addon: 'Add-on', payout: 'Payout' };
    return map[type] || type;
  };

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content">

        {/* ── Page header ── */}
        <div className="db-header">
          <div>
            <h1 className="db-title">{t('dashboard.title', 'Dashboard')}</h1>
            <p className="db-subtitle">{t('dashboard.subtitle', 'Visão geral do sistema')}</p>
          </div>
        </div>

        {/* ── KPI Cards ── */}
        <div className="db-kpi-grid">
          {loading ? (
            <>
              <SkeletonStatCard />
              <SkeletonStatCard />
              <SkeletonStatCard />
              <SkeletonStatCard />
            </>
          ) : (
            <>
              <StatCard
                icon={
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94.63 1.5 1.98 2.63 3.61 2.96V17H7v2h10v-2h-4v-1.1c1.63-.33 2.98-1.46 3.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2z"/>
                  </svg>
                }
                value={stats?.activeTournaments ?? 0}
                label={t('dashboard.activeTournaments', 'Torneios Ativos')}
              />
              <StatCard
                icon={
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
                  </svg>
                }
                value={stats?.totalPlayers ?? 0}
                label={t('dashboard.activePlayers', 'Jogadores Ativos')}
              />
              <StatCard
                icon={
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z"/>
                  </svg>
                }
                value={fmt(stats?.totalRevenue)}
                label={t('dashboard.totalRevenue', 'Receita Total')}
              />
              <StatCard
                icon={
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 3c1.93 0 3.5 1.57 3.5 3.5S13.93 13 12 13s-3.5-1.57-3.5-3.5S10.07 6 12 6zm7 13H5v-.23c0-.62.28-1.2.76-1.58C7.47 15.82 9.64 15 12 15s4.53.82 6.24 2.19c.48.38.76.97.76 1.58V19z"/>
                  </svg>
                }
                value={fmt(stats?.todayRevenue)}
                label={t('dashboard.todayRevenue', 'Receita Hoje')}
                badge={t('dashboard.todayBadge', 'Hoje')}
              />
            </>
          )}
        </div>

        {/* ── Activity panels ── */}
        <div className="db-activity-grid">

          {/* Recent tournaments */}
          <div className="db-activity-card">
            <div className="db-activity-header">
              <h3 className="db-activity-title">{t('dashboard.recentTournaments', 'Torneios Recentes')}</h3>
              <Link to="/torneios" className="db-activity-link">{t('dashboard.viewAll', 'Ver todos →')}</Link>
            </div>
            {loading ? (
              <SkeletonActivityList rows={3} />
            ) : tournamentsError ? (
              renderActivityError(() => loadAll())
            ) : recentTournaments.length === 0 ? (
              <p className="db-activity-empty">{t('dashboard.noTournamentsYet', 'Nenhum torneio criado ainda.')}</p>
            ) : (
              <ul className="db-activity-list">
                {recentTournaments.map((tournament) => (
                  <li key={tournament.id} className="db-activity-item">
                    <Link to={`/torneios/${tournament.id}`} className="db-activity-item-link">
                      <span className="db-activity-name">{tournament.name}</span>
                      {getTournamentStatusBadge(tournament.status)}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Recent transactions */}
          <div className="db-activity-card">
            <div className="db-activity-header">
              <h3 className="db-activity-title">{t('dashboard.recentTransactions', 'Transações Recentes')}</h3>
              <Link to="/caixa" className="db-activity-link">{t('dashboard.viewCash', 'Ver caixa →')}</Link>
            </div>
            {loading ? (
              <SkeletonActivityList rows={4} />
            ) : transactionsError ? (
              renderActivityError(() => loadAll())
            ) : recentTransactions.length === 0 ? (
              <p className="db-activity-empty">{t('dashboard.noTransactionsYet', 'Nenhuma transação registrada.')}</p>
            ) : (
              <ul className="db-activity-list">
                {recentTransactions.map((tx) => (
                  <li key={tx.id} className="db-activity-item">
                    <div className="db-activity-item-link">
                      <span className="db-activity-name">
                        {tx.player_name} — {formatTxType(tx.type)}
                      </span>
                      <span className="db-tx-amount">{fmt(tx.amount)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

        </div>

      </main>
    </div>
  );
};

export default Dashboard;
