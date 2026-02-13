import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import api from '../config/api';
import './Dashboard.css';

const Dashboard = () => {
  const { t } = useTranslation();
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
      console.error('Error loading stats:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="app-container">
        <Sidebar />
        <main className="main-content">
          <div className="loading">{t('common.loading')}</div>
        </main>
      </div>
    );
  }

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        <div className="stats-grid">
          <Card className="stat-card">
            <div className="stat-icon"></div>
            <div className="stat-info">
              <h3>{stats.activeTournaments}</h3>
              <p>{t('dashboard.activeTournaments')}</p>
            </div>
          </Card>

          <Card className="stat-card">
            <div className="stat-icon"></div>
            <div className="stat-info">
              <h3>{stats.totalPlayers}</h3>
              <p>{t('dashboard.activePlayers')}</p>
            </div>
          </Card>

          <Card className="stat-card">
            <div className="stat-icon"></div>
            <div className="stat-info">
              <h3>R$ {stats.totalRevenue.toFixed(2)}</h3>
              <p>{t('dashboard.totalRevenue')}</p>
            </div>
          </Card>

          <Card className="stat-card">
            <div className="stat-icon"></div>
            <div className="stat-info">
              <h3>R$ {stats.todayRevenue.toFixed(2)}</h3>
              <p>{t('dashboard.todayRevenue')}</p>
            </div>
          </Card>
        </div>

        <div className="quick-actions">
          <h2>{t('dashboard.quickActions')}</h2>
          <div className="action-buttons">
            <Link to="/torneios" className="action-btn">
              <span>{t('dashboard.newTournament')}</span>
              <div className="action-arrow"></div>
            </Link>
            <Link to="/caixa" className="action-btn">
              <span>{t('dashboard.registerTransaction')}</span>
              <div className="action-arrow"></div>
            </Link>
            <Link to="/relatorios" className="action-btn">
              <span>{t('dashboard.viewReports')}</span>
              <div className="action-arrow"></div>
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
};

export default Dashboard;
