import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import Button from '../components/Button';
import api from '../config/api';
import { useCurrency } from '../contexts/CurrencyContext';
import './TournamentDayStats.css';

const TournamentDayStats = () => {
  const { dayId } = useParams();
  const navigate = useNavigate();
  const { formatCurrency } = useCurrency();

  const [day, setDay] = useState(null);
  const [tournament, setTournament] = useState(null);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadStats();
  }, [dayId]);

  const loadStats = async () => {
    try {
      setLoading(true);

      // Load day info
      const dayRes = await api.get(`/tournament-days/${dayId}`);
      const dayData = dayRes.data;
      setDay(dayData);

      // Load tournament info
      const tournamentRes = await api.get(`/tournaments/${dayData.tournament_id}`);
      setTournament(tournamentRes.data);

      // Load stats based on day type
      if (dayData.day_type === 'final') {
        const statsRes = await api.get(`/tournament-days/${dayId}/aggregated-stats`);
        setStats({ ...statsRes.data, isFinalDay: true });
      } else {
        const statsRes = await api.get(`/tournament-days/${dayId}/stats`);
        setStats({ ...statsRes.data, isFinalDay: false });
      }
    } catch (err) {
      console.error('Error loading stats:', err);
      setError('Erro ao carregar estatísticas');
    } finally {
      setLoading(false);
    }
  };

  const handleBack = () => {
    if (tournament) {
      navigate(`/torneios/${tournament.id}`);
    } else {
      navigate(-1);
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

  if (error) {
    return (
      <div className="app-container">
        <Sidebar />
        <main className="main-content">
          <div className="error-message">{error}</div>
          <Button onClick={handleBack}>Voltar</Button>
        </main>
      </div>
    );
  }

  const isFinalDay = stats?.isFinalDay;

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div>
            <h1>
              {isFinalDay ? 'Estatísticas Agregadas' : 'Estatísticas do Dia'}
            </h1>
            <p className="subtitle">
              {tournament?.name} - {day?.day_name}
            </p>
          </div>
          <Button variant="secondary" onClick={handleBack}>
            Voltar
          </Button>
        </div>

        {/* Day Type Badge */}
        <div className="day-type-badges">
          {day?.day_type === 'qualifying' && (
            <span className="day-type-badge qualifying">Dia Classificatório</span>
          )}
          {day?.day_type === 'final' && (
            <span className="day-type-badge final">Dia Final</span>
          )}
          {day?.day_type === 'regular' && (
            <span className="day-type-badge regular">Dia Regular</span>
          )}
          <span className={`status-badge ${day?.status}`}>
            {day?.status === 'pending' && 'Pendente'}
            {day?.status === 'active' && 'Em Andamento'}
            {day?.status === 'completed' && 'Concluído'}
            {day?.status === 'cancelled' && 'Cancelado'}
          </span>
        </div>

        {isFinalDay ? (
          // Final Day Aggregated Stats View
          <>
            {/* Combined Totals */}
            <Card className="stats-card">
              <h2 className="stats-card-title">Totais Combinados</h2>
              <div className="stats-grid large">
                <div className="stat-box highlight">
                  <span className="stat-box-label">Prize Pool Total</span>
                  <span className="stat-box-value">{formatCurrency(stats.combined_prize_pool || 0)}</span>
                </div>
                <div className="stat-box highlight">
                  <span className="stat-box-label">Total Arrecadado</span>
                  <span className="stat-box-value">{formatCurrency(stats.combined_total_collected || 0)}</span>
                </div>
                <div className="stat-box">
                  <span className="stat-box-label">Jogadores no Final</span>
                  <span className="stat-box-value">{stats.total_players || 0}</span>
                </div>
                <div className="stat-box">
                  <span className="stat-box-label">Classificados</span>
                  <span className="stat-box-value">{stats.total_qualified_players || 0}</span>
                </div>
                <div className="stat-box">
                  <span className="stat-box-label">Buy-ins Diretos</span>
                  <span className="stat-box-value">{stats.direct_buy_in_players || 0}</span>
                </div>
              </div>
            </Card>

            {/* Qualifying Days Breakdown */}
            {stats.qualifying_days && stats.qualifying_days.length > 0 && (
              <Card className="stats-card">
                <h2 className="stats-card-title">
                  Dias Classificatórios ({stats.qualifying_days.length})
                </h2>
                <div className="qualifying-days-list">
                  {stats.qualifying_days.map((qDay, index) => (
                    <div key={qDay.day_id || index} className="qualifying-day-card">
                      <h3 className="qualifying-day-name">{qDay.day_name}</h3>
                      <div className="stats-grid compact">
                        <div className="stat-box small">
                          <span className="stat-box-label">Jogadores</span>
                          <span className="stat-box-value">{qDay.total_players || 0}</span>
                        </div>
                        <div className="stat-box small">
                          <span className="stat-box-label">Eliminados</span>
                          <span className="stat-box-value">{qDay.eliminated_players || 0}</span>
                        </div>
                        <div className="stat-box small">
                          <span className="stat-box-label">Classificados</span>
                          <span className="stat-box-value">{qDay.qualified_players || 0}</span>
                        </div>
                        <div className="stat-box small">
                          <span className="stat-box-label">Buy-ins</span>
                          <span className="stat-box-value">{qDay.total_buy_ins || 0}</span>
                        </div>
                        <div className="stat-box small">
                          <span className="stat-box-label">Rebuys</span>
                          <span className="stat-box-value">{qDay.total_rebuys || 0}</span>
                        </div>
                        <div className="stat-box small">
                          <span className="stat-box-label">Add-ons</span>
                          <span className="stat-box-value">{qDay.total_addons || 0}</span>
                        </div>
                        <div className="stat-box small">
                          <span className="stat-box-label">Total Entradas</span>
                          <span className="stat-box-value">{qDay.total_entries || 0}</span>
                        </div>
                        <div className="stat-box small">
                          <span className="stat-box-label">Valor Buy-ins</span>
                          <span className="stat-box-value">{formatCurrency(qDay.buy_in_amount || 0)}</span>
                        </div>
                        <div className="stat-box small">
                          <span className="stat-box-label">Valor Rebuys</span>
                          <span className="stat-box-value">{formatCurrency(qDay.rebuy_amount || 0)}</span>
                        </div>
                        <div className="stat-box small">
                          <span className="stat-box-label">Valor Add-ons</span>
                          <span className="stat-box-value">{formatCurrency(qDay.addon_amount || 0)}</span>
                        </div>
                        <div className="stat-box small highlight-blue">
                          <span className="stat-box-label">Total Arrecadado</span>
                          <span className="stat-box-value">{formatCurrency(qDay.total_collected || 0)}</span>
                        </div>
                        <div className="stat-box small highlight-blue">
                          <span className="stat-box-label">Prize Pool</span>
                          <span className="stat-box-value">{formatCurrency(qDay.prize_pool || 0)}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {/* Aggregated Totals from all Qualifying Days */}
            {stats.qualifying_days && stats.qualifying_days.length > 1 && (
              <Card className="stats-card">
                <h2 className="stats-card-title">Soma dos Dias Classificatórios</h2>
                <div className="stats-grid">
                  <div className="stat-box">
                    <span className="stat-box-label">Total Buy-ins</span>
                    <span className="stat-box-value">{stats.total_qualifying_buy_ins || 0}</span>
                  </div>
                  <div className="stat-box">
                    <span className="stat-box-label">Total Rebuys</span>
                    <span className="stat-box-value">{stats.total_qualifying_rebuys || 0}</span>
                  </div>
                  <div className="stat-box">
                    <span className="stat-box-label">Total Add-ons</span>
                    <span className="stat-box-value">{stats.total_qualifying_addons || 0}</span>
                  </div>
                  <div className="stat-box">
                    <span className="stat-box-label">Total Entradas</span>
                    <span className="stat-box-value">{stats.total_qualifying_entries || 0}</span>
                  </div>
                  <div className="stat-box highlight">
                    <span className="stat-box-label">Total Arrecadado</span>
                    <span className="stat-box-value">{formatCurrency(stats.total_qualifying_collected || 0)}</span>
                  </div>
                  <div className="stat-box highlight">
                    <span className="stat-box-label">Prize Pool Classificatórios</span>
                    <span className="stat-box-value">{formatCurrency(stats.total_qualifying_prize_pool || 0)}</span>
                  </div>
                </div>
              </Card>
            )}

            {/* Final Day Specific Stats */}
            {(stats.final_day_buy_ins > 0 || stats.final_day_rebuys > 0 || stats.final_day_addons > 0) && (
              <Card className="stats-card">
                <h2 className="stats-card-title">Entradas no Dia Final</h2>
                <div className="stats-grid">
                  <div className="stat-box">
                    <span className="stat-box-label">Buy-ins Diretos</span>
                    <span className="stat-box-value">{stats.final_day_buy_ins || 0}</span>
                  </div>
                  <div className="stat-box">
                    <span className="stat-box-label">Rebuys no Final</span>
                    <span className="stat-box-value">{stats.final_day_rebuys || 0}</span>
                  </div>
                  <div className="stat-box">
                    <span className="stat-box-label">Add-ons no Final</span>
                    <span className="stat-box-value">{stats.final_day_addons || 0}</span>
                  </div>
                  <div className="stat-box highlight">
                    <span className="stat-box-label">Arrecadado no Final</span>
                    <span className="stat-box-value">{formatCurrency(stats.final_day_collected || 0)}</span>
                  </div>
                </div>
              </Card>
            )}
          </>
        ) : (
          // Single Day Stats View
          <>
            <Card className="stats-card">
              <h2 className="stats-card-title">Totais do Dia</h2>
              <div className="stats-grid large">
                <div className="stat-box highlight">
                  <span className="stat-box-label">Prize Pool</span>
                  <span className="stat-box-value">{formatCurrency(stats.prize_pool || 0)}</span>
                </div>
                <div className="stat-box highlight">
                  <span className="stat-box-label">Total Arrecadado</span>
                  <span className="stat-box-value">{formatCurrency(stats.total_collected || 0)}</span>
                </div>
              </div>
            </Card>

            <Card className="stats-card">
              <h2 className="stats-card-title">Jogadores</h2>
              <div className="stats-grid">
                <div className="stat-box">
                  <span className="stat-box-label">Total de Jogadores</span>
                  <span className="stat-box-value">{stats.total_players || 0}</span>
                </div>
                <div className="stat-box">
                  <span className="stat-box-label">Eliminados</span>
                  <span className="stat-box-value">{stats.eliminated_players || 0}</span>
                </div>
                <div className="stat-box">
                  <span className="stat-box-label">Classificados / Ativos</span>
                  <span className="stat-box-value">{stats.qualified_players || 0}</span>
                </div>
              </div>
            </Card>

            <Card className="stats-card">
              <h2 className="stats-card-title">Entradas</h2>
              <div className="stats-grid">
                <div className="stat-box">
                  <span className="stat-box-label">Buy-ins</span>
                  <span className="stat-box-value">{stats.total_buy_ins || 0}</span>
                </div>
                <div className="stat-box">
                  <span className="stat-box-label">Rebuys</span>
                  <span className="stat-box-value">{stats.total_rebuys || 0}</span>
                </div>
                <div className="stat-box">
                  <span className="stat-box-label">Add-ons</span>
                  <span className="stat-box-value">{stats.total_addons || 0}</span>
                </div>
                <div className="stat-box">
                  <span className="stat-box-label">Total Entradas</span>
                  <span className="stat-box-value">{stats.total_entries || 0}</span>
                </div>
              </div>
            </Card>

            <Card className="stats-card">
              <h2 className="stats-card-title">Valores</h2>
              <div className="stats-grid">
                <div className="stat-box">
                  <span className="stat-box-label">Valor Buy-ins</span>
                  <span className="stat-box-value">{formatCurrency(stats.buy_in_amount || 0)}</span>
                </div>
                <div className="stat-box">
                  <span className="stat-box-label">Valor Rebuys</span>
                  <span className="stat-box-value">{formatCurrency(stats.rebuy_amount || 0)}</span>
                </div>
                <div className="stat-box">
                  <span className="stat-box-label">Valor Add-ons</span>
                  <span className="stat-box-value">{formatCurrency(stats.addon_amount || 0)}</span>
                </div>
              </div>
            </Card>
          </>
        )}
      </main>
    </div>
  );
};

export default TournamentDayStats;
