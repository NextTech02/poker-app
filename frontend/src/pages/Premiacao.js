import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import Button from '../components/Button';
import api from '../config/api';
import './Premiacao.css';

const Premiacao = () => {
  const { tournamentId } = useParams();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const [tournament, setTournament] = useState(null);
  const [prizeSummary, setPrizeSummary] = useState(null);

  const [guaranteedPrize, setGuaranteedPrize] = useState('');
  const [allocations, setAllocations] = useState([]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newPosition, setNewPosition] = useState('');
  const [newAmount, setNewAmount] = useState('');

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      // Load tournament info
      const tournamentRes = await api.get(`/tournaments/${tournamentId}`);
      setTournament(tournamentRes.data);

      // Load prize summary
      const summaryRes = await api.get(`/tournaments/${tournamentId}/prizes/summary`);
      setPrizeSummary(summaryRes.data);
      setGuaranteedPrize(summaryRes.data.guaranteed_prize || '0');
      setAllocations(summaryRes.data.allocations || []);

    } catch (err) {
      console.error('Error loading data:', err);
      setError('Erro ao carregar dados da premiacao');
    } finally {
      setLoading(false);
    }
  }, [tournamentId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSaveGuaranteed = async () => {
    try {
      setSaving(true);
      await api.patch(`/tournaments/${tournamentId}/guaranteed-prize`, {
        guaranteed_prize: parseFloat(guaranteedPrize) || 0
      });
      await loadData();
    } catch (err) {
      console.error('Error saving guaranteed prize:', err);
      setError('Erro ao salvar premio garantido');
    } finally {
      setSaving(false);
    }
  };

  const handleAddAllocation = async (e) => {
    e.preventDefault();

    if (!newPosition || !newAmount) {
      return;
    }

    try {
      setSaving(true);
      await api.post(`/tournaments/${tournamentId}/prizes`, {
        position: parseInt(newPosition),
        prize_amount: parseFloat(newAmount)
      });
      setShowAddModal(false);
      setNewPosition('');
      setNewAmount('');
      await loadData();
    } catch (err) {
      console.error('Error adding allocation:', err);
      if (err.response?.data?.detail) {
        setError(err.response.data.detail);
      } else {
        setError('Erro ao adicionar premiacao');
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteAllocation = async (allocationId) => {
    if (!window.confirm('Tem certeza que deseja remover esta premiacao?')) {
      return;
    }

    try {
      setSaving(true);
      await api.delete(`/tournaments/${tournamentId}/prizes/${allocationId}`);
      await loadData();
    } catch (err) {
      console.error('Error deleting allocation:', err);
      setError('Erro ao remover premiacao');
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateAllocation = async (allocationId, newAmount) => {
    try {
      setSaving(true);
      await api.patch(`/tournaments/${tournamentId}/prizes/${allocationId}`, {
        prize_amount: parseFloat(newAmount)
      });
      await loadData();
    } catch (err) {
      console.error('Error updating allocation:', err);
      setError('Erro ao atualizar premiacao');
    } finally {
      setSaving(false);
    }
  };

  const formatCurrency = (value) => {
    const num = parseFloat(value) || 0;
    return num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  // Calculate totals from current allocations
  const totalAllocated = allocations.reduce((sum, a) => sum + parseFloat(a.prize_amount || 0), 0);
  const availablePrizePool = prizeSummary ? parseFloat(prizeSummary.available_prize_pool) : 0;
  const remainingBalance = availablePrizePool - totalAllocated;

  // Get next available position
  const getNextPosition = () => {
    if (allocations.length === 0) return 1;
    const maxPosition = Math.max(...allocations.map(a => a.position));
    return maxPosition + 1;
  };

  if (loading) {
    return (
      <div className="app-layout">
        <Sidebar />
        <main className="main-content">
          <div className="loading-state">Carregando...</div>
        </main>
      </div>
    );
  }

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div className="header-title">
            <Button variant="ghost" onClick={() => navigate(-1)}>
              Voltar
            </Button>
            <div>
              <h1>Premiacao</h1>
              <p className="page-subtitle">
                {tournament?.name}
              </p>
            </div>
          </div>
        </div>

        {error && (
          <div className="error-banner">
            {error}
            <button onClick={() => setError(null)}>x</button>
          </div>
        )}

        {/* Prize Summary Cards */}
        <div className="prize-summary-grid">
          {/* Guaranteed Prize Card */}
          <div className="summary-card guaranteed-card">
            <div className="card-header">
              <h3>Premio Garantido</h3>
            </div>
            <div className="card-content">
              <div className="input-with-prefix">
                <span className="prefix">R$</span>
                <input
                  type="number"
                  min="0"
                  step="100"
                  value={guaranteedPrize}
                  onChange={(e) => setGuaranteedPrize(e.target.value)}
                  className="guaranteed-input"
                />
              </div>
              <Button
                size="small"
                onClick={handleSaveGuaranteed}
                disabled={saving}
              >
                Salvar
              </Button>
            </div>
          </div>

          {/* Entries Card */}
          <div className="summary-card entries-card">
            <div className="card-header">
              <h3>Total de Entradas</h3>
              <span className="card-subtitle">Soma de todos os dias</span>
            </div>
            <div className="card-value">
              R$ {formatCurrency(prizeSummary?.total_entries)}
            </div>
          </div>

          {/* Rake Info Card */}
          <div className="summary-card rake-card">
            <div className="card-header">
              <h3>Rake</h3>
              <span className="card-subtitle">{parseFloat(prizeSummary?.rake_percentage || 20).toFixed(0)}%</span>
            </div>
            <div className="card-value">
              R$ {formatCurrency((parseFloat(prizeSummary?.total_entries || 0) * (parseFloat(prizeSummary?.rake_percentage || 20) / 100)))}
            </div>
          </div>

          {/* Player Pool Card */}
          <div className="summary-card player-pool-card">
            <div className="card-header">
              <h3>Pool dos Jogadores</h3>
              <span className="card-subtitle">{100 - parseFloat(prizeSummary?.rake_percentage || 20)}% das entradas</span>
            </div>
            <div className="card-value">
              R$ {formatCurrency(prizeSummary?.player_pool)}
            </div>
          </div>
        </div>

        {/* Main Prize Pool Section */}
        <div className="prize-pool-section">
          <div className="pool-header">
            <div className="pool-info">
              <div className="pool-item available">
                <span className="pool-label">Prizepool Disponivel</span>
                <span className="pool-value">R$ {formatCurrency(availablePrizePool)}</span>
                <span className="pool-note">Garantido + pool dos jogadores</span>
              </div>
              <div className="pool-item allocated">
                <span className="pool-label">Total Alocado</span>
                <span className="pool-value">R$ {formatCurrency(totalAllocated)}</span>
              </div>
              <div className={`pool-item remaining ${remainingBalance < 0 ? 'negative' : ''}`}>
                <span className="pool-label">Saldo Restante</span>
                <span className="pool-value">R$ {formatCurrency(remainingBalance)}</span>
                {remainingBalance < 0 && (
                  <span className="pool-warning">Alocacao excede o disponivel!</span>
                )}
              </div>
            </div>
            <Button onClick={() => {
              setNewPosition(getNextPosition().toString());
              setNewAmount('');
              setShowAddModal(true);
            }}>
              Adicionar Posicao
            </Button>
          </div>

          {/* Allocations Table */}
          <div className="allocations-table-container">
            {allocations.length === 0 ? (
              <div className="empty-state">
                <p>Nenhuma premiacao configurada</p>
                <p className="empty-hint">Adicione posicoes de premiacao para distribuir o prizepool</p>
              </div>
            ) : (
              <table className="allocations-table">
                <thead>
                  <tr>
                    <th>Posicao</th>
                    <th>Premio</th>
                    <th>% do Pool</th>
                    <th>Jogador</th>
                    <th>Status</th>
                    <th>Acoes</th>
                  </tr>
                </thead>
                <tbody>
                  {allocations.map((allocation) => (
                    <AllocationRow
                      key={allocation.id}
                      allocation={allocation}
                      availablePrizePool={availablePrizePool}
                      onUpdate={handleUpdateAllocation}
                      onDelete={handleDeleteAllocation}
                      saving={saving}
                    />
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td><strong>Total</strong></td>
                    <td><strong>R$ {formatCurrency(totalAllocated)}</strong></td>
                    <td><strong>{availablePrizePool > 0 ? ((totalAllocated / availablePrizePool) * 100).toFixed(1) : 0}%</strong></td>
                    <td colSpan="3"></td>
                  </tr>
                </tfoot>
              </table>
            )}
          </div>
        </div>

        {/* Add Allocation Modal */}
        {showAddModal && (
          <div className="modal-overlay" onClick={() => setShowAddModal(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>Adicionar Premiacao</h2>
                <button className="close-btn" onClick={() => setShowAddModal(false)}>
                  x
                </button>
              </div>
              <form onSubmit={handleAddAllocation}>
                <div className="form-group">
                  <label htmlFor="position">Posicao *</label>
                  <input
                    id="position"
                    type="number"
                    min="1"
                    value={newPosition}
                    onChange={(e) => setNewPosition(e.target.value)}
                    required
                    placeholder="Ex: 1 para campeao"
                  />
                  <small>1 = Campeao, 2 = Vice, etc.</small>
                </div>
                <div className="form-group">
                  <label htmlFor="amount">Valor do Premio (R$) *</label>
                  <input
                    id="amount"
                    type="number"
                    min="0"
                    step="0.01"
                    value={newAmount}
                    onChange={(e) => setNewAmount(e.target.value)}
                    required
                    placeholder="0.00"
                  />
                  <small>Saldo disponivel: R$ {formatCurrency(remainingBalance)}</small>
                </div>
                <div className="modal-actions">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setShowAddModal(false)}
                  >
                    Cancelar
                  </Button>
                  <Button type="submit" disabled={saving}>
                    {saving ? 'Salvando...' : 'Adicionar'}
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

// Separate component for allocation row with inline editing
const AllocationRow = ({ allocation, availablePrizePool, onUpdate, onDelete, saving }) => {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(allocation.prize_amount);

  const handleSave = () => {
    onUpdate(allocation.id, editValue);
    setEditing(false);
  };

  const handleCancel = () => {
    setEditValue(allocation.prize_amount);
    setEditing(false);
  };

  const formatCurrency = (value) => {
    const num = parseFloat(value) || 0;
    return num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const percentage = availablePrizePool > 0
    ? ((parseFloat(allocation.prize_amount) / availablePrizePool) * 100).toFixed(1)
    : 0;

  const getPositionLabel = (position) => {
    const labels = {
      1: '1o - Campeao',
      2: '2o - Vice',
      3: '3o',
      4: '4o',
      5: '5o',
      6: '6o',
      7: '7o',
      8: '8o',
      9: '9o',
      10: '10o'
    };
    return labels[position] || `${position}o`;
  };

  return (
    <tr className={allocation.paid ? 'paid-row' : ''}>
      <td className="position-cell">
        <span className="position-badge">{getPositionLabel(allocation.position)}</span>
      </td>
      <td className="amount-cell">
        {editing ? (
          <div className="inline-edit">
            <input
              type="number"
              min="0"
              step="0.01"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              autoFocus
            />
            <button className="btn-save" onClick={handleSave} disabled={saving}>OK</button>
            <button className="btn-cancel" onClick={handleCancel}>X</button>
          </div>
        ) : (
          <span onClick={() => setEditing(true)} className="editable-value">
            R$ {formatCurrency(allocation.prize_amount)}
          </span>
        )}
      </td>
      <td className="percentage-cell">{percentage}%</td>
      <td className="player-cell">
        {allocation.player_name || <span className="not-assigned">-</span>}
      </td>
      <td className="status-cell">
        {allocation.paid ? (
          <span className="status-badge paid">Pago</span>
        ) : (
          <span className="status-badge pending">Pendente</span>
        )}
      </td>
      <td className="actions-cell">
        <button
          className="btn-small btn-delete"
          onClick={() => onDelete(allocation.id)}
          disabled={saving || allocation.paid}
          title={allocation.paid ? 'Nao pode remover premio pago' : 'Remover'}
        >
          X
        </button>
      </td>
    </tr>
  );
};

export default Premiacao;
