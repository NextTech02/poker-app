import React, { useEffect, useState, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import Button from '../components/Button';
import api from '../config/api';
import { usePolling } from '../hooks/usePolling';
import { useCurrency } from '../contexts/CurrencyContext';
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
  const { formatCurrency } = useCurrency();

  const loadTournamentData = async () => {
    try {
      // Get tournament and all its days
      const [tournamentRes, daysRes] = await Promise.all([
        api.get(`/tournaments/${tournamentId}`),
        api.get(`/tournament-days/tournament/${tournamentId}`)
      ]);

      setTournament(tournamentRes.data);
      setDays(daysRes.data);
    } catch (err) {
      console.error('Error loading tournament:', err);
    } finally {
      setLoading(false);
    }
  };

  // Carrega TODOS os jogadores do torneio numa só chamada (antes era 1 por dia
  // = N+1 round-trips a cada 5s). Roda em paralelo ao loadTournamentData.
  const loadPlayers = async () => {
    try {
      const playersRes = await api.get(`/tournament-players/tournament/${tournamentId}`);
      setAllPlayers(playersRes.data || []);
    } catch (err) {
      console.error('Error loading players:', err);
    }
  };

  const refresh = () => {
    loadTournamentData();
    loadPlayers();
  };

  useEffect(() => {
    if (tournamentId) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tournamentId]);

  // Polling de 5s que pausa quando a aba está oculta (reduz carga em produção).
  usePolling(refresh, tournamentId ? 5000 : 0);

  // Financeiro do torneio — memoizado (só recalcula quando jogadores/dias mudam)
  // e usando um Map dia→jogadores (O(n)) em vez de filtrar por dia (O(n²)).
  // Considera apenas dias NÃO finais (os finais herdam dos classificatórios).
  const financials = useMemo(() => {
    const finalDayIds = new Set(days.filter(d => d.day_type === 'final').map(d => d.id));
    const players = allPlayers.filter(p => !finalDayIds.has(p.tournament_day_id));

    const totalBuyInsCount = players.reduce((sum, p) => sum + (p.buy_in_count || 0), 0);
    const totalRebuysCount = players.reduce((sum, p) => sum + (p.rebuy_count || 0), 0);
    const totalAddonsCount = players.reduce((sum, p) => sum + (p.addon_count || 0), 0);

    const totalBuyInsRevenue = players.reduce((sum, p) => sum + (p.total_buy_in_amount || 0), 0);
    const totalRebuysRevenue = players.reduce((sum, p) => sum + (p.total_rebuy_amount || 0), 0);
    const totalAddonsRevenue = players.reduce((sum, p) => sum + (p.total_addon_amount || 0), 0);

    const totalRevenue = totalBuyInsRevenue + totalRebuysRevenue + totalAddonsRevenue;

    // Agrupa jogadores por dia uma única vez (O(n)).
    const byDay = new Map();
    for (const p of players) {
      const arr = byDay.get(p.tournament_day_id);
      if (arr) arr.push(p); else byDay.set(p.tournament_day_id, [p]);
    }

    let weightedRakeSum = 0;
    let totalDayRevenue = 0;
    for (const day of days) {
      if (day.day_type === 'final') continue;
      const dayPlayers = byDay.get(day.id) || [];
      const dayRevenue = dayPlayers.reduce(
        (sum, p) => sum + (p.total_buy_in_amount || 0) + (p.total_rebuy_amount || 0) + (p.total_addon_amount || 0),
        0
      );
      weightedRakeSum += dayRevenue * (day.rake_percentage || 0);
      totalDayRevenue += dayRevenue;
    }

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
  }, [allPlayers, days]);

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
            <span className="value positive">{formatCurrency(financials.totalRevenue)}</span>
          </div>
          <div className="financial-row">
            <span className="label">
              Taxa Administrativa (Rake {financials.averageRakePercentage.toFixed(1)}% médio)
            </span>
            <span className="value negative">- {formatCurrency(financials.rake)}</span>
          </div>
          <div className="financial-row">
            <span className="label">Banco para Torneio</span>
            <span className="value positive">{formatCurrency(financials.prizePool)}</span>
          </div>
          <div className="financial-row">
            <span className="label">Stake de Item</span>
            <span className="value neutral">{formatCurrency(0)}</span>
          </div>
          <div className="financial-row total">
            <span className="label">Custo para Premiações</span>
            <span className="value positive">{formatCurrency(financials.prizePool)}</span>
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
            <span className="value positive">{formatCurrency(financials.totalRevenue)}</span>
          </div>
          <div className="financial-row">
            <span className="label">
              Rake ({financials.averageRakePercentage.toFixed(1)}% médio)
            </span>
            <span className="value negative">- {formatCurrency(financials.rake)}</span>
          </div>
          <div className="financial-row total">
            <span className="label">Prize Pool</span>
            <span className="value positive">{formatCurrency(financials.prizePool)}</span>
          </div>
        </Card>
      </div>

      {/* Items Summary Section */}
      <div className="items-section">
        <h3 className="section-title">Itens dos Torneios ({days.filter(d => d.day_type !== 'final').length} {days.filter(d => d.day_type !== 'final').length === 1 ? 'dia' : 'dias'})</h3>

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
                <td className="text-right">{formatCurrency(financials.totalBuyInsRevenue)}</td>
                <td className="text-right">{formatCurrency(0)}</td>
                <td className="text-right">{formatCurrency(financials.totalBuyInsRevenue)}</td>
                <td className="text-right total-value">{formatCurrency(financials.totalBuyInsRevenue)}</td>
              </tr>
              {financials.totalRebuysCount > 0 && (
                <tr>
                  <td>Rebuy</td>
                  <td className="text-center">{financials.totalRebuysCount}</td>
                  <td className="text-right">{formatCurrency(financials.totalRebuysRevenue)}</td>
                  <td className="text-right">{formatCurrency(0)}</td>
                  <td className="text-right">{formatCurrency(financials.totalRebuysRevenue)}</td>
                  <td className="text-right total-value">{formatCurrency(financials.totalRebuysRevenue)}</td>
                </tr>
              )}
              {financials.totalAddonsCount > 0 && (
                <tr>
                  <td>Add-on</td>
                  <td className="text-center">{financials.totalAddonsCount}</td>
                  <td className="text-right">{formatCurrency(financials.totalAddonsRevenue)}</td>
                  <td className="text-right">{formatCurrency(0)}</td>
                  <td className="text-right">{formatCurrency(financials.totalAddonsRevenue)}</td>
                  <td className="text-right total-value">{formatCurrency(financials.totalAddonsRevenue)}</td>
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
