import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import Breadcrumb from '../components/Breadcrumb';
import Card from '../components/Card';
import Button from '../components/Button';
import { useTimerSync, formatTime, formatTimeHuman } from '../hooks/useTimerSync';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { usePermissions } from '../contexts/PermissionContext';
import { offlineWrite } from '../offline/apiOffline';
import { uuid } from '../offline/db';
import { nivelExibido } from '../utils/nivelExibido';
import { MODO_MESA, useModoDeEliminacao } from '../hooks/useModoDeEliminacao';
import './TournamentControl.css';

const TournamentControl = () => {
  const { dayId } = useParams();
  const { t } = useTranslation();

  const { confirm, toast } = useToast();
  const { isAdmin, hasPermission } = usePermissions();
  const [day, setDay] = useState(null);
  const [loading, setLoading] = useState(true);
  const [bulkCount, setBulkCount] = useState('');
  // Estrutura de blinds em cache: é ela que deixa o relógio virar de nível
  // sozinho quando a internet cai no meio do torneio.
  const [blinds, setBlinds] = useState([]);
  // Bloqueio de vendas do dia: é aqui que o diretor está durante o evento, e é
  // ele quem decide a hora de encerrar o registro tardio.
  const [showSalesBlock, setShowSalesBlock] = useState(false);
  const [blockReason, setBlockReason] = useState('');

  // Acessibilidade: o fundo escuro fecha no clique, mas quem usa só o teclado
  // precisa do Esc para sair do modal.
  useEffect(() => {
    if (!showSalesBlock) return undefined;
    const onKeyDown = (ev) => {
      if (ev.key === 'Escape') setShowSalesBlock(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [showSalesBlock]);

  // Mesma condição do servidor (CashboxService.can_admin, exigido em
  // routers/tournament_days.py e routers/stages.py). Com 'financial' na lista,
  // o botão aparecia para quem o backend recusa: o usuário clicava em "Encerrar
  // vendas" no meio do evento, levava "Sem permissão para bloquear vendas" e
  // ficava sem saber se a trava valeu ou não.
  const podeBloquear = isAdmin || hasPermission('cashbox.admin');

  // Como o diretor elimina, escolhido na criação do torneio. Por MESA, o
  // contador é a contagem dos jogadores eliminados no assento: os botões em
  // massa somem e o caminho é a tela de mesas. Enquanto o modo não chega,
  // nenhum dos dois aparece — oferecer o botão errado por um instante é
  // convite ao clique que o servidor vai recusar.
  const modo = useModoDeEliminacao(day?.tournament_id);
  const porMesa = modo === MODO_MESA;
  const modoConhecido = modo !== null || !day?.tournament_id;

  // SINGLE SOURCE OF TRUTH - enriched timer from backend
  const {
    timerState,
    triggerRefetch: refetchTimer,
    applyOptimistic,
    applyLocalCommand,
    broadcastCommand,
    isOffline,
    isLoading: timerLoading,
  } = useTimerSync(dayId, blinds);

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

  // Carrega a estrutura de blinds em separado: se ela falhar, a tela do relógio
  // (que é o que o salão está vendo) não pode ficar presa em "carregando".
  useEffect(() => {
    let vivo = true;
    api.get(`/tournament-days/${dayId}/blinds`, { _silentError: true })
      .then((res) => {
        if (vivo && Array.isArray(res?.data)) {
          setBlinds([...res.data].sort((a, b) => a.level - b.level));
        }
      })
      .catch(() => { /* sem estrutura em cache o relógio ainda funciona online */ });
    return () => { vivo = false; };
  }, [dayId]);

  // Play/pause: a UI otimista vira o relógio na HORA a cada clique. O comando de
  // rede usa debounce LEADING-EDGE: o primeiro toque é enviado IMEDIATAMENTE (para
  // a tela espectadora/Broadcast refletir o quanto antes, sem os 300ms de espera),
  // e toques rápidos subsequentes são coalescidos — um envio "trailing" garante que
  // o ESTADO FINAL foi persistido. Assim: 1 clique = 1 POST na hora; rajada = no
  // máximo 2 POST (primeiro + final), sem empilhar.
  const pauseCmdRef = useRef({ timer: null, desired: null, lastSent: null, lastClickAt: 0 });

  const scheduleToggle = useCallback((paused) => {
    // Envia primeiro (captura o `remaining` atual e o compartilha) e congela/retoma
    // o Controle no MESMO valor — assim todas as telas mostram exatamente o mesmo.
    const cmd = broadcastCommand({ is_paused: paused });
    applyOptimistic(cmd);

    const sendNow = () => {
      const target = pauseCmdRef.current.desired;
      pauseCmdRef.current.lastSent = target;
      const action = target ? 'pause' : 'start';
      offlineWrite({
        kind: 'timer', method: 'post',
        url: `/tournament-days/${dayId}/timer/${action}`,
        body: { day_id: dayId, action },
        clientMutationId: uuid(),
        synthetic: { ok: true },
      })
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

  // Comando de timer com fallback offline: enfileira (o display já usa o relógio
  // ancorado local). body carrega day_id+action p/ o /sync/batch reexecutar.
  //
  // Quando `offlineWrite` devolve offline:true o comando NÃO chegou ao servidor —
  // ficou na fila. Nesse caso aplicamos a mudança nesta tela na hora e avisamos o
  // operador. Sem isso acontecia o que o cliente relatou: mudar o blind sem
  // internet e o relógio do telão simplesmente travar, sem ninguém entender por
  // quê, até a rede voltar. Decidimos pelo EFEITO (a escrita foi enfileirada) e
  // não por um marcador de conectividade, que pode estar atrasado.
  const timerCmd = async (action, extra = {}) => {
    const res = await offlineWrite({
      kind: 'timer', method: 'post',
      url: `/tournament-days/${dayId}/timer/${action}`,
      body: { day_id: dayId, action, ...extra },
      clientMutationId: uuid(),
      synthetic: { ok: true },
    });
    if (res?.offline) {
      const aplicado = applyLocalCommand(action, extra);
      toast.warning(aplicado
        ? t('control.offlineApplied', 'Sem conexão: alteração aplicada só nesta tela e enviada quando a internet voltar')
        : t('control.offlineQueued', 'Sem conexão: comando na fila; a tela atualiza quando a internet voltar'));
    }
    return res;
  };

  const handleNextLevel = async () => {
    try { await timerCmd('next-level'); refetchTimer(); }
    catch (error) { console.error('Error advancing level:', error); }
  };

  const handlePrevLevel = async () => {
    try { await timerCmd('prev-level'); refetchTimer(); }
    catch (error) { console.error('Error going back level:', error); }
  };

  const handleAdjustTime = async (seconds) => {
    try { await timerCmd('adjust', { seconds }); refetchTimer(); }
    catch (error) { console.error('Error adjusting timer:', error); }
  };

  const handleResetTimer = async () => {
    const ok = await confirm(t('control.confirmReset'), { variant: 'danger', confirmText: t('control.reset') });
    if (!ok) return;
    try { await timerCmd('reset'); refetchTimer(); }
    catch (error) { console.error('Error resetting timer:', error); }
  };

  // Elimination counter functions
  const handleEliminate = async (count) => {
    try {
      await offlineWrite({
        kind: 'elim-counter', method: 'post',
        url: `/tournament-days/${dayId}/eliminations`,
        body: { day_id: dayId, count },
        clientMutationId: uuid(),
        synthetic: { ok: true },
      });
      refetchTimer();
    } catch (error) {
      console.error('Error adjusting eliminations:', error);
      // Ex.: torneio que elimina pelas mesas (409 `eliminacao_por_mesa`).
      if (error?.userMessage) toast.error(error.userMessage);
    }
  };

  // Liga/desliga a venda de entradas do dia. Explícito (blocked: true/false) e
  // não um toggle: com dois admins na tela, um toggle acabaria reliberando a
  // venda que o outro acabou de encerrar.
  const enviarBloqueio = async (blocked, reason) => {
    try {
      await api.post(`/tournament-days/${dayId}/sales-block`, { blocked, reason: reason || null });
      setShowSalesBlock(false);
      setBlockReason('');
      loadData();
      toast.success(
        blocked
          ? t('sales.blockedDone', 'Vendas encerradas para este dia')
          : t('sales.unblockedDone', 'Vendas liberadas para este dia')
      );
    } catch (error) {
      toast.error(
        error.userMessage || error.response?.data?.detail
        || t('sales.blockError', 'Não foi possível alterar o bloqueio de vendas')
      );
    }
  };

  const handleUnblockSales = async () => {
    const ok = await confirm(
      t('sales.confirmUnblock', 'Liberar novamente a venda de entradas deste dia?')
    );
    if (!ok) return;
    enviarBloqueio(false);
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
  // Reentradas = recompras (add-on fica fora). Não entram na conta acima:
  // cada uma já desfez uma eliminação quando foi vendida.
  const totalReentries = timerState?.total_reentries || 0;

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        {/* Sem isto o operador entrava na tela de controle e não tinha saída a
            não ser o menu lateral. Mesma trilha das outras telas do torneio. */}
        <Breadcrumb items={[
          { label: t('common.home'), to: '/' },
          { label: t('tournaments.title'), to: '/torneios' },
          ...(day?.tournament_id
            ? [{
              label: day.tournament_name || t('control.breadcrumbTournament', 'Torneio'),
              to: `/torneios/${day.tournament_id}`,
            }]
            : []),
          { label: t('control.breadcrumbControl', 'Controle') },
        ]} />
        <div className="tournament-control">
          <div className="control-header">
            <h1>{day?.day_name}</h1>
            <div className="day-status">
              <span className={`status-badge ${day?.status}`}>
                {t(`common.${day?.status}`)}
              </span>
              {podeBloquear && (
                day?.sales_blocked ? (
                  <Button variant="secondary" onClick={handleUnblockSales}>
                    {t('sales.unblockDay', 'Liberar vendas')}
                  </Button>
                ) : (
                  <Button variant="danger" onClick={() => setShowSalesBlock(true)}>
                    {t('sales.blockDay', 'Encerrar vendas')}
                  </Button>
                )
              )}
            </div>
          </div>

          {/* O operador do Caixa precisa saber POR QUE parou de vender. */}
          {day?.sales_blocked && (
            <Card className="control-stat-card">
              <div className="stat-label">{t('sales.blocked', 'Vendas encerradas')}</div>
              <div className="stat-sub">{day.sales_blocked_reason || '—'}</div>
            </Card>
          )}

          {showSalesBlock && (
            <div
              className="modal-overlay"
              role="presentation"
              onClick={(e) => { if (e.target === e.currentTarget) setShowSalesBlock(false); }}
            >
              <div className="modal" role="dialog" aria-modal="true">
                <div className="modal-header">
                  <h2>{t('sales.blockDay', 'Encerrar vendas')}</h2>
                </div>
                <div className="modal-body">
                  <div className="form-group">
                    <label htmlFor="sales_block_reason">
                      {t('sales.blockReason', 'Motivo (aparece para o operador do Caixa)')}
                    </label>
                    <input
                      id="sales_block_reason"
                      type="text"
                      value={blockReason}
                      onChange={(e) => setBlockReason(e.target.value)}
                      placeholder={t('sales.blockReasonPlaceholder', 'Ex.: registro tardio encerrado')}
                    />
                  </div>
                </div>
                <div className="modal-actions">
                  <Button variant="secondary" onClick={() => setShowSalesBlock(false)}>
                    {t('common.cancel')}
                  </Button>
                  <Button variant="danger" onClick={() => enviarBloqueio(true, blockReason.trim())}>
                    {t('sales.confirmBlock', 'Encerrar vendas')}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* Timer Display */}
          <Card className="timer-card">
            <div className="timer-display">
              {/* O relógio continua rodando ancorado localmente. Dizer isso é o
                  que separa "está sem internet" de "o sistema travou". */}
              {isOffline && (
                <output className="timer-offline-badge">
                  {t('control.offlineClock', 'Sem conexão — relógio rodando nesta tela')}
                </output>
              )}
              {isBreak ? (
                <div className="timer-break-indicator">
                  <div className="break-label-control">{t('control.break')}</div>
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
              <div className="stat-value">{nivelExibido(timerState, blinds, timerState?.current_level) || 1}</div>
            </Card>

            {!isBreak && currentBlind && (
              <Card className="control-stat-card">
                <div className="stat-label">{t('control.blinds')}</div>
                <div className="stat-value blinds-display">
                  {currentBlind.small_blind}/{currentBlind.big_blind}
                </div>
                {currentBlind.ante > 0 && (
                  <div className="stat-sub">{t('control.anteValue', { ante: currentBlind.ante })}</div>
                )}
              </Card>
            )}

            {nextBlind && (
              <Card className="control-stat-card next-level-card">
                <div className="stat-label">
                  {nextBlind.is_break ? t('control.nextBreak') : t('control.nextLevel')}
                </div>
                <div className="stat-value next-blinds">
                  {nextBlind.is_break
                    ? t('control.durationMin', { min: nextBlind.duration })
                    : `${nextBlind.small_blind}/${nextBlind.big_blind}`
                  }
                </div>
                {nextBlind.ante > 0 && !nextBlind.is_break && (
                  <div className="stat-sub">{t('control.anteValue', { ante: nextBlind.ante })}</div>
                )}
              </Card>
            )}

            {timerState?.next_break && (
              <Card className="control-stat-card break-countdown-card">
                <div className="stat-label">{t('control.intervalIn').toUpperCase()}</div>
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
                  <div className="elimination-stat-label">{t('control.entries').toUpperCase()}</div>
                  <div className="elimination-stat-value entries">{totalEntries}</div>
                </div>
                <div className="elimination-stat-operator">-</div>
                <div className="elimination-stat">
                  <div className="elimination-stat-label">{t('control.eliminations').toUpperCase()}</div>
                  <div className="elimination-stat-value eliminations">{eliminationsCount}</div>
                </div>
                <div className="elimination-stat-operator">=</div>
                <div className="elimination-stat">
                  <div className="elimination-stat-label">{t('control.activePlayers').toUpperCase()}</div>
                  <div className="elimination-stat-value active">{activePlayersCount}</div>
                </div>
                <div className="elimination-stat elimination-stat-extra">
                  <div className="elimination-stat-label">{t('control.reentries').toUpperCase()}</div>
                  <div className="elimination-stat-value reentries">{totalReentries}</div>
                </div>
              </div>

              {porMesa && (
                <div className="elimination-by-table">
                  <p className="elimination-mode-hint">{t('control.eliminationByTableHint')}</p>
                  <Link className="elimination-by-table-link" to={`/alocacao/dia/${dayId}`}>
                    {t('control.eliminateAtTables')}
                  </Link>
                </div>
              )}

              {modoConhecido && !porMesa && (
              <div className="elimination-controls">
                <Button
                  onClick={() => handleEliminate(-1)}
                  variant="secondary"
                  disabled={eliminationsCount <= 0}
                >
                  {t('control.undoOne')}
                </Button>
                <Button
                  onClick={() => handleEliminate(1)}
                  variant="danger"
                >
                  {t('control.eliminateOne')}
                </Button>
                <div className="bulk-elimination">
                  <input
                    type="number"
                    min="1"
                    placeholder={t('control.quantityPlaceholder')}
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
                    {t('control.bulkEliminate')}
                  </Button>
                </div>
              </div>
              )}
            </div>
          </Card>
        </div>
      </main>
    </div>
  );
};

export default TournamentControl;
