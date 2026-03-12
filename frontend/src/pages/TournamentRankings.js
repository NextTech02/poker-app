import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import Breadcrumb from '../components/Breadcrumb';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import './TournamentRankings.css';

const TournamentRankings = () => {
  const { toast } = useToast();
  const { tournamentId } = useParams();
  const navigate = useNavigate();
  const [tournament, setTournament] = useState(null);
  const [rankings, setRankings] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();

    // Setup polling (every 5 seconds)
    const pollingInterval = setInterval(() => {
      loadData();
    }, 5000);

    return () => clearInterval(pollingInterval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tournamentId]);

  const loadData = async () => {
    try {
      // Load tournament details
      const tournamentRes = await api.get(`/tournaments/${tournamentId}`);
      setTournament(tournamentRes.data);

      // Load rankings
      const rankingsRes = await api.get(`/rankings/tournament/${tournamentId}`);
      setRankings(rankingsRes.data);

      setLoading(false);
    } catch (error) {
      console.error('Erro ao carregar rankings:', error);
      setLoading(false);
    }
  };

  const handleRecalculate = async () => {
    try {
      await api.post(`/rankings/tournament/${tournamentId}/recalculate`);
      await loadData();
      toast.success('Rankings recalculados com sucesso!');
    } catch (error) {
      console.error('Erro ao recalcular rankings:', error);
      toast.error('Erro ao recalcular rankings: ' + (error.response?.data?.detail || error.message));
    }
  };

  const formatDate = (dateString) => {
    if (!dateString) return '-';
    const date = new Date(dateString);
    return date.toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const formatCurrency = (value) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL'
    }).format(value);
  };

  const getPositionBadge = (position) => {
    if (position === 1) return '🥇';
    if (position === 2) return '🥈';
    if (position === 3) return '🥉';
    return position;
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
        {/* A6.4: Breadcrumb */}
        <Breadcrumb items={[
          { label: 'Início', to: '/' },
          { label: 'Torneios', to: '/torneios' },
          { label: tournament?.name || 'Torneio', to: `/torneios/${tournament?.id}` },
          { label: 'Ranking' },
        ]} />
        <div className="page-header">
          <div>
            <h1>Ranking do Torneio</h1>
            <p className="subtitle">
              {tournament?.name} - {rankings.length} jogadores classificados
            </p>
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button className="btn-secondary" onClick={handleRecalculate}>
              Recalcular Rankings
            </button>
            <button className="btn-back" onClick={() => navigate('/torneios')}>
              Voltar
            </button>
          </div>
        </div>

        <Card title="Classificação Atual">
          {rankings.length === 0 ? (
            <div className="empty-state">
              <p>Nenhum jogador eliminado ainda.</p>
              <p>Os rankings serão gerados automaticamente conforme jogadores forem eliminados.</p>
            </div>
          ) : (
            <div className="table-container">
              <table className="rankings-table">
                <thead>
                  <tr>
                    <th>Posição</th>
                    <th>Jogador</th>
                    <th>Status</th>
                    <th>Eliminado em</th>
                    <th>Prêmio</th>
                  </tr>
                </thead>
                <tbody>
                  {rankings.map((ranking) => (
                    <tr key={ranking.player_id} className={`position-${ranking.position}`}>
                      <td className="position-cell">
                        <span className="position-badge">
                          {getPositionBadge(ranking.position)}
                        </span>
                      </td>
                      <td>
                        <div className="player-info">
                          <span className="player-name">{ranking.player_name}</span>
                          {ranking.player_nickname && (
                            <span className="player-nickname"> ({ranking.player_nickname})</span>
                          )}
                        </div>
                      </td>
                      <td>
                        <span className={`badge badge-${ranking.status}`}>
                          {ranking.status === 'winner' ? 'Vencedor' :
                           ranking.status === 'eliminated' ? 'Eliminado' :
                           ranking.status}
                        </span>
                      </td>
                      <td>{formatDate(ranking.eliminated_at)}</td>
                      <td className="prize-cell">
                        {ranking.prize_won > 0 ? formatCurrency(ranking.prize_won) : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </main>
    </div>
  );
};

export default TournamentRankings;
