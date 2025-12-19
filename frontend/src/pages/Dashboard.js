import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import api from '../config/api';
import './Dashboard.css';

const Dashboard = () => {
  const [stats, setStats] = useState({
    activeTournaments: 0,
    totalPlayers: 0,
    totalRevenue: 0,
    todayRevenue: 0,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadStats();

    // Setup polling (every 10 seconds)
    const pollingInterval = setInterval(() => {
      loadStats();
    }, 10000);

    return () => {
      clearInterval(pollingInterval);
    };
  }, []);

  const loadStats = async () => {
    try {
      const response = await api.get('/dashboard/stats');
      setStats(response.data);
    } catch (error) {
      console.error('Erro ao carregar estatísticas:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="app-container">
        <Sidebar />
        <main className="main-content">
          <div className="loading">Carregando...</div>
        </main>
      </div>
    );
  }

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        <div className="dashboard-header">
          <h1>Dashboard</h1>
          <p className="subtitle">Visão geral do sistema</p>
        </div>

        <div className="stats-grid">
          <Card className="stat-card">
            <div className="stat-icon"></div>
            <div className="stat-info">
              <h3>{stats.activeTournaments}</h3>
              <p>Torneios Ativos</p>
            </div>
          </Card>

          <Card className="stat-card">
            <div className="stat-icon"></div>
            <div className="stat-info">
              <h3>{stats.totalPlayers}</h3>
              <p>Jogadores Ativos</p>
            </div>
          </Card>

          <Card className="stat-card">
            <div className="stat-icon"></div>
            <div className="stat-info">
              <h3>R$ {stats.totalRevenue.toFixed(2)}</h3>
              <p>Receita Total</p>
            </div>
          </Card>

          <Card className="stat-card">
            <div className="stat-icon"></div>
            <div className="stat-info">
              <h3>R$ {stats.todayRevenue.toFixed(2)}</h3>
              <p>Receita Hoje</p>
            </div>
          </Card>
        </div>

        <div className="quick-actions">
          <Card title="Ações Rápidas">
            <div className="action-buttons">
              <Link to="/torneios" className="action-btn">
                <span className="action-icon"></span>
                <span>Novo Torneio</span>
              </Link>
              <Link to="/caixa" className="action-btn">
                <span className="action-icon"></span>
                <span>Registrar Transação</span>
              </Link>
              <Link to="/relatorios" className="action-btn">
                <span className="action-icon"></span>
                <span>Ver Relatórios</span>
              </Link>
            </div>
          </Card>
        </div>
      </main>
    </div>
  );
};

export default Dashboard;
