import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import EmptyState from '../components/EmptyState';
import { SkeletonStatCard } from '../components/SkeletonLoader';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import './Relatorios.css';

const Relatorios = () => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { formatCurrency } = useCurrency();
  // A4 + B: formatação de moeda consistente com a configuração global de moeda
  const fmt = (n) => formatCurrency(n ?? 0);
  const [reports, setReports] = useState({
    totalRevenue: 0,
    totalTournaments: 0,
    totalPlayers: 0,
    avgBuyIn: 0,
    totalBuyIns: 0,
    totalRebuys: 0,
    totalAddons: 0,
    playerReports: [],
  });
  const [loading, setLoading] = useState(true);
  const [dateRange, setDateRange] = useState({
    start: new Date(new Date().setDate(1)).toISOString().split('T')[0],
    end: new Date().toISOString().split('T')[0],
  });

  useEffect(() => {
    loadReports();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateRange]);

  const loadReports = async () => {
    setLoading(true);
    try {
      const response = await api.get('/reports', { params: dateRange });
      setReports(response.data);
    } catch (error) {
      // B5: toast de erro em vez de console.error silencioso
      const msg = error.userMessage || t('reports.loadingError', 'Erro ao carregar relatórios. Verifique a conexão e tente novamente.');
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleDateChange = (e) => {
    setDateRange({ ...dateRange, [e.target.name]: e.target.value });
  };

  const rebuyRate = ((reports.totalRebuys + reports.totalAddons) / (reports.totalBuyIns || 1) * 100).toFixed(1);

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">

        {/* B1: Header padrão com ícone + título + subtítulo */}
        <div className="rl-header">
          <div className="rl-header-left">
            <div className="rl-header-icon">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 3c1.93 0 3.5 1.57 3.5 3.5S13.93 13 12 13s-3.5-1.57-3.5-3.5S10.07 6 12 6zm7 13H5v-.23c0-.62.28-1.2.76-1.58C7.47 15.82 9.64 15 12 15s4.53.82 6.24 2.19c.48.38.76.97.76 1.58V19z"/>
              </svg>
            </div>
            <div>
              <h1 className="rl-title">{t('reports.title', 'Relatórios')}</h1>
              <p className="rl-subtitle">{t('reports.subtitle', 'Análise de desempenho e estatísticas')}</p>
            </div>
          </div>
        </div>

        {/* Filtro de período */}
        <Card title={t('reports.period', 'Período')}>
          <div className="date-range">
            <div className="form-group">
              <label htmlFor="start">{t('reports.from', 'Data Inicial')}</label>
              <input
                id="start"
                name="start"
                type="date"
                value={dateRange.start}
                onChange={handleDateChange}
              />
            </div>
            <div className="form-group">
              <label htmlFor="end">{t('reports.to', 'Data Final')}</label>
              <input
                id="end"
                name="end"
                type="date"
                value={dateRange.end}
                onChange={handleDateChange}
              />
            </div>
          </div>
        </Card>

        {/* B2: Skeleton durante carregamento */}
        {loading ? (
          <>
            <h2 className="section-title">{t('reports.generalMetrics', 'Métricas Gerais')}</h2>
            <div className="stats-grid">
              <SkeletonStatCard />
              <SkeletonStatCard />
              <SkeletonStatCard />
              <SkeletonStatCard />
            </div>
            <h2 className="section-title">{t('reports.transactionBreakdown', 'Detalhamento de Transações')}</h2>
            <div className="stats-grid">
              <SkeletonStatCard />
              <SkeletonStatCard />
              <SkeletonStatCard />
              <SkeletonStatCard />
            </div>
          </>
        ) : (
          <>
            {/* B3: i18n em todas as seções */}
            <h2 className="section-title">{t('reports.generalMetrics', 'Métricas Gerais')}</h2>
            <div className="stats-grid">
              <Card className="stat-card">
                <div className="rl-kpi-icon">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z"/></svg>
                </div>
                <div className="stat-info">
                  <h3 className="rl-accent">{fmt(reports.totalRevenue)}</h3>
                  <p>{t('reports.totalRevenue', 'Receita Total')}</p>
                </div>
              </Card>

              <Card className="stat-card">
                <div className="rl-kpi-icon">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94.63 1.5 1.98 2.63 3.61 2.96V17H7v2h10v-2h-4v-1.1c1.63-.33 2.98-1.46 3.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2z"/></svg>
                </div>
                <div className="stat-info">
                  <h3>{reports.totalTournaments}</h3>
                  <p>{t('reports.totalTournaments', 'Total de Torneios')}</p>
                </div>
              </Card>

              <Card className="stat-card">
                <div className="rl-kpi-icon">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
                </div>
                <div className="stat-info">
                  <h3>{reports.totalPlayers}</h3>
                  <p>{t('reports.totalEntries', 'Total de Entradas')}</p>
                </div>
              </Card>

              <Card className="stat-card">
                <div className="rl-kpi-icon">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-4H9l3-7 3 7h-2v4z"/></svg>
                </div>
                <div className="stat-info">
                  <h3 className="rl-accent">{fmt(reports.avgBuyIn)}</h3>
                  <p>{t('reports.avgTicket', 'Ticket Médio')}</p>
                </div>
              </Card>
            </div>

            <h2 className="section-title">{t('reports.transactionBreakdown', 'Detalhamento de Transações')}</h2>
            <div className="stats-grid">
              <Card className="stat-card">
                <div className="rl-kpi-icon">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-7 13H4v-2h9v2zm0-4H4v-2h9v2zm7 4h-5v-6h5v6z"/></svg>
                </div>
                <div className="stat-info">
                  <h3>{reports.totalBuyIns}</h3>
                  <p>{t('cashRegister.totalBuyIns', 'Total Buy-ins')}</p>
                </div>
              </Card>

              <Card className="stat-card">
                <div className="rl-kpi-icon">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-2 10h-4v4h-2v-4H7v-2h4V7h2v4h4v2z"/></svg>
                </div>
                <div className="stat-info">
                  <h3>{reports.totalRebuys}</h3>
                  <p>{t('cashRegister.totalRebuys', 'Total Rebuys')}</p>
                </div>
              </Card>

              <Card className="stat-card">
                <div className="rl-kpi-icon">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M17 12h-5v5h5v-5zM16 1v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-1V1h-2zm3 18H5V8h14v11z"/></svg>
                </div>
                <div className="stat-info">
                  <h3>{reports.totalAddons}</h3>
                  <p>{t('cashRegister.totalAddons', 'Total Add-ons')}</p>
                </div>
              </Card>

              <Card className="stat-card">
                <div className="rl-kpi-icon">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 6l2.29 2.29-4.88 4.88-4-4L2 16.59 3.41 18l6-6 4 4 6.3-6.29L22 12V6z"/></svg>
                </div>
                <div className="stat-info">
                  <h3>{rebuyRate}%</h3>
                  <p>{t('reports.rebuyRate', 'Taxa de Rebuy/Add-on')}</p>
                </div>
              </Card>
            </div>

            {/* B4: EmptyState padronizado */}
            <Card title={t('reports.playerReport', 'Relatório de Jogadores')}>
              {reports.playerReports && reports.playerReports.length > 0 ? (
                <div className="table-container">
                  <table className="reports-table">
                    <thead>
                      <tr>
                        <th>{t('players.columnPlayer', 'Jogador')}</th>
                        <th>{t('reports.totalEntries', 'Entradas')}</th>
                        <th>Buy-ins</th>
                        <th>Rebuys</th>
                        <th>Add-ons</th>
                        <th>{t('cashRegister.totalGeneral', 'Total Gasto')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reports.playerReports.map((player, index) => (
                        <tr key={index}>
                          <td className="player-name">{player.player_name}</td>
                          <td>{player.total_entries}</td>
                          <td>{player.buy_ins}</td>
                          <td>{player.rebuys}</td>
                          <td>{player.addons}</td>
                          <td className="amount">{fmt(player.total_spent)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyState
                  icon={null}
                  title={t('reports.noPlayerData', 'Nenhum dado de jogador disponível')}
                  subtitle={t('reports.noPlayerDataHint', 'Tente selecionar um período diferente.')}
                />
              )}
            </Card>

            <div className="kpi-grid">
              <Card title={t('reports.top5Players', 'Top 5 Jogadores por Gastos')}>
                <div className="ranking-list">
                  {reports.playerReports && reports.playerReports.length > 0 ? (
                    [...reports.playerReports]
                      .sort((a, b) => b.total_spent - a.total_spent)
                      .slice(0, 5)
                      .map((player, index) => (
                        <div key={index} className="ranking-item">
                          <div className="ranking-position">{index + 1}</div>
                          <div className="ranking-name">{player.player_name}</div>
                          <div className="ranking-value">{fmt(player.total_spent)}</div>
                        </div>
                      ))
                  ) : (
                    <p className="empty-ranking">{t('reports.noDataAvailable', 'Sem dados disponíveis')}</p>
                  )}
                </div>
              </Card>

              <Card title={t('reports.engagementMetrics', 'Métricas de Engajamento')}>
                <div className="engagement-metrics">
                  <div className="metric-item">
                    <span className="metric-label">{t('reports.avgEntriesPerPlayer', 'Média de Entradas por Jogador')}</span>
                    <span className="metric-value">
                      {(reports.totalPlayers / (reports.playerReports?.length || 1)).toFixed(2)}
                    </span>
                  </div>
                  <div className="metric-item">
                    <span className="metric-label">{t('reports.uniquePlayers', 'Jogadores Únicos')}</span>
                    <span className="metric-value">{reports.playerReports?.length || 0}</span>
                  </div>
                  <div className="metric-item">
                    <span className="metric-label">{t('reports.revenuePerTournament', 'Receita por Torneio')}</span>
                    <span className="metric-value">
                      {fmt(reports.totalRevenue / (reports.totalTournaments || 1))}
                    </span>
                  </div>
                  <div className="metric-item">
                    <span className="metric-label">{t('reports.playersPerTournament', 'Jogadores por Torneio')}</span>
                    <span className="metric-value">
                      {(reports.totalPlayers / (reports.totalTournaments || 1)).toFixed(1)}
                    </span>
                  </div>
                </div>
              </Card>
            </div>
          </>
        )}
      </main>
    </div>
  );
};

export default Relatorios;
