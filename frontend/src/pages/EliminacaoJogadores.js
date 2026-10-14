import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh';
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
import EliminadorModal from '../components/ko/EliminadorModal';
import KoResultadoModal from '../components/ko/KoResultadoModal';
import {
  candidatosAEliminador, codigoDaRecusa, corpoDaEliminacao, exigeEliminador, formatoKo,
} from '../utils/ko';
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
  // Torneio KO: "Quem eliminou?" antes de eliminar, e o KO para pagar na hora.
  const [eliminando, setEliminando] = useState(null); // { id, nome }
  const [enviandoElim, setEnviandoElim] = useState(false);
  const [resultadoKo, setResultadoKo] = useState(null);

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
  // Era a tela mais sedenta do sistema: recarregava a cada 3 segundos. É
  // também a que mais ganha com o aviso do banco — eliminar alguém aparece
  // nas outras telas na hora.
  useRealtimeRefresh({
    canal: `eliminacao-${tournamentId}`,
    tabelas: [{ table: 'tournament_players', filter: `tournament_id=eq.${tournamentId}` }],
    aoMudar: () => loadData(),
    ativo: !!tournamentId,
  });

  const handleEliminate = async (tournamentPlayerId, playerName) => {
    // Em torneio KO o "Quem eliminou?" já é a confirmação.
    if (exigeEliminador(tournament)) {
      setEliminando({ id: tournamentPlayerId, nome: playerName });
      return;
    }
    const ok = await confirm(t('elimination.confirmEliminate', { name: playerName }), { variant: 'danger', confirmText: t('elimination.eliminate') });
    if (!ok) return;
    await eliminar(tournamentPlayerId, playerName);
  };

  const eliminar = async (tournamentPlayerId, playerName, quem = null) => {
    const cmid = uuid();
    const body = corpoDaEliminacao(tournamentPlayerId, cmid, quem);
    setEnviandoElim(true);
    try {
      const r = await offlineWrite({
        kind: 'eliminate', method: 'post',
        url: `/tournament-players/${tournamentPlayerId}/eliminate`,
        body, clientMutationId: cmid, meta: { kind: 'eliminate', name: playerName },
        synthetic: { ok: true }, applyLocal: () => applyEliminate(body),
      });
      setEliminando(null);
      // otimista na lista + reconcilia se online
      setPlayers(prev => prev.map(p => p.id === tournamentPlayerId ? { ...p, status: 'eliminated' } : p));
      if (r.offline) {
        toast.success(t('offline.savedOffline', 'Salvo offline — será enviado ao sincronizar'));
        if (quem) {
          toast.info(formatoKo(tournament) === 'mystery'
            ? t('ko.offlinePendingMystery', 'Sem conexão: o envelope será sorteado ao sincronizar e o pagamento fica pendente na aba Mystery da Premiação.')
            : t('ko.offlinePending', 'Sem conexão: o KO será registrado ao sincronizar e o pagamento fica pendente na aba KO da Premiação.'));
        }
      } else {
        if (r.data?.knockout) setResultadoKo(r.data.knockout);
        loadData();
      }
    } catch (error) {
      // A fase Mystery pode ter começado depois que esta tela abriu: relê o
      // torneio e pergunta quem eliminou, em vez de só recusar.
      if (!quem && codigoDaRecusa(error) === 'eliminador_obrigatorio') {
        await loadData();
        setEliminando({ id: tournamentPlayerId, nome: playerName });
        return;
      }
      console.error('Error eliminating player:', error);
      const errorMessage = error.userMessage || error.response?.data?.detail || t('common.error');
      toast.error(typeof errorMessage === 'string' ? errorMessage : t('common.error'));
    } finally {
      setEnviandoElim(false);
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
      // Desfazer pode ser recusado com motivo (KO já pago, por exemplo).
      const errorMessage = error.userMessage || error.response?.data?.detail || t('common.error');
      toast.error(typeof errorMessage === 'string' ? errorMessage : t('common.error'));
    }
  };

  // Contagens: UMA passada, não duas. Elas dependem só da lista, então não
  // são refeitas quando o operador digita na busca.
  const { activePlayers, eliminatedPlayers } = useMemo(() => {
    let ativos = 0;
    for (const p of players) if (p.status !== 'eliminated') ativos += 1;
    return { activePlayers: ativos, eliminatedPlayers: players.length - ativos };
  }, [players]);

  const totalPlayers = players.length;

  // Status + busca numa passada só.
  //
  // Eram duas varreduras encadeadas, refeitas a cada render — e esta tela
  // re-renderiza a cada tecla digitada E a cada evento do banco. Pior: o
  // `searchTerm.toLowerCase()` estava DENTRO do filtro, então uma string nova
  // era alocada por jogador comparado, não uma por busca.
  const filteredPlayers = useMemo(() => {
    const termo = searchTerm.trim().toLowerCase();
    return players.filter((player) => {
      if (statusFilter === 'active' && player.status === 'eliminated') return false;
      if (statusFilter === 'eliminated' && player.status !== 'eliminated') return false;
      if (!termo) return true;
      return (
        player.player_name.toLowerCase().includes(termo)
        || (player.player_nickname || '').toLowerCase().includes(termo)
      );
    });
  }, [players, statusFilter, searchTerm]);

  const candidatos = useMemo(() => (
    eliminando
      ? candidatosAEliminador(players.map((p) => ({ ...p, nome: p.player_name })), eliminando.id)
      : []
  ), [eliminando, players]);

  const selectedDay = useMemo(
    () => tournamentDays.find((d) => d.id === selectedDayId),
    [tournamentDays, selectedDayId],
  );

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
                      type="button"
                      className={`filter-btn ${statusFilter === 'active' ? 'active' : ''}`}
                      onClick={() => setStatusFilter('active')}
                    >
                      {t('elimination.activeOnly')} ({activePlayers})
                    </button>
                    <button
                      type="button"
                      className={`filter-btn ${statusFilter === 'eliminated' ? 'active' : ''}`}
                      onClick={() => setStatusFilter('eliminated')}
                    >
                      {t('elimination.eliminatedOnly')} ({eliminatedPlayers})
                    </button>
                    <button
                      type="button"
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

        {eliminando && (
          <EliminadorModal
            vitima={eliminando.nome}
            formato={formatoKo(tournament)}
            candidatos={candidatos}
            enviando={enviandoElim}
            onFechar={() => { if (!enviandoElim) setEliminando(null); }}
            onConfirmar={(quem) => eliminar(eliminando.id, eliminando.nome, quem)}
          />
        )}

        {resultadoKo && (
          <KoResultadoModal
            tournamentId={tournamentId}
            knockout={resultadoKo}
            torneioNome={tournament?.name}
            onFechar={() => setResultadoKo(null)}
          />
        )}
      </main>
    </div>
  );
};

export default EliminacaoJogadores;
