import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import Button from '../components/Button';
import api from '../config/api';
import './TournamentDashboard.css';

const TournamentDashboard = ({ tournamentId: propTournamentId }) => {
  const { id: paramId } = useParams();
  const navigate = useNavigate();

  // Use prop if provided, otherwise use URL param
  const tournamentId = propTournamentId || paramId;
  const isStandalone = !propTournamentId; // true if accessed directly via route

  const [tournament, setTournament] = useState(null);
  const [days, setDays] = useState([]);
  const [allPlayers, setAllPlayers] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadTournamentData = async () => {
    try {
      // Get tournament and all its days
      const [tournamentRes, daysRes] = await Promise.all([
        api.get(`/tournaments/${tournamentId}`),
        api.get(`/tournament-days/tournament/${tournamentId}`)
      ]);

      setTournament(tournamentRes.data);
      setDays(daysRes.data);

      // Get players from non-final days only (final days inherit data from qualifying days)
      const financialDays = daysRes.data.filter(day => day.day_type !== 'final');
      if (financialDays.length > 0) {
        const playersPromises = financialDays.map(day =>
          api.get(`/tournament-players/day/${day.id}`)
        );
        const playersResponses = await Promise.all(playersPromises);

        // Flatten all players from non-final days and add tournament_day_id to each player
        const allPlayersData = financialDays.flatMap((day, index) =>
          playersResponses[index].data.map(player => ({
            ...player,
            tournament_day_id: day.id
          }))
        );
        setAllPlayers(allPlayersData);
      } else {
        setAllPlayers([]);
      }
    } catch (err) {
      console.error('Error loading tournament:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (tournamentId) {
      loadTournamentData();

      // Polling every 5 seconds
      const interval = setInterval(loadTournamentData, 5000);
      return () => clearInterval(interval);
    }
  }, [tournamentId]);

  // Calculate tournament financials aggregated from all days
  const calculateFinancials = () => {
    const totalBuyInsCount = allPlayers.reduce((sum, p) => sum + (p.buy_in_count || 0), 0);
    const totalRebuysCount = allPlayers.reduce((sum, p) => sum + (p.rebuy_count || 0), 0);
    const totalAddonsCount = allPlayers.reduce((sum, p) => sum + (p.addon_count || 0), 0);

    const totalBuyInsRevenue = allPlayers.reduce((sum, p) => sum + (p.total_buy_in_amount || 0), 0);
    const totalRebuysRevenue = allPlayers.reduce((sum, p) => sum + (p.total_rebuy_amount || 0), 0);
    const totalAddonsRevenue = allPlayers.reduce((sum, p) => sum + (p.total_addon_amount || 0), 0);

    const totalRevenue = totalBuyInsRevenue + totalRebuysRevenue + totalAddonsRevenue;

    // Calculate weighted average rake across all days
    let weightedRakeSum = 0;
    let totalDayRevenue = 0;

    days.forEach(day => {
      // Get players for this day
      const dayPlayers = allPlayers.filter(p => p.tournament_day_id === day.id);

      // Calculate revenue for this day
      const dayBuyInsRevenue = dayPlayers.reduce((sum, p) => sum + (p.total_buy_in_amount || 0), 0);
      const dayRebuysRevenue = dayPlayers.reduce((sum, p) => sum + (p.total_rebuy_amount || 0), 0);
      const dayAddonsRevenue = dayPlayers.reduce((sum, p) => sum + (p.total_addon_amount || 0), 0);
      const dayRevenue = dayBuyInsRevenue + dayRebuysRevenue + dayAddonsRevenue;

      // Add to weighted sum
      weightedRakeSum += dayRevenue * (day.rake_percentage || 0);
      totalDayRevenue += dayRevenue;
    });

    // Calculate weighted average rake percentage
    const averageRakePercentage = totalDayRevenue > 0 ? (weightedRakeSum / totalDayRevenue) : 0;
    const rake = (totalRevenue * averageRakePercentage) / 100;
    const prizePool = totalRevenue - rake;

    return {
      totalRevenue,
      rake,
      prizePool,
      totalBuyInsCount,
      totalRebuysCount,
      totalAddonsCount,
      totalBuyInsRevenue,
      totalRebuysRevenue,
      totalAddonsRevenue,
      averageRakePercentage,
    };
  };

  if (loading) {
    const content = <div className="loading">Carregando...</div>;

    if (isStandalone) {
      return (
        <div className="app-container">
          <Sidebar />
          <main className="main-content">
            {content}
          </main>
        </div>
      );
    }
    return content;
  }

  if (!tournament) {
    const content = (
      <Card>
        <p>Torneio não encontrado</p>
        {isStandalone && <Button onClick={() => navigate('/torneios')}>Voltar</Button>}
      </Card>
    );

    if (isStandalone) {
      return (
        <div className="app-container">
          <Sidebar />
          <main className="main-content">
            {content}
          </main>
        </div>
      );
    }
    return content;
  }

  if (days.length === 0) {
    const content = (
      <div className="empty-days-professional">
        <div className="empty-days-line" />
        <h3>Nenhum dia configurado</h3>
        <p>Acesse a aba "Dias" para criar o primeiro dia do torneio</p>
      </div>
    );

    if (isStandalone) {
      return (
        <div className="app-container">
          <Sidebar />
          <main className="main-content">
            <div className="page-header">
              <div>
                <h1>{tournament.name}</h1>
                <p className="subtitle">Dashboard Geral do Torneio</p>
              </div>
              <Button variant="secondary" onClick={() => navigate('/torneios')}>
                Voltar
              </Button>
            </div>
            {content}
          </main>
        </div>
      );
    }
    return content;
  }

  const financials = calculateFinancials();

  const dashboardContent = (
    <>
      {isStandalone && (
        <div className="page-header">
          <div>
            <h1>{tournament.name}</h1>
            <p className="subtitle">Dashboard Geral do Torneio</p>
          </div>
          <Button variant="secondary" onClick={() => navigate('/torneios')}>
            Voltar
          </Button>
        </div>
      )}

      <div className="dashboard-grid">
        {/* Resultados do Torneio */}
        <Card className="results-card">
          <h3 className="card-title">Resultados do Torneio</h3>
          <div className="financial-row">
            <span className="label">Arrecadação Total</span>
            <span className="value positive">R$ {financials.totalRevenue.toFixed(2)}</span>
          </div>
          <div className="financial-row">
            <span className="label">
              Taxa Administrativa (Rake {financials.averageRakePercentage.toFixed(1)}% médio)
            </span>
            <span className="value negative">- R$ {financials.rake.toFixed(2)}</span>
          </div>
          <div className="financial-row">
            <span className="label">Banco para Torneio</span>
            <span className="value positive">R$ {financials.prizePool.toFixed(2)}</span>
          </div>
          <div className="financial-row">
            <span className="label">Stake de Item</span>
            <span className="value neutral">R$ {0.00.toFixed(2)}</span>
          </div>
          <div className="financial-row total">
            <span className="label">Custo para Premiações</span>
            <span className="value positive">R$ {financials.prizePool.toFixed(2)}</span>
          </div>
        </Card>

        {/* Premiações e Rake */}
        <Card className="prizes-card">
          <h3 className="card-title">Premiações e Rake</h3>
          <div className="financial-row">
            <span className="label">Descrição</span>
            <span className="value">Valor</span>
          </div>
          <div className="financial-row">
            <span className="label">Saldo para Torneio</span>
            <span className="value positive">R$ {financials.totalRevenue.toFixed(2)}</span>
          </div>
          <div className="financial-row">
            <span className="label">
              Rake ({financials.averageRakePercentage.toFixed(1)}% médio)
            </span>
            <span className="value negative">- R$ {financials.rake.toFixed(2)}</span>
          </div>
          <div className="financial-row total">
            <span className="label">Prize Pool</span>
            <span className="value positive">R$ {financials.prizePool.toFixed(2)}</span>
          </div>
        </Card>
      </div>

      {/* Items Summary Section */}
      <div className="items-section">
        <h3 className="section-title">Itens dos Torneios ({days.length} {days.length === 1 ? 'dia' : 'dias'})</h3>

        <div className="players-details-table">
          <table className="details-table">
            <thead>
              <tr>
                <th>Item</th>
                <th className="text-center">Qtd. Vencida</th>
                <th className="text-right">Valor</th>
                <th className="text-right">Taxa</th>
                <th className="text-right">Nota Usuária</th>
                <th className="text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Torneio (Buy-in)</td>
                <td className="text-center">{financials.totalBuyInsCount}</td>
                <td className="text-right">R$ {financials.totalBuyInsRevenue.toFixed(2)}</td>
                <td className="text-right">R$ 0.00</td>
                <td className="text-right">R$ {financials.totalBuyInsRevenue.toFixed(2)}</td>
                <td className="text-right total-value">R$ {financials.totalBuyInsRevenue.toFixed(2)}</td>
              </tr>
              {financials.totalRebuysCount > 0 && (
                <tr>
                  <td>Rebuy</td>
                  <td className="text-center">{financials.totalRebuysCount}</td>
                  <td className="text-right">R$ {financials.totalRebuysRevenue.toFixed(2)}</td>
                  <td className="text-right">R$ 0.00</td>
                  <td className="text-right">R$ {financials.totalRebuysRevenue.toFixed(2)}</td>
                  <td className="text-right total-value">R$ {financials.totalRebuysRevenue.toFixed(2)}</td>
                </tr>
              )}
              {financials.totalAddonsCount > 0 && (
                <tr>
                  <td>Add-on</td>
                  <td className="text-center">{financials.totalAddonsCount}</td>
                  <td className="text-right">R$ {financials.totalAddonsRevenue.toFixed(2)}</td>
                  <td className="text-right">R$ 0.00</td>
                  <td className="text-right">R$ {financials.totalAddonsRevenue.toFixed(2)}</td>
                  <td className="text-right total-value">R$ {financials.totalAddonsRevenue.toFixed(2)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );

  if (isStandalone) {
    return (
      <div className="app-container">
        <Sidebar />
        <main className="main-content">
          {dashboardContent}
        </main>
      </div>
    );
  }

  return dashboardContent;
};

export default TournamentDashboard;
