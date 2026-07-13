import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import Button from '../components/Button';
import { useTimerSync, formatTime, formatTimeHuman } from '../hooks/useTimerSync';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import './TournamentControl.css';

const TournamentControl = () => {
  const { dayId } = useParams();
  const { t } = useTranslation();

  const { confirm } = useToast();
  const [day, setDay] = useState(null);
  const [loading, setLoading] = useState(true);
  const [bulkCount, setBulkCount] = useState('');

  // SINGLE SOURCE OF TRUTH - enriched timer from backend
  const {
    timerState,
    triggerRefetch: refetchTimer,
    applyOptimistic,
    broadcastCommand,
    isLoading: timerLoading,
  } = useTimerSync(dayId);

  // Load day info
  const loadData = useCallback(async () => {
    try {
      const dayRes = await api.get(`/tournament-days/${dayId}`);
      setDay(dayRes.data);
    } catch (error) {
      console.error('Error loading data:', error);
    } finally {
      setLoading(false);
    }
  }, [dayId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Play/pause: a UI otimista vira o relógio na HORA a cada clique. O comando de
  // rede usa debounce LEADING-EDGE: o primeiro toque é enviado IMEDIATAMENTE (para
  // a tela espectadora/Broadcast refletir o quanto antes, sem os 300ms de espera),
  // e toques rápidos subsequentes são coalescidos — um envio "trailing" garante que
  // o ESTADO FINAL foi persistido. Assim: 1 clique = 1 POST na hora; rajada = no
  // máximo 2 POST (primeiro + final), sem empilhar.
  const pauseCmdRef = useRef({ timer: null, desired: null, lastSent: null, lastClickAt: 0 });

  const scheduleToggle = useCallback((paused) => {
    applyOptimistic({ is_paused: paused }); // feedback visual imediato (Controle)
    broadcastCommand({ is_paused: paused }); // empurra p/ as telas de visualização já

    const sendNow = () => {
      const target = pauseCmdRef.current.desired;
      pauseCmdRef.current.lastSent = target;
      api.post(`/tournament-days/${dayId}/timer/${target ? 'pause' : 'start'}`)
        .catch((error) => console.error('Error toggling timer:', error))
        .finally(() => refetchTimer()); // reconcilia o tempo exato com o servidor
    };

    const now = Date.now();
    // Início de uma rajada (ocioso há >350ms) → leading edge: envia JÁ.
    const isNewBurst = now - pauseCmdRef.current.lastClickAt > 350;
    pauseCmdRef.current.lastClickAt = now;
    pauseCmdRef.current.desired = paused;

    if (isNewBurst) sendNow();

    // Trailing: ao fim da rajada, envia o estado final se ainda não foi persistido.
    if (pauseCmdRef.current.timer) clearTimeout(pauseCmdRef.current.timer);
    pauseCmdRef.current.timer = setTimeout(() => {
      pauseCmdRef.current.timer = null;
      if (pauseCmdRef.current.lastSent !== pauseCmdRef.current.desired) {
        sendNow();
      }
    }, 350);
  }, [applyOptimistic, broadcastCommand, refetchTimer, dayId]);

  // Cancela um comando pendente ao desmontar
  useEffect(() => () => {
    if (pauseCmdRef.current.timer) clearTimeout(pauseCmdRef.current.timer);
  }, []);

  const handleStart = () => scheduleToggle(false);
  const handlePause = () => scheduleToggle(true);

  const handleNextLevel = async () => {
    try {
      await api.post(`/tournament-days/${dayId}/timer/next-level`);
      refetchTimer();
    } catch (error) {
      console.error('Error advancing level:', error);
    }
  };

  const handlePrevLevel = async () => {
    try {
      await api.post(`/tournament-days/${dayId}/timer/prev-level`);
      refetchTimer();
    } catch (error) {
      console.error('Error going back level:', error);
    }
  };

  const handleAdjustTime = async (seconds) => {
    try {
      await api.post(`/tournament-days/${dayId}/timer/adjust`, { seconds });
      refetchTimer();
    } catch (error) {
      console.error('Error adjusting timer:', error);
    }
  };

  const handleResetTimer = async () => {
    const ok = await confirm(t('control.confirmReset'), { variant: 'danger', confirmText: 'Reset' });
    if (!ok) return;
    try {
      await api.post(`/tournament-days/${dayId}/timer/reset`);
      refetchTimer();
    } catch (error) {
      console.error('Error resetting timer:', error);
    }
  };

  // Elimination counter functions
  const handleEliminate = async (count) => {
    try {
      await api.post(`/tournament-days/${dayId}/eliminations`, { count });
      refetchTimer();
    } catch (error) {
      console.error('Error adjusting eliminations:', error);
    }
  };

  const handleBulkEliminate = async () => {
    const num = parseInt(bulkCount);
    if (!num || num <= 0) return;
    await handleEliminate(num);
    setBulkCount('');
  };

  if (loading || timerLoading) {
    return (
      <div className="app-container">
        <Sidebar />
        <main className="main-content">
          <div className="loading">{t('common.loading')}</div>
        </main>
      </div>
    );
  }

  // All display values come from the enriched endpoint
  const currentBlind = timerState?.current_blind;
  const nextBlind = timerState?.next_blind;
  const isBreak = currentBlind?.is_break === true;
  const isPaused = timerState?.is_paused;
  const activePlayersCount = timerState?.active_players || 0;
  const totalEntries = timerState?.total_entries || 0;
  const eliminationsCount = timerState?.eliminations_count || 0;

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        <div className="tournament-control">
          <div className="control-header">
            <h1>{day?.day_name}</h1>
            <div className="day-status">
              <span className={`status-badge ${day?.status}`}>
                {t(`common.${day?.status}`)}
              </span>
            </div>
          </div>

          {/* Timer Display */}
          <Card className="timer-card">
            <div className="timer-display">
              {isBreak ? (
                <div className="timer-break-indicator">
                  <div className="break-label-control">INTERVALO</div>
                  <div className="timer-value break">
                    {formatTime(timerState?.time_remaining_current_level || 0)}
                  </div>
                </div>
              ) : (
                <div className="timer-value">
                  {formatTime(timerState?.time_remaining_current_level || 0)}
                </div>
              )}

              <div className="timer-controls">
                {isPaused ? (
                  <Button onClick={handleStart} variant="success">
                    <span>▶</span>
                  </Button>
                ) : (
                  <Button onClick={handlePause} variant="warning">
                    <span>⏸</span>
                  </Button>
                )}

                <Button onClick={handlePrevLevel} variant="secondary">
                  <span>⏮</span>
                </Button>
                <Button onClick={handleNextLevel} variant="secondary">
                  <span>⏭</span>
                </Button>

                <Button onClick={() => handleAdjustTime(-300)} variant="secondary">-5m</Button>
                <Button onClick={() => handleAdjustTime(-60)} variant="secondary">-1m</Button>
                <Button onClick={() => handleAdjustTime(-30)} variant="secondary">-30s</Button>
                <Button onClick={() => handleAdjustTime(30)} variant="secondary">+30s</Button>
                <Button onClick={() => handleAdjustTime(60)} variant="secondary">+1m</Button>
                <Button onClick={() => handleAdjustTime(300)} variant="secondary">+5m</Button>

                <Button onClick={handleResetTimer} variant="danger">
                  {t('control.reset')}
                </Button>
              </div>
            </div>
          </Card>

          {/* Info Grid */}
          <div className="control-stats-grid">
            <Card className="control-stat-card">
              <div className="stat-label">{t('control.level')}</div>
              <div className="stat-value">{timerState?.current_level || 1}</div>
            </Card>

            {!isBreak && currentBlind && (
              <Card className="control-stat-card">
                <div className="stat-label">BLINDS</div>
                <div className="stat-value blinds-display">
                  {currentBlind.small_blind}/{currentBlind.big_blind}
                </div>
                {currentBlind.ante > 0 && (
                  <div className="stat-sub">Ante: {currentBlind.ante}</div>
                )}
              </Card>
            )}

            {nextBlind && (
              <Card className="control-stat-card next-level-card">
                <div className="stat-label">
                  {nextBlind.is_break ? 'PRÓXIMO: INTERVALO' : 'PRÓXIMO NÍVEL'}
                </div>
                <div className="stat-value next-blinds">
                  {nextBlind.is_break
                    ? `${nextBlind.duration}min`
                    : `${nextBlind.small_blind}/${nextBlind.big_blind}`
                  }
                </div>
                {nextBlind.ante > 0 && !nextBlind.is_break && (
                  <div className="stat-sub">Ante: {nextBlind.ante}</div>
                )}
              </Card>
            )}

            {timerState?.next_break && (
              <Card className="control-stat-card break-countdown-card">
                <div className="stat-label">INTERVALO EM</div>
                <div className="stat-value break-time">
                  {formatTimeHuman(timerState.next_break.time_until_break)}
                </div>
              </Card>
            )}
          </div>

          {/* Players & Eliminations Section */}
          <Card className="elimination-card">
            <div className="elimination-section">
              <div className="elimination-stats">
                <div className="elimination-stat">
                  <div className="elimination-stat-label">ENTRADAS</div>
                  <div className="elimination-stat-value entries">{totalEntries}</div>
                </div>
                <div className="elimination-stat-operator">-</div>
                <div className="elimination-stat">
                  <div className="elimination-stat-label">ELIMINAÇÕES</div>
                  <div className="elimination-stat-value eliminations">{eliminationsCount}</div>
                </div>
                <div className="elimination-stat-operator">=</div>
                <div className="elimination-stat">
                  <div className="elimination-stat-label">JOGADORES ATIVOS</div>
                  <div className="elimination-stat-value active">{activePlayersCount}</div>
                </div>
              </div>

              <div className="elimination-controls">
                <Button
                  onClick={() => handleEliminate(-1)}
                  variant="secondary"
                  disabled={eliminationsCount <= 0}
                >
                  Desfazer 1
                </Button>
                <Button
                  onClick={() => handleEliminate(1)}
                  variant="danger"
                >
                  Eliminar 1
                </Button>
                <div className="bulk-elimination">
                  <input
                    type="number"
                    min="1"
                    placeholder="Qtd"
                    value={bulkCount}
                    onChange={(e) => setBulkCount(e.target.value)}
                    className="bulk-input"
                    onKeyDown={(e) => e.key === 'Enter' && handleBulkEliminate()}
                  />
                  <Button
                    onClick={handleBulkEliminate}
                    variant="danger"
                    disabled={!bulkCount || parseInt(bulkCount) <= 0}
                  >
                    Eliminar em massa
                  </Button>
                </div>
              </div>
            </div>
          </Card>
        </div>
      </main>
    </div>
  );
};

export default TournamentControl;
