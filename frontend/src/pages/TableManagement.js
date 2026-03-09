import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import SeatTicket from '../components/SeatTicket';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import './TableManagement.css';

const TableManagement = () => {
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
    const interval = setInterval(loadData, 5000);
    return () => clearInterval(interval);
  }, [loadData]);

  // ── Lock Toggle ───────────────────────────────────────────────────────────
  const handleToggleLock = async () => {
    const action = tablesLocked ? 'DESBLOQUEAR' : 'BLOQUEAR';
    const msg = tablesLocked
      ? 'Desbloquear mesas? Novos buy-ins voltarão a receber assento automático.'
      : 'Bloquear mesas? Novos buy-ins entrarão como ALTERNATE até serem alocados manualmente.';
    const ok = await confirm(msg, { confirmText: action });
    if (!ok) return;
    try {
      await api.post(`/tournament-days/${dayId}/tables-lock`);
      await loadData();
      toast.success(tablesLocked ? 'Mesas desbloqueadas.' : 'Mesas bloqueadas. Novos jogadores entrarão como alternates.');
    } catch (err) {
      toast.error('Erro ao alterar bloqueio: ' + (err.response?.data?.detail || err.message));
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
      toast.success(`${newTableCount > 1 ? newTableCount + ' mesas adicionadas' : 'Mesa adicionada'} com sucesso!`);
    } catch (err) {
      toast.error('Erro ao adicionar mesa: ' + (err.response?.data?.detail || err.message));
    }
  };

  // ── Remove / Disable Table ────────────────────────────────────────────────
  const handleRemoveTable = async (table) => {
    const hasPlayers = allocations.some(a => a.table_id === table.id);
    if (hasPlayers) {
      toast.warning('Não é possível remover uma mesa com jogadores. Mova os jogadores primeiro.');
      return;
    }
    const ok = await confirm(`Remover Mesa ${table.table_number}?`, { variant: 'danger', confirmText: 'Remover' });
    if (!ok) return;
    try {
      await api.delete(`/tables/${table.id}`);
      await loadData();
      toast.success(`Mesa ${table.table_number} removida.`);
    } catch (err) {
      toast.error('Erro ao remover mesa: ' + (err.response?.data?.detail || err.message));
    }
  };

  const handleToggleTableStatus = async (table) => {
    const newStatus = table.status === 'active' ? 'closed' : 'active';
    const label = newStatus === 'closed' ? 'Desativar' : 'Reativar';
    const ok = await confirm(`${label} Mesa ${table.table_number}?`, { confirmText: label });
    if (!ok) return;
    try {
      await api.patch(`/tables/${table.id}`, { status: newStatus });
      await loadData();
    } catch (err) {
      toast.error('Erro ao alterar status da mesa: ' + (err.response?.data?.detail || err.message));
    }
  };

  // ── Bulk Allocation ───────────────────────────────────────────────────────
  const handleSaveMode = async () => {
    try {
      await api.patch(`/tournament-days/${dayId}`, { allocation_mode: bulkMode });
      const modeLabels = { sequential: 'Sequencial', balanced: 'Equilibrado', random_balanced: 'Equilibrado Aleatório' };
      toast.success(`Modo definido: ${modeLabels[bulkMode] || bulkMode}. Novos buy-ins usarão este modo.`);
      setShowBulkModal(false);
    } catch (err) {
      toast.error('Erro ao salvar modo: ' + (err.response?.data?.detail || err.message));
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
      toast.success(`${res.data.length} jogadores alocados com sucesso!`);
    } catch (err) {
      toast.error('Erro na alocação em massa: ' + (err.response?.data?.detail || err.message));
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
      toast.error('Erro ao desalocar: ' + (err.response?.data?.detail || err.message));
    } finally {
      setDraggedPlayer(null);
    }
  };

  const handleDropToSeat = async (e, tableId, seatNumber) => {
    e.preventDefault();
    if (!draggedPlayer) return;

    const isOccupied = allocations.some(a => a.table_id === tableId && a.seat_number === seatNumber);
    if (isOccupied) { toast.warning('Este assento já está ocupado!'); return; }

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
      toast.error('Erro ao alocar jogador: ' + (err.response?.data?.detail || err.message));
    } finally {
      setDraggedPlayer(null);
    }
  };

  // ── Eliminate Player ──────────────────────────────────────────────────────
  const handleEliminatePlayer = async (allocation) => {
    const name = allocation.players?.name || 'este jogador';
    const ok = await confirm(
      `Eliminar ${name} do torneio? Isso removerá o assento e registrará a eliminação.`,
      { variant: 'danger', confirmText: 'Eliminar' }
    );
    if (!ok) return;
    try {
      const tpRes = await api.get(`/tournament-players/tournament/${day.tournament_id}`);
      const tp = tpRes.data.find(p => p.player_id === allocation.player_id);
      if (tp) {
        await api.patch(`/tournament-players/${tp.id}`, {
          status: 'eliminated',
          eliminated_at: new Date().toISOString(),
        });
        await api.post(`/rankings/tournament/${day.tournament_id}/recalculate`);
      }
      await api.delete(`/allocations/${allocation.id}`);
      await loadData();
      toast.success(`${name} eliminado!`);
    } catch (err) {
      toast.error('Erro ao eliminar: ' + (err.response?.data?.detail || err.message));
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
            <button
              className="tm-btn-elim"
              title="Eliminar jogador"
              onClick={() => handleEliminatePlayer(allocation)}
            >✕</button>
          </div>
        ) : (
          <span className="tm-seat-empty">{inactive ? '—' : 'Vazio'}</span>
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
            <span className="tm-table-num">Mesa {table.table_number}</span>
            {isInactive && <span className="tm-badge-closed">{table.status === 'closed' ? 'Fechada' : 'Quebrada'}</span>}
          </div>
          <div className="tm-table-meta">
            <span className="tm-occupancy">{occupied}/{table.seats}</span>
            <button
              className={`tm-btn-icon ${isInactive ? 'btn-green' : 'btn-orange'}`}
              title={isInactive ? 'Reativar mesa' : 'Fechar mesa'}
              onClick={() => handleToggleTableStatus(table)}
            >{isInactive ? 'Ativar' : 'Fechar'}</button>
            {occupied === 0 && (
              <button
                className="tm-btn-icon btn-red"
                title="Remover mesa"
                onClick={() => handleRemoveTable(table)}
              >Remover</button>
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
        <main className="main-content"><div className="loading">Carregando...</div></main>
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
            <h1 className="tm-title">Gestão de Mesas</h1>
            <p className="tm-subtitle">
              {day?.day_name} &bull; {totalOccupied}/{totalSeats} assentos ocupados
              {unallocated.length > 0 && (
                <span className={`tm-badge-alt ${tablesLocked ? 'locked' : ''}`}>
                  {unallocated.length} {tablesLocked ? 'alternate' : 'sem mesa'}
                </span>
              )}
            </p>
          </div>
          <div className="tm-header-actions">
            <button
              className={`tm-btn-lock ${tablesLocked ? 'locked' : 'unlocked'}`}
              onClick={handleToggleLock}
              title={tablesLocked ? 'Mesas bloqueadas — clique para desbloquear' : 'Mesas abertas — clique para bloquear'}
            >
              {tablesLocked ? 'Mesas Bloqueadas' : 'Mesas Abertas'}
            </button>
            <button className="tm-btn-secondary" onClick={() => setShowBulkModal(true)}>
              Alocar em Massa
            </button>
            <button className="tm-btn-secondary" onClick={() => setShowAddTableModal(true)}>
              + Adicionar Mesa
            </button>
            <button className="tm-btn-back" onClick={() => navigate(-1)}>
              ← Voltar
            </button>
          </div>
        </div>

        {/* ── Layout ── */}
        <div className="tm-layout">

          {/* Players / Alternates panel */}
          <div className="tm-players-panel">
            <div className="tm-panel-header">
              <h2 className="tm-panel-title">
                {tablesLocked ? 'Alternates' : 'Sem Mesa'}
              </h2>
              <span className="tm-count-badge">{unallocated.length}</span>
            </div>
            {tablesLocked && (
              <p className="tm-alt-hint">
                Mesas bloqueadas. Arraste um alternate para um assento disponível.
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
                    ? 'Nenhum alternate no momento.'
                    : 'Todos os jogadores estão alocados!'}
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
                        title="Imprimir ticket de alternate"
                        onClick={() => handleShowAlternateTicket(p)}
                      >Imprimir</button>
                    )}
                    {!tablesLocked && (
                      <span className="tm-drag-hint">arraste</span>
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
                <p>Nenhuma mesa cadastrada para este dia.</p>
                <button className="tm-btn-secondary" onClick={() => setShowAddTableModal(true)}>
                  + Adicionar Primeira Mesa
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
          <div className="tm-modal-overlay" onClick={() => setShowTicket(null)}>
            <div className="tm-modal" onClick={(e) => e.stopPropagation()}>
              <div className="tm-modal-header">
                <h3>{showTicket.is_alternate ? 'Ticket de Alternate' : 'Jogador Alocado!'}</h3>
                <button className="tm-close-btn" onClick={() => setShowTicket(null)}>✕</button>
              </div>
              <SeatTicket allocation={showTicket} />
            </div>
          </div>
        )}

        {/* ── Add Table Modal ── */}
        {showAddTableModal && (
          <div className="tm-modal-overlay" onClick={() => setShowAddTableModal(false)}>
            <div className="tm-modal tm-modal-sm" onClick={(e) => e.stopPropagation()}>
              <div className="tm-modal-header">
                <h3>Adicionar Mesa(s)</h3>
                <button className="tm-close-btn" onClick={() => setShowAddTableModal(false)}>✕</button>
              </div>
              <div className="tm-modal-body">
                <div className="tm-form-row">
                  <label>Quantidade de mesas</label>
                  <input
                    type="number" min="1" max="50"
                    value={newTableCount}
                    onChange={(e) => setNewTableCount(Math.max(1, parseInt(e.target.value) || 1))}
                    className="tm-input"
                  />
                </div>
                <div className="tm-form-row">
                  <label>Assentos por mesa</label>
                  <input
                    type="number" min="2" max="10"
                    value={newTableSeats}
                    onChange={(e) => setNewTableSeats(Math.max(2, Math.min(10, parseInt(e.target.value) || 9)))}
                    className="tm-input"
                  />
                </div>
              </div>
              <div className="tm-modal-actions">
                <button className="tm-btn-secondary" onClick={() => setShowAddTableModal(false)}>Cancelar</button>
                <button className="tm-btn-primary" onClick={handleAddTables}>
                  Adicionar {newTableCount > 1 ? `${newTableCount} Mesas` : 'Mesa'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Bulk Allocation Modal ── */}
        {showBulkModal && (
          <div className="tm-modal-overlay" onClick={() => setShowBulkModal(false)}>
            <div className="tm-modal tm-modal-sm" onClick={(e) => e.stopPropagation()}>
              <div className="tm-modal-header">
                <h3>Alocação em Massa</h3>
                <button className="tm-close-btn" onClick={() => setShowBulkModal(false)}>✕</button>
              </div>
              <div className="tm-modal-body">
                <p className="tm-hint-text">
                  Escolha o modo de distribuição. Use <strong>Definir Modo</strong> para salvar sem alocar (aplicado em futuros buy-ins), ou <strong>Alocar</strong> para aplicar agora nos <strong>{unallocated.length}</strong> jogadores sem mesa.
                </p>
                <div className="tm-mode-select">
                  <label className="tm-mode-label">Modo de distribuição</label>
                  <div className="tm-mode-options">
                    {[
                      { value: 'sequential', label: 'Sequencial', desc: 'Preenche mesa 1 primeiro, depois mesa 2...' },
                      { value: 'balanced', label: 'Equilibrado', desc: 'Distribui 1 por mesa em rodízio (menor mesa primeiro)' },
                      { value: 'random_balanced', label: 'Equilibrado Aleatório', desc: 'Como equilibrado, mas com assento sorteado' },
                    ].map((opt) => (
                      <div
                        key={opt.value}
                        className={`tm-mode-card ${bulkMode === opt.value ? 'selected' : ''}`}
                        onClick={() => setBulkMode(opt.value)}
                      >
                        <div className="tm-mode-radio">
                          <div className={`tm-radio-dot ${bulkMode === opt.value ? 'active' : ''}`} />
                        </div>
                        <div>
                          <div className="tm-mode-name">{opt.label}</div>
                          <div className="tm-mode-desc">{opt.desc}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div className="tm-modal-actions">
                <button className="tm-btn-secondary" onClick={() => setShowBulkModal(false)}>Cancelar</button>
                <button
                  className="tm-btn-outline"
                  onClick={handleSaveMode}
                  disabled={bulkLoading}
                  title="Salva o modo sem alocar — novos buy-ins usarão este modo"
                >
                  Definir Modo
                </button>
                <button
                  className="tm-btn-primary"
                  onClick={handleBulkAllocate}
                  disabled={bulkLoading || unallocated.length === 0}
                  title={unallocated.length === 0 ? 'Nenhum jogador sem mesa' : `Alocar ${unallocated.length} jogadores sem mesa`}
                >
                  {bulkLoading ? 'Alocando...' : `Alocar ${unallocated.length} Jogadores`}
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
