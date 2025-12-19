import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import Button from '../components/Button';
import PlayerSelect from '../components/PlayerSelect';
import api from '../config/api';
import { supabase } from '../config/supabase';
import './TournamentDetail.css';

const TournamentDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [tournament, setTournament] = useState(null);
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showRegisterModal, setShowRegisterModal] = useState(false);
  const [showEditRebuyLimitModal, setShowEditRebuyLimitModal] = useState(false);
  const [formData, setFormData] = useState({
    player_id: '',
    buy_in_count: 1,
    notes: '',
  });
  const [rebuyLimitFormData, setRebuyLimitFormData] = useState({
    rebuy_level_limit: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const loadTournamentData = async () => {
    try {
      const [tournamentRes, playersRes] = await Promise.all([
        api.get(`/tournaments/${id}`),
        api.get(`/tournament-players/tournament/${id}`)
      ]);
      setTournament(tournamentRes.data);
      setPlayers(playersRes.data);
    } catch (err) {
      console.error('Error loading tournament:', err);
      setError('Erro ao carregar torneio');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTournamentData();

    // Subscribe to tournament updates
    const tournamentSub = supabase
      .channel(`tournament-detail-${id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tournaments',
          filter: `id=eq.${id}`
        },
        (payload) => {
          console.log('Tournament updated:', payload);
          setTournament(payload.new);
        }
      )
      .subscribe();

    // Subscribe to player updates
    const playersSub = supabase
      .channel(`tournament-players-detail-${id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tournament_players',
          filter: `tournament_id=eq.${id}`
        },
        () => {
          console.log('Players updated');
          loadTournamentData();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(tournamentSub);
      supabase.removeChannel(playersSub);
    };
  }, [id]);

  const handleRegisterPlayer = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      await api.post('/tournament-players', {
        tournament_id: id,
        ...formData
      });

      setShowRegisterModal(false);
      setFormData({
        player_id: '',
        buy_in_count: 1,
        notes: '',
      });
      loadTournamentData();
    } catch (err) {
      console.error('Error registering player:', err);
      const errorMessage = err.response?.data?.detail || 'Erro ao registrar jogador';
      setError(errorMessage);
      alert(errorMessage);
    } finally {
      setSubmitting(false);
    }
  };

  const handleAddRebuy = async (playerId) => {
    try {
      await api.post(`/tournament-players/${playerId}/rebuy`);
      loadTournamentData();
    } catch (err) {
      console.error('Error adding rebuy:', err);
      alert('Erro ao adicionar rebuy');
    }
  };

  const handleAddAddon = async (playerId) => {
    try {
      await api.post(`/tournament-players/${playerId}/addon`);
      loadTournamentData();
    } catch (err) {
      console.error('Error adding addon:', err);
      alert('Erro ao adicionar addon');
    }
  };

  const handleUpdateRebuyLimit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const updateData = {
        rebuy_level_limit: rebuyLimitFormData.rebuy_level_limit
          ? parseInt(rebuyLimitFormData.rebuy_level_limit)
          : null
      };

      await api.patch(`/tournaments/${id}`, updateData);
      setShowEditRebuyLimitModal(false);
      loadTournamentData();
      alert('Limite de rebuy atualizado com sucesso!');
    } catch (err) {
      console.error('Error updating rebuy limit:', err);
      const errorMessage = err.response?.data?.detail || 'Erro ao atualizar limite de rebuy';
      setError(errorMessage);
      alert(errorMessage);
    } finally {
      setSubmitting(false);
    }
  };

  const openEditRebuyLimitModal = () => {
    setRebuyLimitFormData({
      rebuy_level_limit: tournament.rebuy_level_limit || ''
    });
    setShowEditRebuyLimitModal(true);
  };

  const isTournamentFull = () => {
    if (!tournament) return false;
    return tournament.registered_players >= tournament.max_players;
  };

  const getStatusBadge = (status) => {
    const badges = {
      pending: { label: 'Pendente', className: 'badge-warning' },
      active: { label: 'Em Andamento', className: 'badge-success' },
      completed: { label: 'Concluído', className: 'badge-info' },
      cancelled: { label: 'Cancelado', className: 'badge-danger' },
    };
    const badge = badges[status] || badges.pending;
    return <span className={`badge ${badge.className}`}>{badge.label}</span>;
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

  if (!tournament) {
    return (
      <div className="app-container">
        <Sidebar />
        <main className="main-content">
          <Card>
            <p>Torneio não encontrado</p>
            <Button onClick={() => navigate('/torneios')}>Voltar</Button>
          </Card>
        </main>
      </div>
    );
  }

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div>
            <h1>{tournament.name}</h1>
            <p className="subtitle">Registro de Jogadores</p>
            {tournament.rebuy_amount && (
              <p className="subtitle">
                Limite de Rebuy: {tournament.rebuy_level_limit ? `Nível ${tournament.rebuy_level_limit}` : 'Ilimitado'}
                {' '}
                <button
                  onClick={openEditRebuyLimitModal}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#007bff',
                    cursor: 'pointer',
                    textDecoration: 'underline',
                    fontSize: '0.9rem'
                  }}
                  title="Editar limite de rebuy"
                >
                  (editar)
                </button>
              </p>
            )}
          </div>
          <div className="header-actions">
            {tournament.status === 'active' && (
              <Button onClick={() => navigate(`/broadcast/${id}`)}>
                Transmitir
              </Button>
            )}
            <Button variant="secondary" onClick={() => navigate('/torneios')}>
              Voltar
            </Button>
          </div>
        </div>

        {/* Players Section */}
        <div className="section-header">
          <h2>Jogadores Registrados ({players.length})</h2>
          <Button
            onClick={() => setShowRegisterModal(true)}
            disabled={isTournamentFull() || tournament.status !== 'pending'}
          >
            {isTournamentFull() ? 'Torneio Lotado' : 'Registrar Jogador'}
          </Button>
        </div>

        <Card>
          <div className="capacity-indicator">
            <span className="capacity-label">Capacidade:</span>
            <span className={`capacity-value ${isTournamentFull() ? 'full' : ''}`}>
              {tournament.registered_players} / {tournament.max_players}
              {isTournamentFull() && ' - LOTADO'}
            </span>
          </div>
        </Card>

        {players.length === 0 ? (
          <Card>
            <div className="empty-state">
              <p>Nenhum jogador registrado ainda</p>
              {!isTournamentFull() && tournament.status === 'pending' && (
                <Button onClick={() => setShowRegisterModal(true)}>
                  Registrar Primeiro Jogador
                </Button>
              )}
            </div>
          </Card>
        ) : (
          <div className="players-table-container">
            <Card>
              <table className="players-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Nome</th>
                    <th>Buy-ins</th>
                    <th>Rebuys</th>
                    <th>Add-ons</th>
                    <th>Fichas</th>
                    <th>Total Gasto</th>
                    <th>Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {players.map((player, index) => (
                    <tr key={player.id}>
                      <td>{index + 1}</td>
                      <td>
                        <div className="player-name">
                          {player.player_name}
                          {player.player_nickname && (
                            <span className="player-nickname">({player.player_nickname})</span>
                          )}
                        </div>
                      </td>
                      <td>{player.buy_in_count}</td>
                      <td>{player.rebuy_count}</td>
                      <td>{player.addon_count}</td>
                      <td className="chips-value">{player.total_chips.toLocaleString()}</td>
                      <td className="money-value">R$ {player.total_spent?.toFixed(2)}</td>
                      <td>
                        <div className="action-buttons">
                          {tournament.status === 'pending' && tournament.rebuy_amount && (
                            <button
                              className="btn-small btn-rebuy"
                              onClick={() => handleAddRebuy(player.id)}
                              title="Adicionar Rebuy"
                            >
                              Rebuy
                            </button>
                          )}
                          {tournament.status === 'pending' && tournament.addon_amount && (
                            <button
                              className="btn-small btn-addon"
                              onClick={() => handleAddAddon(player.id)}
                              title="Adicionar Add-on"
                            >
                              Add-on
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>
        )}

        {/* Register Player Modal */}
        {showRegisterModal && (
          <div className="modal-overlay" onClick={() => setShowRegisterModal(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>Registrar Jogador</h2>
                <button className="close-btn" onClick={() => setShowRegisterModal(false)}>
                  ✕
                </button>
              </div>
              <form onSubmit={handleRegisterPlayer}>
                <div className="form-group">
                  <label htmlFor="player_id">Jogador *</label>
                  <PlayerSelect
                    value={formData.player_id}
                    onChange={(value) => setFormData({ ...formData, player_id: value })}
                    required
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="buy_in_count">Número de Buy-ins *</label>
                  <input
                    id="buy_in_count"
                    name="buy_in_count"
                    type="number"
                    min="1"
                    value={formData.buy_in_count}
                    onChange={(e) => setFormData({ ...formData, buy_in_count: parseInt(e.target.value) })}
                    required
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="notes">Observações</label>
                  <textarea
                    id="notes"
                    name="notes"
                    rows="3"
                    value={formData.notes}
                    onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                    placeholder="Observações sobre o jogador..."
                  />
                </div>

                <div className="modal-actions">
                  <Button type="button" variant="secondary" onClick={() => setShowRegisterModal(false)}>
                    Cancelar
                  </Button>
                  <Button type="submit" disabled={submitting}>
                    {submitting ? 'Registrando...' : 'Registrar'}
                  </Button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Edit Rebuy Limit Modal */}
        {showEditRebuyLimitModal && (
          <div className="modal-overlay" onClick={() => setShowEditRebuyLimitModal(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>Editar Limite de Rebuy</h2>
                <button className="close-btn" onClick={() => setShowEditRebuyLimitModal(false)}>
                  ✕
                </button>
              </div>
              <form onSubmit={handleUpdateRebuyLimit}>
                <div className="form-group">
                  <label htmlFor="rebuy_level_limit">Nível Limite para Rebuy</label>
                  <input
                    id="rebuy_level_limit"
                    name="rebuy_level_limit"
                    type="number"
                    min="1"
                    value={rebuyLimitFormData.rebuy_level_limit}
                    onChange={(e) => setRebuyLimitFormData({ rebuy_level_limit: e.target.value })}
                    placeholder="Ex: 6 (permite rebuys até o nível 6)"
                  />
                  <small>
                    Deixe em branco para permitir rebuys ilimitados.<br />
                    Exemplo: Se definir como 6, rebuys só serão permitidos até o nível 6 de blinds.
                  </small>
                </div>

                <div className="modal-actions">
                  <Button type="button" variant="secondary" onClick={() => setShowEditRebuyLimitModal(false)}>
                    Cancelar
                  </Button>
                  <Button type="submit" disabled={submitting}>
                    {submitting ? 'Salvando...' : 'Salvar'}
                  </Button>
                </div>
              </form>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default TournamentDetail;
