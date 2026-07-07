import React, { useState, useEffect } from 'react';
import { usePolling } from '../hooks/usePolling';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import SeatTicket from '../components/SeatTicket';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import './ManualAllocation.css';

const ManualAllocation = () => {
  const { t } = useTranslation();
  const { toast, confirm } = useToast();
  const { tournamentId } = useParams();
  const navigate = useNavigate();
  const [tournament, setTournament] = useState(null);
  const [tables, setTables] = useState([]);
  const [allocations, setAllocations] = useState([]);
  const [unallocatedPlayers, setUnallocatedPlayers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [draggedPlayer, setDraggedPlayer] = useState(null);
  const [showTicket, setShowTicket] = useState(null);
  const [showTableModal, setShowTableModal] = useState(false);
  const [newTableSeats, setNewTableSeats] = useState(9);

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tournamentId]);

  // Polling que pausa quando a aba está oculta (era 3s, agora 5s).
  usePolling(() => loadData(), 5000);

  const loadData = async () => {
    try {
      // Load tournament details
      const tournamentRes = await api.get(`/tournaments/${tournamentId}`);
      setTournament(tournamentRes.data);

      // Load tables
      const tablesRes = await api.get(`/tables/tournament/${tournamentId}`);
      setTables(tablesRes.data);

      // Load allocations
      const allocationsRes = await api.get(`/allocations/tournament/${tournamentId}`);
      setAllocations(allocationsRes.data);

      // Load unallocated players
      const unallocatedRes = await api.get(`/allocations/tournament/${tournamentId}/unallocated`);
      setUnallocatedPlayers(unallocatedRes.data);

      setLoading(false);
    } catch (error) {
      console.error('Erro ao carregar dados:', error);
      setLoading(false);
    }
  };

  const handleDragStart = (e, player, isAllocated = false, allocationId = null) => {
    const dragData = {
      ...player,
      isAllocated,
      allocationId
    };
    setDraggedPlayer(dragData);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDropToUnallocated = async (e) => {
    e.preventDefault();

    if (!draggedPlayer) return;

    // If player is already allocated, remove the allocation
    if (draggedPlayer.isAllocated && draggedPlayer.allocationId) {
      try {
        await api.delete(`/allocations/${draggedPlayer.allocationId}`);
        await loadData();
        setDraggedPlayer(null);
      } catch (error) {
        console.error('Erro ao desalocar jogador:', error);
        toast.error(t('manualAllocation.errorUnallocate'));
        setDraggedPlayer(null);
      }
    }
  };

  const handleDrop = async (e, tableId, seatNumber) => {
    e.preventDefault();

    if (!draggedPlayer) return;

    try {
      // Check if seat is occupied
      const isOccupied = allocations.some(
        alloc => alloc.table_id === tableId && alloc.seat_number === seatNumber
      );

      if (isOccupied) {
        toast.warning(t('manualAllocation.seatOccupied'));
        return;
      }

      // If player is already allocated, update allocation (move player)
      if (draggedPlayer.isAllocated && draggedPlayer.allocationId) {
        await api.patch(`/allocations/${draggedPlayer.allocationId}`, {
          table_id: tableId,
          seat_number: seatNumber
        });

        // Get updated allocation details to show ticket
        const updatedAllocation = await api.get(`/allocations/${draggedPlayer.allocationId}`);
        setShowTicket(updatedAllocation.data);
      } else {
        // Allocate new player
        const response = await api.post(`/allocations/tournament/${tournamentId}/manual`, {
          player_id: draggedPlayer.player_id,
          table_id: tableId,
          seat_number: seatNumber
        });

        // Show ticket for new allocations
        setShowTicket(response.data);
      }

      // Reload data
      await loadData();

      setDraggedPlayer(null);
    } catch (error) {
      console.error('Erro ao alocar jogador:', error);
      toast.error(t('manualAllocation.errorAllocate', { detail: error.response?.data?.detail || error.message }));
      setDraggedPlayer(null);
    }
  };

  const handleEliminatePlayer = async (allocation) => {
    const playerName = allocation.players?.name || t('manualAllocation.defaultPlayer');

    const ok = await confirm(t('manualAllocation.confirmEliminate', { name: playerName }), { variant: 'danger', confirmText: t('common.eliminate') });
    if (!ok) return;

    try {
      // Find the tournament player
      const tournamentPlayersRes = await api.get(`/tournament-players/tournament/${tournamentId}`);
      const tournamentPlayer = tournamentPlayersRes.data.find(tp => tp.player_id === allocation.player_id);

      if (tournamentPlayer) {
        // Eliminate player (set status to eliminated with current timestamp)
        await api.patch(`/tournament-players/${tournamentPlayer.id}`, {
          status: 'eliminated',
          eliminated_at: new Date().toISOString(),
          final_position: null  // Will be set by ranking system
        });

        // Recalculate rankings after elimination
        await api.post(`/rankings/tournament/${tournamentId}/recalculate`);
      }

      // Remove allocation
      await api.delete(`/allocations/${allocation.id}`);

      await loadData();
      toast.success(t('manualAllocation.eliminatedSuccess', { name: playerName }));
    } catch (error) {
      console.error('Erro ao eliminar jogador:', error);
      toast.error(t('manualAllocation.errorEliminate', { detail: error.response?.data?.detail || error.message }));
    }
  };

  const handleAddTable = async () => {
    try {
      // Get next table number
      const nextTableNumber = tables.length > 0
        ? Math.max(...tables.map(t => t.table_number)) + 1
        : 1;

      await api.post(`/tables/tournament/${tournamentId}`, {
        table_number: nextTableNumber,
        seats: newTableSeats
      });

      await loadData();
      toast.success(t('manualAllocation.tableAddedSuccess', { number: nextTableNumber }));
    } catch (error) {
      console.error('Erro ao adicionar mesa:', error);
      toast.error(t('manualAllocation.errorAddTable', { detail: error.response?.data?.detail || error.message }));
    }
  };

  const handleRemoveTable = async (tableId, tableNumber) => {
    // Check if table has players
    const hasPlayers = allocations.some(alloc => alloc.table_id === tableId);

    if (hasPlayers) {
      toast.warning(t('manualAllocation.cannotRemoveTableWithPlayers'));
      return;
    }

    const ok = await confirm(t('manualAllocation.confirmRemoveTable', { number: tableNumber }), { variant: 'danger', confirmText: t('common.remove') });
    if (!ok) return;

    try {
      await api.delete(`/tables/${tableId}`);
      await loadData();
      toast.success(t('manualAllocation.tableRemovedSuccess', { number: tableNumber }));
    } catch (error) {
      console.error('Erro ao remover mesa:', error);
      toast.error(t('manualAllocation.errorRemoveTable', { detail: error.response?.data?.detail || error.message }));
    }
  };

  const getAllocationForSeat = (tableId, seatNumber) => {
    return allocations.find(
      alloc => alloc.table_id === tableId && alloc.seat_number === seatNumber
    );
  };

  const renderSeat = (table, seatNumber) => {
    const allocation = getAllocationForSeat(table.id, seatNumber);
    const isOccupied = !!allocation;

    return (
      <div
        key={seatNumber}
        className={`seat ${isOccupied ? 'occupied' : 'empty'} ${draggedPlayer ? 'drop-zone' : ''}`}
        onDragOver={!isOccupied ? handleDragOver : undefined}
        onDrop={!isOccupied ? (e) => handleDrop(e, table.id, seatNumber) : undefined}
      >
        <div className="seat-number">{seatNumber}</div>
        {isOccupied ? (
          <div
            className="seat-player"
            draggable={true}
            onDragStart={(e) => handleDragStart(e, allocation.players, true, allocation.id)}
          >
            <div className="player-name">{allocation.players.name}</div>
            <button
              className="btn-remove-allocation"
              onClick={() => handleEliminatePlayer(allocation)}
              title={t('manualAllocation.eliminatePlayer')}
              aria-label={t('manualAllocation.eliminatePlayer')}
            >
              <span className="close-icon"></span>
            </button>
          </div>
        ) : (
          <div className="seat-empty-label">{t('manualAllocation.empty')}</div>
        )}
      </div>
    );
  };

  const renderTable = (table) => {
    const seats = [];
    for (let i = 1; i <= table.seats; i++) {
      seats.push(renderSeat(table, i));
    }

    const occupiedSeats = allocations.filter(alloc => alloc.table_id === table.id).length;
    const canRemove = occupiedSeats === 0;

    return (
      <div key={table.id} className="table-container">
        <div className="table-header">
          <h3>{t('manualAllocation.tableTitle', { number: table.table_number })}</h3>
          <div className="table-header-actions">
            <span className="table-occupancy">
              {t('manualAllocation.occupiedCount', { occupied: occupiedSeats, total: table.seats })}
            </span>
            {canRemove && (
              <button
                className="btn-remove-table"
                onClick={() => handleRemoveTable(table.id, table.table_number)}
                title={t('manualAllocation.removeTable')}
              >
                🗑️
              </button>
            )}
          </div>
        </div>
        <div className="table-visual">
          <div className="table-felt">
            <div className="seats-grid">
              {seats}
            </div>
          </div>
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="app-container">
        <Sidebar />
        <main className="main-content">
          <div className="loading">{t('common.loading')}</div>
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
            <h1>{t('manualAllocation.title')}</h1>
            <p className="subtitle">
              {t('manualAllocation.subtitle', { name: tournament?.name, count: allocations.length })}
            </p>
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button className="btn-secondary" onClick={() => setShowTableModal(true)}>
              {t('manualAllocation.manageTables')}
            </button>
            <button className="btn-back" onClick={() => navigate('/torneios')}>
              {t('common.back')}
            </button>
          </div>
        </div>

        {showTicket && (
          <div className="ticket-modal-overlay" onClick={() => setShowTicket(null)}>
            <div className="ticket-modal" onClick={(e) => e.stopPropagation()}>
              <div className="ticket-modal-header">
                <h3>{t('manualAllocation.playerAllocatedSuccess')}</h3>
                <button className="close-btn" onClick={() => setShowTicket(null)}>
                  ✕
                </button>
              </div>
              <SeatTicket allocation={showTicket} />
            </div>
          </div>
        )}

        <div className="allocation-layout">
          <div className="players-panel">
            <div className="panel-header">
              <h2>{t('manualAllocation.unallocatedPlayers')}</h2>
              <span className="player-count">{unallocatedPlayers.length}</span>
            </div>
            <div
              className="players-list"
              onDragOver={handleDragOver}
              onDrop={handleDropToUnallocated}
            >
              {unallocatedPlayers.length === 0 ? (
                <div className="no-players">
                  {t('manualAllocation.allPlayersAllocated')}
                </div>
              ) : (
                unallocatedPlayers.map((player) => (
                  <div
                    key={player.player_id}
                    className="player-card"
                    draggable
                    onDragStart={(e) => handleDragStart(e, player)}
                  >
                    <div className="player-card-icon">👤</div>
                    <div className="player-card-name">{player.player_name}</div>
                    <div className="drag-hint">{t('manualAllocation.dragToTable')}</div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="tables-panel">
            {tables.length === 0 ? (
              <div className="no-tables">
                <p>{t('manualAllocation.noTablesRegistered')}</p>
                <p>{t('manualAllocation.addTablesToStart')}</p>
              </div>
            ) : (
              <div className="tables-grid">
                {tables.map((table) => renderTable(table))}
              </div>
            )}
          </div>
        </div>

        {showTableModal && (
          <div className="modal-overlay" onClick={() => setShowTableModal(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>{t('manualAllocation.manageTables')}</h2>
                <button className="close-btn" onClick={() => setShowTableModal(false)}>
                  ✕
                </button>
              </div>
              <div className="modal-body">
                <div className="add-table-section">
                  <h3>{t('manualAllocation.addNewTable')}</h3>
                  <div className="form-group-inline" style={{ display: 'flex', gap: '10px', alignItems: 'center', marginTop: '15px' }}>
                    <label htmlFor="newTableSeats">{t('manualAllocation.seatsLabel')}</label>
                    <input
                      id="newTableSeats"
                      type="number"
                      min="2"
                      max="10"
                      value={newTableSeats}
                      onChange={(e) => setNewTableSeats(parseInt(e.target.value))}
                      style={{ width: '80px', padding: '8px' }}
                    />
                    <button
                      className="btn-primary"
                      onClick={handleAddTable}
                      style={{ padding: '8px 16px' }}
                    >
                      {t('manualAllocation.addTable')}
                    </button>
                  </div>
                </div>

                <div className="tables-list-section" style={{ marginTop: '30px' }}>
                  <h3>{t('manualAllocation.existingTables', { count: tables.length })}</h3>
                  {tables.length === 0 ? (
                    <p style={{ color: '#999', marginTop: '15px' }}>{t('manualAllocation.noTablesRegisteredShort')}</p>
                  ) : (
                    <div className="tables-list" style={{ marginTop: '15px' }}>
                      {tables.map((table) => {
                        const occupiedSeats = allocations.filter(alloc => alloc.table_id === table.id).length;
                        const canRemove = occupiedSeats === 0;
                        return (
                          <div key={table.id} style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            padding: '15px',
                            border: '1px solid #2a3f5f',
                            borderRadius: '8px',
                            marginBottom: '10px',
                            backgroundColor: '#1a2332'
                          }}>
                            <div>
                              <strong>{t('manualAllocation.tableTitle', { number: table.table_number })}</strong>
                              <span style={{ marginLeft: '15px', color: '#999' }}>
                                {t('manualAllocation.seatsOccupied', { seats: table.seats, occupied: occupiedSeats })}
                              </span>
                            </div>
                            {canRemove ? (
                              <button
                                onClick={() => handleRemoveTable(table.id, table.table_number)}
                                style={{
                                  padding: '6px 12px',
                                  backgroundColor: '#dc3545',
                                  color: 'white',
                                  border: 'none',
                                  borderRadius: '4px',
                                  cursor: 'pointer'
                                }}
                              >
                                {t('common.remove')}
                              </button>
                            ) : (
                              <span style={{ color: '#ffc107', fontSize: '0.85rem' }}>
                                {t('manualAllocation.tableHasPlayers')}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
              <div className="modal-actions">
                <button className="btn-secondary" onClick={() => setShowTableModal(false)}>
                  {t('common.close')}
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default ManualAllocation;
