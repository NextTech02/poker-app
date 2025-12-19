import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import Button from '../components/Button';
import api from '../config/api';
import './EliminacaoJogadores.css';

const EliminacaoJogadores = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const tournamentId = searchParams.get('tournament');

  const [tournament, setTournament] = useState(null);
  const [stage, setStage] = useState(null);
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');

  const loadData = useCallback(async () => {
    try {
      // Load tournament details
      const tournamentRes = await api.get(`/tournaments/${tournamentId}`);
      setTournament(tournamentRes.data);
      console.log('Tournament data:', tournamentRes.data);

      // Load stage details if tournament has a stage
      if (tournamentRes.data.stage_id) {
        try {
          const stageRes = await api.get(`/stages/${tournamentRes.data.stage_id}`);
          setStage(stageRes.data);
          console.log('Stage data:', stageRes.data);
        } catch (stageError) {
          console.error('Erro ao carregar etapa:', stageError);
          setStage(null);
        }
      } else {
        console.log('Tournament has no stage_id');
        setStage(null);
      }

      // Load active players (not eliminated)
      const playersRes = await api.get(`/tournament-players/tournament/${tournamentId}`);
      setPlayers(playersRes.data.filter(p => p.status !== 'eliminated'));
    } catch (error) {
      console.error('Erro ao carregar dados:', error);
    } finally {
      setLoading(false);
    }
  }, [tournamentId]);

  useEffect(() => {
    if (!tournamentId) {
      navigate('/torneios');
      return;
    }
    loadData();

    // Setup polling (every 3 seconds) - only when page is visible
    let pollingInterval;

    const startPolling = () => {
      pollingInterval = setInterval(() => {
        if (!document.hidden) {
          loadData();
        }
      }, 3000);
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        // Page hidden, clear interval
        if (pollingInterval) clearInterval(pollingInterval);
      } else {
        // Page visible, restart polling and refresh immediately
        loadData();
        startPolling();
      }
    };

    startPolling();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      if (pollingInterval) clearInterval(pollingInterval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [tournamentId, navigate, loadData]);

  const handleEliminate = async (tournamentPlayerId, playerName) => {
    if (window.confirm(`Tem certeza que deseja eliminar ${playerName}?`)) {
      try {
        await api.post(`/tournament-players/${tournamentPlayerId}/eliminate`);
        loadData(); // Reload to update the list
      } catch (error) {
        console.error('Erro ao eliminar jogador:', error);
        const errorMessage = error.response?.data?.detail || 'Erro ao eliminar jogador';
        alert(errorMessage);
      }
    }
  };

  const filteredPlayers = players.filter(player =>
    player.player_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    (player.player_nickname && player.player_nickname.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  const activePlayers = players.length;
  const totalPlayers = tournament?.registered_players || 0;

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div>
            <h1>
              Eliminar Jogadores
              {stage && ` - ${stage.name}`}
              {tournament && ` - ${tournament.name}`}
            </h1>
            {tournament && stage && (
              <p className="subtitle">
                {stage.location} • {new Date(stage.start_date).toLocaleDateString('pt-BR')}
              </p>
            )}
          </div>
          <Button variant="secondary" onClick={() => navigate('/torneios')}>
            Voltar
          </Button>
        </div>

        {loading ? (
          <div className="loading">Carregando jogadores...</div>
        ) : (
          <>
            <Card className="stats-card">
              <div className="elimination-stats">
                <div className="stat-item">
                  <span className="stat-label">Jogadores Ativos</span>
                  <span className="stat-value">{activePlayers} de {totalPlayers}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Eliminados</span>
                  <span className="stat-value eliminated">{totalPlayers - activePlayers}</span>
                </div>
              </div>
            </Card>

            <Card>
              <div className="search-section">
                <input
                  type="text"
                  placeholder="Buscar jogador..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="search-input"
                />
              </div>

              {filteredPlayers.length === 0 ? (
                <div className="empty-state">
                  <p>{searchTerm ? 'Nenhum jogador encontrado' : 'Todos os jogadores foram eliminados'}</p>
                </div>
              ) : (
                <div className="players-grid">
                  {filteredPlayers.map((player) => (
                    <div key={player.id} className="player-elimination-card">
                      <div className="player-info">
                        <h3>{player.player_name}</h3>
                        {player.player_nickname && (
                          <span className="player-nickname">"{player.player_nickname}"</span>
                        )}
                        <div className="player-details">
                          <div className="detail-row">
                            <span className="detail-icon"></span>
                            <span>Buy-ins: {player.buy_in_count}</span>
                          </div>
                          <div className="detail-row">
                            <span className="detail-icon"></span>
                            <span>Rebuys: {player.rebuy_count}</span>
                          </div>
                          <div className="detail-row">
                            <span className="detail-icon"></span>
                            <span>Add-ons: {player.addon_count}</span>
                          </div>
                          <div className="detail-row">
                            <span className="detail-icon"></span>
                            <span>Fichas: {player.total_chips.toLocaleString('pt-BR')}</span>
                          </div>
                        </div>
                      </div>
                      <Button
                        variant="danger"
                        onClick={() => handleEliminate(player.id, player.player_name)}
                        className="eliminate-btn"
                      >
                        Eliminar
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </>
        )}
      </main>
    </div>
  );
};

export default EliminacaoJogadores;
