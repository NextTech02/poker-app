import React, { useState, useEffect, useCallback, useRef } from 'react';
import { usePolling } from '../hooks/usePolling';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { useTranslation } from 'react-i18next';
import { useParams, useNavigate } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import SeatTicket from '../components/SeatTicket';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import './TableManagement.css';

// Fecha só quando o clique caiu no próprio fundo, não em um filho. Substitui o
// `onClick={stopPropagation}` que ficava no conteúdo do modal — aquele era um
// clique sem caminho de teclado, e o fundo em si não é um controle.
const aoClicarNoFundo = (aoFechar) => (evento) => {
  if (evento.target === evento.currentTarget) aoFechar();
};

const TableManagement = () => {
  const { t } = useTranslation();
  const { dayId } = useParams();
  const navigate = useNavigate();
  const { toast, confirm } = useToast();

  // ── State ─────────────────────────────────────────────────────────────────
  const [day, setDay] = useState(null);
  const [tournamentName, setTournamentName] = useState('');
  const [tables, setTables] = useState([]);
  const [allocations, setAllocations] = useState([]);
  const [unallocated, setUnallocated] = useState([]);
  const [loading, setLoading] = useState(true);

  // Drag-and-drop
  const [draggedPlayer, setDraggedPlayer] = useState(null);

  // Modals
  const [showTicket, setShowTicket] = useState(null);
  const [showAddTableModal, setShowAddTableModal] = useState(false);
  const [showBulkModal, setShowBulkModal] = useState(false);

  // Esc fecha o modal aberto — o clique no fundo é gesto de mouse, e quem opera
  // a mesa só pelo teclado precisa de uma saída equivalente.
  const fecharTicket = useCallback(() => setShowTicket(null), []);
  const fecharAddTable = useCallback(() => setShowAddTableModal(false), []);
  const fecharBulk = useCallback(() => setShowBulkModal(false), []);
  useEscapeKey(!!showTicket, fecharTicket);
  useEscapeKey(showAddTableModal, fecharAddTable);
  useEscapeKey(showBulkModal, fecharBulk);

  // Add table form
  const [newTableSeats, setNewTableSeats] = useState(9);
  const [newTableCount, setNewTableCount] = useState(1);

  // Bulk allocation
  const [bulkMode, setBulkMode] = useState('balanced');
  const [bulkLoading, setBulkLoading] = useState(false);
  const modeInitialized = useRef(false);

  // Lock state (derived from day)
  const tablesLocked = day?.tables_locked ?? false;

  // ── Data Loading ──────────────────────────────────────────────────────────
  const loadData = useCallback(async () => {
    try {
      const [dayRes, tablesRes, allocRes, unallocRes] = await Promise.all([
        api.get(`/tournament-days/${dayId}`),
        api.get(`/tables/day/${dayId}`),
        api.get(`/allocations/day/${dayId}`),
        api.get(`/allocations/day/${dayId}/unallocated`),
      ]);
      const dayData = dayRes.data;
      setDay(dayData);
      setTables(tablesRes.data);
      setAllocations(allocRes.data);
      setUnallocated(unallocRes.data);
      setLoading(false);

      // Initialize bulk mode from day's saved allocation_mode (only on first load)
      if (!modeInitialized.current && dayData?.allocation_mode) {
        setBulkMode(dayData.allocation_mode);
        modeInitialized.current = true;
      }

      // Fetch tournament name if not yet loaded
      if (dayData?.tournament_id && !tournamentName) {
        try {
          const tRes = await api.get(`/tournaments/${dayData.tournament_id}`);
          setTournamentName(tRes.data.name || '');
        } catch (_) { /* non-fatal */ }
      }
    } catch (err) {
      console.error('Erro ao carregar dados:', err);
      setLoading(false);
    }
  }, [dayId, tournamentName]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Polling de 5s que pausa quando a aba está oculta.
  usePolling(loadData, 5000);

  // ── Lock Toggle ───────────────────────────────────────────────────────────
  const handleToggleLock = async () => {
    const action = tablesLocked ? t('tableManagement.actionUnlock') : t('tableManagement.actionLock');
    const msg = tablesLocked
      ? t('tableManagement.confirmUnlock')
      : t('tableManagement.confirmLock');
    const ok = await confirm(msg, { confirmText: action });
    if (!ok) return;
    try {
      await api.post(`/tournament-days/${dayId}/tables-lock`);
      await loadData();
      toast.success(tablesLocked ? t('tableManagement.tablesUnlockedSuccess') : t('tableManagement.tablesLockedSuccess'));
    } catch (err) {
      toast.error(t('tableManagement.errorToggleLock', { detail: err.response?.data?.detail || err.message }));
    }
  };

  // ── Add Tables ────────────────────────────────────────────────────────────
  const handleAddTables = async () => {
    try {
      if (newTableCount === 1) {
        const nextNum = tables.length > 0 ? Math.max(...tables.map(t => t.table_number)) + 1 : 1;
        await api.post(`/tables/day/${dayId}`, { table_number: nextNum, seats: newTableSeats });
      } else {
        await api.post(`/tables/day/${dayId}/bulk?count=${newTableCount}&seats=${newTableSeats}`);
      }
      await loadData();
      setShowAddTableModal(false);
      toast.success(newTableCount > 1
        ? t('tableManagement.tablesAddedSuccessPlural', { count: newTableCount })
        : t('tableManagement.tablesAddedSuccessSingular'));
    } catch (err) {
      toast.error(t('tableManagement.errorAddTable', { detail: err.response?.data?.detail || err.message }));
    }
  };

  // ── Remove / Disable Table ────────────────────────────────────────────────
  const handleRemoveTable = async (table) => {
    const hasPlayers = allocations.some(a => a.table_id === table.id);
    if (hasPlayers) {
      toast.warning(t('tableManagement.cannotRemoveTableWithPlayers'));
      return;
    }
    const ok = await confirm(t('tableManagement.confirmRemoveTable', { number: table.table_number }), { variant: 'danger', confirmText: t('common.remove') });
    if (!ok) return;
    try {
      await api.delete(`/tables/${table.id}`);
      await loadData();
      toast.success(t('tableManagement.tableRemovedSuccess', { number: table.table_number }));
    } catch (err) {
      toast.error(t('tableManagement.errorRemoveTable', { detail: err.response?.data?.detail || err.message }));
    }
  };

  const handleToggleTableStatus = async (table) => {
    const newStatus = table.status === 'active' ? 'closed' : 'active';
    const label = newStatus === 'closed' ? t('tableManagement.actionDeactivate') : t('tableManagement.actionReactivate');
    const ok = await confirm(t('tableManagement.confirmToggleTableStatus', { label, number: table.table_number }), { confirmText: label });
    if (!ok) return;
    try {
      await api.patch(`/tables/${table.id}`, { status: newStatus });
      await loadData();
    } catch (err) {
      toast.error(t('tableManagement.errorToggleTableStatus', { detail: err.response?.data?.detail || err.message }));
    }
  };

  // ── Bulk Allocation ───────────────────────────────────────────────────────
  const handleSaveMode = async () => {
    try {
      await api.patch(`/tournament-days/${dayId}`, { allocation_mode: bulkMode });
      const modeLabels = { sequential: t('tableManagement.modeLabelSequential'), balanced: t('tableManagement.modeLabelBalanced'), random_balanced: t('tableManagement.modeLabelRandomBalanced') };
      toast.success(t('tableManagement.modeSetSuccess', { mode: modeLabels[bulkMode] || bulkMode }));
      setShowBulkModal(false);
    } catch (err) {
      toast.error(t('tableManagement.errorSaveMode', { detail: err.response?.data?.detail || err.message }));
    }
  };

  const handleBulkAllocate = async () => {
    setBulkLoading(true);
    try {
      // Persist the selected mode so individual buy-ins also use it
      await api.patch(`/tournament-days/${dayId}`, { allocation_mode: bulkMode });

      const res = await api.post(`/allocations/day/${dayId}/bulk`, {
        mode: bulkMode,
        player_ids: [],
      });
      await loadData();
      setShowBulkModal(false);
      toast.success(t('tableManagement.bulkAllocateSuccess', { count: res.data.length }));
    } catch (err) {
      toast.error(t('tableManagement.errorBulkAllocate', { detail: err.response?.data?.detail || err.message }));
    } finally {
      setBulkLoading(false);
    }
  };

  // ── Drag and Drop ─────────────────────────────────────────────────────────
  const handleDragStart = (e, player, isAllocated = false, allocationId = null) => {
    setDraggedPlayer({ ...player, isAllocated, allocationId });
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDropToUnallocated = async (e) => {
    e.preventDefault();
    if (!draggedPlayer || !draggedPlayer.isAllocated) { setDraggedPlayer(null); return; }
    try {
      await api.delete(`/allocations/${draggedPlayer.allocationId}`);
      await loadData();
    } catch (err) {
      toast.error(t('tableManagement.errorUnallocate', { detail: err.response?.data?.detail || err.message }));
    } finally {
      setDraggedPlayer(null);
    }
  };

  const handleDropToSeat = async (e, tableId, seatNumber) => {
    e.preventDefault();
    if (!draggedPlayer) return;

    const isOccupied = allocations.some(a => a.table_id === tableId && a.seat_number === seatNumber);
    if (isOccupied) { toast.warning(t('tableManagement.seatOccupied')); return; }

    try {
      if (draggedPlayer.isAllocated && draggedPlayer.allocationId) {
        // Move player to new seat
        await api.patch(`/allocations/${draggedPlayer.allocationId}`, {
          table_id: tableId,
          seat_number: seatNumber,
        });
        const updated = await api.get(`/allocations/${draggedPlayer.allocationId}`);
        setShowTicket(updated.data);
      } else {
        // New allocation
        const res = await api.post(`/allocations/day/${dayId}/manual`, {
          player_id: draggedPlayer.player_id,
          table_id: tableId,
          seat_number: seatNumber,
        });
        setShowTicket(res.data);
      }
      await loadData();
    } catch (err) {
      toast.error(t('tableManagement.errorAllocate', { detail: err.response?.data?.detail || err.message }));
    } finally {
      setDraggedPlayer(null);
    }
  };

  // ── Alternate Ticket ──────────────────────────────────────────────────────
  const handleShowAlternateTicket = (player) => {
    setShowTicket({
      player_name: player.player_name,
      tournament_name: tournamentName,
      day_name: day?.day_name || '',
      is_alternate: true,
      table_number: null,
      seat_number: null,
      created_at: new Date().toISOString(),
      id: player.player_id,
    });
  };

  // ── Render Helpers ────────────────────────────────────────────────────────
  const getAllocationForSeat = (tableId, seatNum) =>
    allocations.find(a => a.table_id === tableId && a.seat_number === seatNum);

  const renderSeat = (table, seatNum) => {
    const allocation = getAllocationForSeat(table.id, seatNum);
    const occupied = !!allocation;
    const inactive = table.status !== 'active';

    return (
      <div
        key={seatNum}
        className={`tm-seat ${occupied ? 'occupied' : 'empty'} ${inactive ? 'inactive' : ''} ${draggedPlayer && !occupied && !inactive ? 'droppable' : ''}`}
        onDragOver={!occupied && !inactive ? handleDragOver : undefined}
        onDrop={!occupied && !inactive ? (e) => handleDropToSeat(e, table.id, seatNum) : undefined}
      >
        <span className="tm-seat-num">{seatNum}</span>
        {occupied ? (
          <div
            className="tm-seat-player"
            draggable
            onDragStart={(e) => handleDragStart(e, { player_id: allocation.player_id, player_name: allocation.players?.name }, true, allocation.id)}
            title={allocation.players?.name}
          >
            <svg className="tm-player-icon-svg" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/>
            </svg>
          </div>
        ) : (
          <span className="tm-seat-empty">{inactive ? '—' : t('tableManagement.seatEmpty')}</span>
        )}
      </div>
    );
  };

  const renderTable = (table) => {
    const seats = [];
    for (let i = 1; i <= table.seats; i++) seats.push(renderSeat(table, i));
    const occupied = allocations.filter(a => a.table_id === table.id).length;
    const isInactive = table.status !== 'active';

    return (
      <div key={table.id} className={`tm-table ${isInactive ? 'tm-table-inactive' : ''}`}>
        <div className="tm-table-header">
          <div className="tm-table-title">
            <span className="tm-table-num">{t('tableManagement.tableTitle', { number: table.table_number })}</span>
            {isInactive && <span className="tm-badge-closed">{table.status === 'closed' ? t('tableManagement.badgeClosed') : t('tableManagement.badgeBroken')}</span>}
          </div>
          <div className="tm-table-meta">
            <span className="tm-occupancy">{occupied}/{table.seats}</span>
            <button
              className={`tm-btn-icon ${isInactive ? 'btn-green' : 'btn-orange'}`}
              title={isInactive ? t('tableManagement.reactivateTable') : t('tableManagement.closeTable')}
              onClick={() => handleToggleTableStatus(table)}
            >{isInactive ? t('tableManagement.activate') : t('tableManagement.close')}</button>
            {occupied === 0 && (
              <button
                className="tm-btn-icon btn-red"
                title={t('tableManagement.removeTable')}
                onClick={() => handleRemoveTable(table)}
              >{t('common.remove')}</button>
            )}
          </div>
        </div>
        <div className="tm-seats-grid">
          {seats}
        </div>
      </div>
    );
  };

  // ── Main Render ───────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="app-container">
        <Sidebar />
        <main className="main-content"><div className="loading">{t('common.loading')}</div></main>
      </div>
    );
  }

  const totalSeats = tables.filter(t => t.status === 'active').reduce((s, t) => s + t.seats, 0);
  const totalOccupied = allocations.length;

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content tm-page">

        {/* ── Header ── */}
        <div className="tm-header">
          <div className="tm-header-left">
            <h1 className="tm-title">{t('tableManagement.title')}</h1>
            <p className="tm-subtitle">
              {t('tableManagement.subtitleSeats', { dayName: day?.day_name, occupied: totalOccupied, total: totalSeats })}
              {unallocated.length > 0 && (
                <span className={`tm-badge-alt ${tablesLocked ? 'locked' : ''}`}>
                  {unallocated.length} {tablesLocked ? t('tableManagement.badgeAlternate') : t('tableManagement.badgeNoTable')}
                </span>
              )}
            </p>
          </div>
          <div className="tm-header-actions">
            <button
              className={`tm-btn-lock ${tablesLocked ? 'locked' : 'unlocked'}`}
              onClick={handleToggleLock}
              title={tablesLocked ? t('tableManagement.tablesLockedTooltip') : t('tableManagement.tablesOpenTooltip')}
            >
              {tablesLocked ? t('tableManagement.tablesLocked') : t('tableManagement.tablesOpen')}
            </button>
            <button className="tm-btn-secondary" onClick={() => setShowBulkModal(true)}>
              {t('tableManagement.bulkAllocate')}
            </button>
            <button className="tm-btn-secondary" onClick={() => setShowAddTableModal(true)}>
              {t('tableManagement.addTable')}
            </button>
            <button className="tm-btn-back" onClick={() => navigate(-1)}>
              {t('tableManagement.back')}
            </button>
          </div>
        </div>

        {/* ── Layout ── */}
        <div className="tm-layout">

          {/* Players / Alternates panel */}
          <div className="tm-players-panel">
            <div className="tm-panel-header">
              <h2 className="tm-panel-title">
                {tablesLocked ? t('tableManagement.panelAlternates') : t('tableManagement.panelNoTable')}
              </h2>
              <span className="tm-count-badge">{unallocated.length}</span>
            </div>
            {tablesLocked && (
              <p className="tm-alt-hint">
                {t('tableManagement.altHint')}
              </p>
            )}
            <div
              className="tm-players-list"
              onDragOver={handleDragOver}
              onDrop={handleDropToUnallocated}
            >
              {unallocated.length === 0 ? (
                <div className="tm-empty-list">
                  {tablesLocked
                    ? t('tableManagement.noAlternates')
                    : t('tableManagement.allPlayersAllocated')}
                </div>
              ) : (
                unallocated.map((p) => (
                  <div
                    key={p.player_id}
                    className={`tm-player-card ${tablesLocked ? 'alternate' : ''}`}
                    draggable
                    onDragStart={(e) => handleDragStart(e, p)}
                  >
                    <div className="tm-player-info">
                      <span className="tm-player-name">{p.player_name}</span>
                    </div>
                    {tablesLocked && (
                      <button
                        className="tm-btn-print-alt"
                        title={t('tableManagement.printAlternateTicket')}
                        onClick={() => handleShowAlternateTicket(p)}
                      >{t('tableManagement.print')}</button>
                    )}
                    {!tablesLocked && (
                      <span className="tm-drag-hint">{t('tableManagement.dragHint')}</span>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Tables panel */}
          <div className="tm-tables-panel">
            {tables.length === 0 ? (
              <div className="tm-no-tables">
                <p>{t('tableManagement.noTablesRegistered')}</p>
                <button className="tm-btn-secondary" onClick={() => setShowAddTableModal(true)}>
                  {t('tableManagement.addFirstTable')}
                </button>
              </div>
            ) : (
              <div className="tm-tables-grid">
                {tables.map(renderTable)}
              </div>
            )}
          </div>
        </div>

        {/* ── Ticket Modal ── */}
        {showTicket && (
          <div className="tm-modal-overlay" role="presentation" onClick={aoClicarNoFundo(fecharTicket)}>
            <div className="tm-modal">
              <div className="tm-modal-header">
                <h3>{showTicket.is_alternate ? t('tableManagement.ticketAlternate') : t('tableManagement.playerAllocated')}</h3>
                <button className="tm-close-btn" onClick={() => setShowTicket(null)}>✕</button>
              </div>
              <SeatTicket allocation={showTicket} />
            </div>
          </div>
        )}

        {/* ── Add Table Modal ── */}
        {showAddTableModal && (
          <div className="tm-modal-overlay" role="presentation" onClick={aoClicarNoFundo(fecharAddTable)}>
            <div className="tm-modal tm-modal-sm">
              <div className="tm-modal-header">
                <h3>{t('tableManagement.addTablesModalTitle')}</h3>
                <button className="tm-close-btn" onClick={() => setShowAddTableModal(false)}>✕</button>
              </div>
              <div className="tm-modal-body">
                <div className="tm-form-row">
                  <label>{t('tableManagement.tableCountLabel')}</label>
                  <input
                    type="number" min="1" max="50"
                    value={newTableCount}
                    onChange={(e) => setNewTableCount(Math.max(1, parseInt(e.target.value) || 1))}
                    className="tm-input"
                  />
                </div>
                <div className="tm-form-row">
                  <label>{t('tableManagement.seatsPerTableLabel')}</label>
                  <input
                    type="number" min="2" max="10"
                    value={newTableSeats}
                    onChange={(e) => setNewTableSeats(Math.max(2, Math.min(10, parseInt(e.target.value) || 9)))}
                    className="tm-input"
                  />
                </div>
              </div>
              <div className="tm-modal-actions">
                <button className="tm-btn-secondary" onClick={() => setShowAddTableModal(false)}>{t('common.cancel')}</button>
                <button className="tm-btn-primary" onClick={handleAddTables}>
                  {newTableCount > 1 ? t('tableManagement.addTablesButtonMulti', { count: newTableCount }) : t('tableManagement.addTablesButtonSingle')}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Bulk Allocation Modal ── */}
        {showBulkModal && (
          <div className="tm-modal-overlay" role="presentation" onClick={aoClicarNoFundo(fecharBulk)}>
            <div className="tm-modal tm-modal-sm">
              <div className="tm-modal-header">
                <h3>{t('tableManagement.bulkModalTitle')}</h3>
                <button className="tm-close-btn" onClick={() => setShowBulkModal(false)}>✕</button>
              </div>
              <div className="tm-modal-body">
                <p className="tm-hint-text">
                  {t('tableManagement.bulkModalHint', { count: unallocated.length })}
                </p>
                <div className="tm-mode-select">
                  <label className="tm-mode-label">{t('tableManagement.distributionMode')}</label>
                  <div className="tm-mode-options">
                    {[
                      { value: 'sequential', label: t('tableManagement.modeSequentialLabel'), desc: t('tableManagement.modeSequentialDesc') },
                      { value: 'balanced', label: t('tableManagement.modeBalancedLabel'), desc: t('tableManagement.modeBalancedDesc') },
                      { value: 'random_balanced', label: t('tableManagement.modeRandomBalancedLabel'), desc: t('tableManagement.modeRandomBalancedDesc') },
                    ].map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        className={`tm-mode-card ${bulkMode === opt.value ? 'selected' : ''}`}
                        aria-pressed={bulkMode === opt.value}
                        onClick={() => setBulkMode(opt.value)}
                      >
                        <div className="tm-mode-radio">
                          <div className={`tm-radio-dot ${bulkMode === opt.value ? 'active' : ''}`} />
                        </div>
                        <div>
                          <div className="tm-mode-name">{opt.label}</div>
                          <div className="tm-mode-desc">{opt.desc}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="tm-modal-actions">
                <button className="tm-btn-secondary" onClick={() => setShowBulkModal(false)}>{t('common.cancel')}</button>
                <button
                  className="tm-btn-outline"
                  onClick={handleSaveMode}
                  disabled={bulkLoading}
                  title={t('tableManagement.setModeTooltip')}
                >
                  {t('tableManagement.setMode')}
                </button>
                <button
                  className="tm-btn-primary"
                  onClick={handleBulkAllocate}
                  disabled={bulkLoading || unallocated.length === 0}
                  title={unallocated.length === 0 ? t('tableManagement.noPlayersWithoutTable') : t('tableManagement.allocatePlayersTooltip', { count: unallocated.length })}
                >
                  {bulkLoading ? t('tableManagement.allocating') : t('tableManagement.allocatePlayersButton', { count: unallocated.length })}
                </button>
              </div>
            </div>
          </div>
        )}

      </main>
    </div>
  );
};

export default TableManagement;
