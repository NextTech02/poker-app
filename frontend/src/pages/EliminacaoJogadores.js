import React, { useEffect, useState, useCallback } from 'react';
import { usePolling } from '../hooks/usePolling';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import Button from '../components/Button';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { offlineWrite } from '../offline/apiOffline';
import { applyEliminate } from '../offline/domainRules';
import { uuid, getEntity, putEntity } from '../offline/db';
import './EliminacaoJogadores.css';

const EliminacaoJogadores = () => {
  const { toast, confirm } = useToast();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const tournamentId = searchParams.get('tournament');
  const initialDayId = searchParams.get('day');

  const [tournament, setTournament] = useState(null);
  const [stage, setStage] = useState(null);
  const [tournamentDays, setTournamentDays] = useState([]);
  const [selectedDayId, setSelectedDayId] = useState(initialDayId || '');
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('active'); // 'active', 'all', 'eliminated'

  const loadData = useCallback(async () => {
    try {
      // Load tournament details
      const tournamentRes = await api.get(`/tournaments/${tournamentId}`);
      setTournament(tournamentRes.data);

      // Load stage details if tournament has a stage
      if (tournamentRes.data.stage_id) {
        try {
          const stageRes = await api.get(`/stages/${tournamentRes.data.stage_id}`);
          setStage(stageRes.data);
        } catch (stageError) {
          console.error('Erro ao carregar etapa:', stageError);
          setStage(null);
        }
      }

      // Load tournament days
      const daysRes = await api.get(`/tournament-days/tournament/${tournamentId}`);
      setTournamentDays(daysRes.data);

      // If initial day is not set but there are days, select the first active one
      if (!selectedDayId && daysRes.data.length > 0) {
        const activeDay = daysRes.data.find(d => d.status === 'active') || daysRes.data[0];
        setSelectedDayId(activeDay.id);
      }

      // Load players based on selected day or all tournament players
      let playersData = [];
      if (selectedDayId) {
        const playersRes = await api.get(`/tournament-players/day/${selectedDayId}`);
        playersData = playersRes.data;
      } else {
        const playersRes = await api.get(`/tournament-players/tournament/${tournamentId}`);
        playersData = playersRes.data;
      }

      setPlayers(playersData);
    } catch (error) {
      console.error('Erro ao carregar dados:', error);
    } finally {
      setLoading(false);
    }
  }, [tournamentId, selectedDayId]);

  useEffect(() => {
    if (!tournamentId) {
      navigate('/torneios');
      return;
    }
    loadData();
  }, [tournamentId, navigate, loadData]);

  // Polling de 3s que pausa quando a aba está oculta (substitui o controle
  // manual de visibilitychange por um hook reutilizável).
  usePolling(() => loadData(), tournamentId ? 3000 : 0);

  const handleEliminate = async (tournamentPlayerId, playerName) => {
    const ok = await confirm(t('elimination.confirmEliminate', { name: playerName }), { variant: 'danger', confirmText: t('elimination.eliminate') });
    if (!ok) return;

    const body = { tournament_player_id: tournamentPlayerId };
    try {
      const r = await offlineWrite({
        kind: 'eliminate', method: 'post',
        url: `/tournament-players/${tournamentPlayerId}/eliminate`,
        body, clientMutationId: uuid(), meta: { kind: 'eliminate', name: playerName },
        synthetic: { ok: true }, applyLocal: () => applyEliminate(body),
      });
      // otimista na lista + reconcilia se online
      setPlayers(prev => prev.map(p => p.id === tournamentPlayerId ? { ...p, status: 'eliminated' } : p));
      if (r.offline) toast.success(t('offline.savedOffline', 'Salvo offline — será enviado ao sincronizar'));
      else loadData();
    } catch (error) {
      console.error('Error eliminating player:', error);
      const errorMessage = error.response?.data?.detail || t('common.error');
      toast.error(typeof errorMessage === 'string' ? errorMessage : t('common.error'));
    }
  };

  const handleRestore = async (tournamentPlayerId, playerName) => {
    const ok = await confirm(t('elimination.confirmRestore', { name: playerName }));
    if (!ok) return;

    try {
      const r = await offlineWrite({
        kind: 'restore', method: 'patch',
        url: `/tournament-players/${tournamentPlayerId}`,
        body: { tournament_player_id: tournamentPlayerId, status: 'active' },
        clientMutationId: uuid(), meta: { kind: 'restore', name: playerName },
        synthetic: { ok: true },
        applyLocal: async () => {
          const tp = await getEntity('tournament_players', tournamentPlayerId);
          if (tp) { tp.status = 'active'; delete tp.eliminated_at; await putEntity('tournament_players', tp); }
        },
      });
      setPlayers(prev => prev.map(p => p.id === tournamentPlayerId ? { ...p, status: 'active' } : p));
      if (r.offline) toast.success(t('offline.savedOffline', 'Salvo offline — será enviado ao sincronizar'));
      else loadData();
    } catch (error) {
      console.error('Error restoring player:', error);
      const errorMessage = error.response?.data?.detail || t('common.error');
      toast.error(typeof errorMessage === 'string' ? errorMessage : t('common.error'));
    }
  };

  // Filter by status
  const statusFilteredPlayers = players.filter(player => {
    if (statusFilter === 'active') return player.status !== 'eliminated';
    if (statusFilter === 'eliminated') return player.status === 'eliminated';
    return true; // 'all'
  });

  // Filter by search term
  const filteredPlayers = statusFilteredPlayers.filter(player =>
    player.player_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    (player.player_nickname && player.player_nickname.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  const activePlayers = players.filter(p => p.status !== 'eliminated').length;
  const eliminatedPlayers = players.filter(p => p.status === 'eliminated').length;
  const totalPlayers = players.length;

  const selectedDay = tournamentDays.find(d => d.id === selectedDayId);

  const handleDayChange = (e) => {
    setSelectedDayId(e.target.value);
    setLoading(true);
  };

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div>
            <h1>
              {t('elimination.title')}
              {stage && ` - ${stage.name}`}
              {tournament && ` - ${tournament.name}`}
            </h1>
            {tournament && stage && (
              <p className="subtitle">
                {stage.location} • {new Date(stage.start_date).toLocaleDateString()}
              </p>
            )}
          </div>
          <Button variant="secondary" onClick={() => navigate(`/torneios/${tournamentId}`)}>
            {t('common.back')}
          </Button>
        </div>

        {loading ? (
          <div className="loading">{t('common.loading')}</div>
        ) : (
          <>
            {/* Day Selector */}
            {tournamentDays.length > 0 && (
              <Card className="day-selector-card">
                <div className="day-selector-section">
                  <label htmlFor="day-select">{t('elimination.selectDay')}:</label>
                  <select
                    id="day-select"
                    value={selectedDayId}
                    onChange={handleDayChange}
                    className="day-select"
                  >
                    {tournamentDays.map(day => (
                      <option key={day.id} value={day.id}>
                        {day.day_name} {day.status === 'active' ? `(${t('common.active')})` : day.status === 'completed' ? `(${t('common.completed')})` : ''}
                      </option>
                    ))}
                  </select>
                  {selectedDay && (
                    <span className={`day-status-badge ${selectedDay.status}`}>
                      {selectedDay.status === 'pending' && t('common.pending')}
                      {selectedDay.status === 'active' && t('common.active')}
                      {selectedDay.status === 'completed' && t('common.completed')}
                      {selectedDay.status === 'cancelled' && t('common.cancelled')}
                    </span>
                  )}
                </div>
              </Card>
            )}

            <Card className="stats-card">
              <div className="elimination-stats">
                <div className="stat-item">
                  <span className="stat-label">{t('elimination.totalPlayers')}</span>
                  <span className="stat-value">{totalPlayers}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">{t('elimination.activePlayers')}</span>
                  <span className="stat-value active">{activePlayers}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">{t('elimination.eliminatedPlayers')}</span>
                  <span className="stat-value eliminated">{eliminatedPlayers}</span>
                </div>
              </div>
            </Card>

            <Card>
              <div className="filters-section">
                <div className="search-section">
                  <input
                    type="text"
                    placeholder={t('players.searchPlayers')}
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="search-input"
                  />
                </div>
                <div className="status-filter">
                  <label>{t('elimination.filterByStatus')}:</label>
                  <div className="filter-buttons">
                    <button
                      className={`filter-btn ${statusFilter === 'active' ? 'active' : ''}`}
                      onClick={() => setStatusFilter('active')}
                    >
                      {t('elimination.activeOnly')} ({activePlayers})
                    </button>
                    <button
                      className={`filter-btn ${statusFilter === 'eliminated' ? 'active' : ''}`}
                      onClick={() => setStatusFilter('eliminated')}
                    >
                      {t('elimination.eliminatedOnly')} ({eliminatedPlayers})
                    </button>
                    <button
                      className={`filter-btn ${statusFilter === 'all' ? 'active' : ''}`}
                      onClick={() => setStatusFilter('all')}
                    >
                      {t('elimination.allPlayers')} ({totalPlayers})
                    </button>
                  </div>
                </div>
              </div>

              {filteredPlayers.length === 0 ? (
                <div className="empty-state">
                  <p>{t('players.noPlayers')}</p>
                </div>
              ) : (
                <div className="players-grid">
                  {filteredPlayers.map((player) => (
                    <div key={player.id} className={`player-elimination-card ${player.status === 'eliminated' ? 'eliminated' : ''}`}>
                      <div className="player-info">
                        <div className="player-header">
                          <h3>{player.player_name}</h3>
                          <span className={`player-status-badge ${player.status}`}>
                            {player.status === 'active' && t('common.active')}
                            {player.status === 'registered' && t('common.pending')}
                            {player.status === 'eliminated' && t('elimination.eliminatedPlayers')}
                            {player.status === 'winner' && t('common.completed')}
                          </span>
                        </div>
                        {player.player_nickname && (
                          <span className="player-nickname">"{player.player_nickname}"</span>
                        )}
                        <div className="player-details">
                          <div className="detail-row">
                            <span>{t('elimination.buyIns')}: {player.buy_in_count}</span>
                          </div>
                          <div className="detail-row">
                            <span>{t('elimination.rebuys')}: {player.rebuy_count}</span>
                          </div>
                          <div className="detail-row">
                            <span>{t('elimination.addons')}: {player.addon_count}</span>
                          </div>
                          <div className="detail-row">
                            <span>{t('elimination.chips')}: {(player.total_chips || 0).toLocaleString()}</span>
                          </div>
                          {player.is_qualified_entry && (
                            <div className="detail-row qualified">
                              <span>{t('elimination.qualified')}</span>
                            </div>
                          )}
                          {player.final_chip_count && (
                            <div className="detail-row chips-final">
                              <span>{t('elimination.finalChips')}: {player.final_chip_count.toLocaleString()}</span>
                            </div>
                          )}
                        </div>
                      </div>
                      {player.status !== 'eliminated' ? (
                        <Button
                          variant="danger"
                          onClick={() => handleEliminate(player.id, player.player_name)}
                          className="eliminate-btn"
                        >
                          {t('elimination.eliminate')}
                        </Button>
                      ) : (
                        <Button
                          variant="secondary"
                          onClick={() => handleRestore(player.id, player.player_name)}
                          className="restore-btn"
                        >
                          {t('elimination.restore')}
                        </Button>
                      )}
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
