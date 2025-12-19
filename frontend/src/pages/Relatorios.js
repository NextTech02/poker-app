import React, { useEffect, useState } from 'react';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import api from '../config/api';
import './Relatorios.css';

const Relatorios = () => {
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
    try {
      const response = await api.get('/reports', {
        params: dateRange,
      });
      setReports(response.data);
    } catch (error) {
      console.error('Erro ao carregar relatórios:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleDateChange = (e) => {
    setDateRange({
      ...dateRange,
      [e.target.name]: e.target.value,
    });
  };

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div>
            <h1>Relatórios</h1>
            <p className="subtitle">Análise de desempenho e estatísticas</p>
          </div>
        </div>

        <Card title="Período">
          <div className="date-range">
            <div className="form-group">
              <label htmlFor="start">Data Inicial</label>
              <input
                id="start"
                name="start"
                type="date"
                value={dateRange.start}
                onChange={handleDateChange}
              />
            </div>
            <div className="form-group">
              <label htmlFor="end">Data Final</label>
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

        {loading ? (
          <div className="loading">Carregando relatórios...</div>
        ) : (
          <>
            <h2 className="section-title">Métricas Gerais</h2>
            <div className="stats-grid">
              <Card className="stat-card">
                <div className="stat-icon"></div>
                <div className="stat-info">
                  <h3>R$ {reports.totalRevenue.toFixed(2)}</h3>
                  <p>Receita Total</p>
                </div>
              </Card>

              <Card className="stat-card">
                <div className="stat-icon"></div>
                <div className="stat-info">
                  <h3>{reports.totalTournaments}</h3>
                  <p>Total de Torneios</p>
                </div>
              </Card>

              <Card className="stat-card">
                <div className="stat-icon"></div>
                <div className="stat-info">
                  <h3>{reports.totalPlayers}</h3>
                  <p>Total de Entradas</p>
                </div>
              </Card>

              <Card className="stat-card">
                <div className="stat-icon"></div>
                <div className="stat-info">
                  <h3>R$ {reports.avgBuyIn.toFixed(2)}</h3>
                  <p>Ticket Médio</p>
                </div>
              </Card>
            </div>

            <h2 className="section-title">Detalhamento de Transações</h2>
            <div className="stats-grid">
              <Card className="stat-card">
                <div className="stat-icon"></div>
                <div className="stat-info">
                  <h3>{reports.totalBuyIns}</h3>
                  <p>Total Buy-ins</p>
                </div>
              </Card>

              <Card className="stat-card">
                <div className="stat-icon"></div>
                <div className="stat-info">
                  <h3>{reports.totalRebuys}</h3>
                  <p>Total Rebuys</p>
                </div>
              </Card>

              <Card className="stat-card">
                <div className="stat-icon"></div>
                <div className="stat-info">
                  <h3>{reports.totalAddons}</h3>
                  <p>Total Add-ons</p>
                </div>
              </Card>

              <Card className="stat-card">
                <div className="stat-icon"></div>
                <div className="stat-info">
                  <h3>{((reports.totalRebuys + reports.totalAddons) / reports.totalBuyIns * 100 || 0).toFixed(1)}%</h3>
                  <p>Taxa de Rebuy/Add-on</p>
                </div>
              </Card>
            </div>

            <Card title="Relatório de Jogadores">
              {reports.playerReports && reports.playerReports.length > 0 ? (
                <div className="table-container">
                  <table className="reports-table">
                    <thead>
                      <tr>
                        <th>Jogador</th>
                        <th>Entradas</th>
                        <th>Buy-ins</th>
                        <th>Rebuys</th>
                        <th>Add-ons</th>
                        <th>Total Gasto</th>
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
                          <td className="amount">R$ {parseFloat(player.total_spent).toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="empty-state">
                  <p>Nenhum dado de jogador disponível para o período selecionado</p>
                </div>
              )}
            </Card>

            <div className="kpi-grid">
              <Card title="Top 5 Jogadores por Gastos">
                <div className="ranking-list">
                  {reports.playerReports
                    .sort((a, b) => b.total_spent - a.total_spent)
                    .slice(0, 5)
                    .map((player, index) => (
                      <div key={index} className="ranking-item">
                        <div className="ranking-position">{index + 1}</div>
                        <div className="ranking-name">{player.player_name}</div>
                        <div className="ranking-value">R$ {parseFloat(player.total_spent).toFixed(2)}</div>
                      </div>
                    ))}
                  {(!reports.playerReports || reports.playerReports.length === 0) && (
                    <p className="empty-ranking">Sem dados disponíveis</p>
                  )}
                </div>
              </Card>

              <Card title="Métricas de Engajamento">
                <div className="engagement-metrics">
                  <div className="metric-item">
                    <span className="metric-label">Média de Entradas por Jogador</span>
                    <span className="metric-value">
                      {(reports.totalPlayers / (reports.playerReports?.length || 1)).toFixed(2)}
                    </span>
                  </div>
                  <div className="metric-item">
                    <span className="metric-label">Jogadores Únicos</span>
                    <span className="metric-value">{reports.playerReports?.length || 0}</span>
                  </div>
                  <div className="metric-item">
                    <span className="metric-label">Receita por Torneio</span>
                    <span className="metric-value">
                      R$ {(reports.totalRevenue / (reports.totalTournaments || 1)).toFixed(2)}
                    </span>
                  </div>
                  <div className="metric-item">
                    <span className="metric-label">Jogadores por Torneio</span>
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
