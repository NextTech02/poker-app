import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import Button from '../components/Button';
import PrizeVoucher from '../components/PrizeVoucher';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import './Premiacao.css';

const DOC_TYPE_LABELS = {
  passport: 'Passaporte',
  national_id: 'Identidade',
  driver_license: 'CNH',
};

const getPositionLabel = (position) => {
  const labels = { 1: '1° - Campeão', 2: '2° - Vice', 3: '3°' };
  return labels[position] || `${position}°`;
};

const getRankClass = (position) => {
  if (position === 1) return 'rank-1';
  if (position === 2) return 'rank-2';
  if (position === 3) return 'rank-3';
  return 'rank-other';
};

const formatCurrency = (value) => {
  const num = parseFloat(value) || 0;
  return num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

// ── Main Component ──────────────────────────────────────────────────────────

const Premiacao = () => {
  const { toast, confirm } = useToast();
  const { tournamentId } = useParams();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('config'); // 'config' | 'pagamentos'

  const [tournament, setTournament] = useState(null);
  const [prizeSummary, setPrizeSummary] = useState(null);
  const [tournamentPlayers, setTournamentPlayers] = useState([]);
  const [hasQualifyingDays, setHasQualifyingDays] = useState(false);
  const [finalDayName, setFinalDayName] = useState('');

  const [guaranteedPrize, setGuaranteedPrize] = useState('');
  const [allocations, setAllocations] = useState([]);

  // Add allocation modal
  const [showAddModal, setShowAddModal] = useState(false);
  const [newPosition, setNewPosition] = useState('');
  const [newAmount, setNewAmount] = useState('');

  // Payout modal
  const [showPayoutModal, setShowPayoutModal] = useState(false);
  const [payoutAllocation, setPayoutAllocation] = useState(null);
  const [payoutPlayerId, setPayoutPlayerId] = useState('');
  const [payoutPlayerSearch, setPayoutPlayerSearch] = useState('');
  const [payoutPlayerDropdown, setPayoutPlayerDropdown] = useState(false);
  const [payoutRegisteredDoc, setPayoutRegisteredDoc] = useState(null); // { type, number } if player has doc
  const [payoutDocType, setPayoutDocType] = useState('national_id');
  const [payoutDocNumber, setPayoutDocNumber] = useState('');
  const [payoutDocError, setPayoutDocError] = useState('');
  const [payoutPaidBy, setPayoutPaidBy] = useState('');
  const [payoutSaving, setPayoutSaving] = useState(false);
  const playerSearchRef = useRef(null);

  // Voucher after payout
  const [showVoucherModal, setShowVoucherModal] = useState(false);
  const [voucherData, setVoucherData] = useState(null);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const [tournamentRes, summaryRes, daysRes, playersRes] = await Promise.all([
        api.get(`/tournaments/${tournamentId}`),
        api.get(`/tournaments/${tournamentId}/prizes/summary`),
        api.get(`/tournament-days/tournament/${tournamentId}`),
        api.get(`/tournament-players/tournament/${tournamentId}`),
      ]);

      setTournament(tournamentRes.data);
      setPrizeSummary(summaryRes.data);
      setGuaranteedPrize(summaryRes.data.guaranteed_prize || '0');
      setAllocations(summaryRes.data.allocations || []);

      // Detect qualifying structure
      const days = daysRes.data || [];
      const qualifying = days.some(d => d.day_type === 'qualifying');
      setHasQualifyingDays(qualifying);
      const finalDay = days.find(d => d.day_type === 'final');
      if (finalDay) setFinalDayName(finalDay.day_name || '');

      // Tournament players (for assigning to positions)
      setTournamentPlayers(playersRes.data || []);

    } catch (err) {
      console.error('Error loading data:', err);
      setError('Erro ao carregar dados da premiação');
    } finally {
      setLoading(false);
    }
  }, [tournamentId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Close player dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (playerSearchRef.current && !playerSearchRef.current.contains(e.target)) {
        setPayoutPlayerDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // ── Config Tab Handlers ──────────────────────────────────────────────────

  const handleSaveGuaranteed = async () => {
    try {
      setSaving(true);
      await api.patch(`/tournaments/${tournamentId}/guaranteed-prize`, {
        guaranteed_prize: parseFloat(guaranteedPrize) || 0
      });
      toast.success('Premio garantido salvo!');
      await loadData();
    } catch (err) {
      setError('Erro ao salvar prêmio garantido');
    } finally {
      setSaving(false);
    }
  };

  const handleAddAllocation = async (e) => {
    e.preventDefault();
    if (!newPosition || !newAmount) return;
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
      const detail = err.response?.data?.detail;
      setError(typeof detail === 'string' ? detail : 'Erro ao adicionar premiação');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteAllocation = async (allocationId) => {
    const ok = await confirm('Remover esta posição de premiação?', { variant: 'danger', confirmText: 'Remover' });
    if (!ok) return;
    try {
      setSaving(true);
      await api.delete(`/tournaments/${tournamentId}/prizes/${allocationId}`);
      await loadData();
    } catch (err) {
      const detail = err.response?.data?.detail;
      setError(typeof detail === 'string' ? detail : 'Erro ao remover premiação');
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
      setError('Erro ao atualizar premiação');
    } finally {
      setSaving(false);
    }
  };

  // ── Payout Tab Handlers ──────────────────────────────────────────────────

  const normalizeDoc = (s) =>
    (s || '').replace(/[\s.\-/]/g, '').toUpperCase();

  const handleSelectPayoutPlayer = async (player) => {
    setPayoutPlayerId(player.player_id);
    setPayoutPlayerSearch(
      player.player_name + (player.player_nickname ? ` (${player.player_nickname})` : '')
    );
    setPayoutPlayerDropdown(false);
    setPayoutDocError('');
    setPayoutRegisteredDoc(null);

    try {
      const res = await api.get(`/players/${player.player_id}`);
      const { document_type, document_number } = res.data;
      if (document_number) {
        setPayoutRegisteredDoc({ type: document_type, number: document_number });
        setPayoutDocType(document_type || 'national_id');
        setPayoutDocNumber(document_number);
      } else {
        setPayoutDocType('national_id');
        setPayoutDocNumber('');
      }
    } catch {
      setPayoutDocType('national_id');
      setPayoutDocNumber('');
    }
  };

  const handleOpenPayout = (allocation) => {
    setPayoutAllocation(allocation);
    setPayoutPlayerId('');
    setPayoutPlayerSearch('');
    setPayoutPlayerDropdown(false);
    setPayoutRegisteredDoc(null);
    setPayoutDocType('national_id');
    setPayoutDocNumber('');
    setPayoutDocError('');
    setPayoutPaidBy('');
    setShowPayoutModal(true);
  };

  const handleConfirmPayout = async (e) => {
    e.preventDefault();
    if (!payoutPlayerId || !payoutDocNumber) return;

    // Client-side doc validation
    if (payoutRegisteredDoc) {
      if (normalizeDoc(payoutDocNumber) !== normalizeDoc(payoutRegisteredDoc.number)) {
        setPayoutDocError('Documento não confere com o cadastro do jogador.');
        return;
      }
    }
    setPayoutDocError('');

    try {
      setPayoutSaving(true);
      const response = await api.post(
        `/tournaments/${tournamentId}/prizes/${payoutAllocation.id}/pay`,
        {
          player_id: payoutPlayerId,
          document_type: payoutDocType,
          document_number: payoutDocNumber,
          paid_by: payoutPaidBy || null,
        }
      );

      setShowPayoutModal(false);
      toast.success('Pagamento registrado com sucesso!');

      // Prepare voucher data
      const player = tournamentPlayers.find(p => p.player_id === payoutPlayerId);
      setVoucherData({
        tournament_name: tournament?.name || '',
        day_name: hasQualifyingDays ? finalDayName : '',
        position: payoutAllocation.position,
        prize_amount: payoutAllocation.prize_amount,
        player_name: response.data.player_name || player?.player_name || '—',
        document_type: payoutDocType,
        document_number: payoutDocNumber,
        paid_at: response.data.paid_at || new Date().toISOString(),
        paid_by: payoutPaidBy || null,
      });
      setShowVoucherModal(true);

      await loadData();
    } catch (err) {
      const detail = err.response?.data?.detail;
      setError(typeof detail === 'string' ? detail : 'Erro ao registrar pagamento');
    } finally {
      setPayoutSaving(false);
    }
  };

  // ── Derived state ────────────────────────────────────────────────────────

  const totalAllocated = allocations.reduce((sum, a) => sum + parseFloat(a.prize_amount || 0), 0);
  const availablePrizePool = prizeSummary ? parseFloat(prizeSummary.available_prize_pool) : 0;
  const remainingBalance = availablePrizePool - totalAllocated;

  const getNextPosition = () => {
    if (allocations.length === 0) return 1;
    return Math.max(...allocations.map(a => a.position)) + 1;
  };

  // Deduplicate by player_id (same player can appear in multiple days/rebuys)
  const eligiblePlayers = Object.values(
    tournamentPlayers.reduce((acc, p) => {
      if (!acc[p.player_id]) acc[p.player_id] = p;
      return acc;
    }, {})
  ).sort((a, b) => (a.player_name || '').localeCompare(b.player_name || ''));

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
        <div className="premiacao-header">
          <Button variant="ghost" onClick={() => navigate(-1)}>
            <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 16, height: 16, flexShrink: 0 }}>
              <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/>
            </svg>
            Voltar
          </Button>
          <div className="premiacao-title-block">
            <div className="premiacao-trophy-icon">
              <svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                <path d="M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94.63 1.5 1.98 2.63 3.61 2.96V17H7v2h10v-2h-4v-1.1c1.63-.33 2.98-1.46 3.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z"/>
              </svg>
            </div>
            <div>
              <h1>Premiação</h1>
              <p className="page-subtitle">{tournament?.name}</p>
            </div>
          </div>
        </div>

        {hasQualifyingDays && (
          <div className="qualifying-banner">
            <span className="banner-icon">ℹ</span>
            <span>
              Torneio com dias classificatórios — o prize pool inclui todos os dias
              {finalDayName ? `. Dia Final: ${finalDayName}` : ''}.
            </span>
          </div>
        )}

        {error && (
          <div className="error-banner">
            {error}
            <button onClick={() => setError(null)}>✕</button>
          </div>
        )}

        {/* Tabs */}
        <div className="prem-tabs">
          <button
            className={`prem-tab ${activeTab === 'config' ? 'active' : ''}`}
            onClick={() => setActiveTab('config')}
          >
            Configuração
          </button>
          <button
            className={`prem-tab ${activeTab === 'pagamentos' ? 'active' : ''}`}
            onClick={() => setActiveTab('pagamentos')}
          >
            Pagamentos
            {allocations.filter(a => a.paid).length > 0 && (
              <span className="tab-badge">{allocations.filter(a => a.paid).length}</span>
            )}
          </button>
        </div>

        {/* ── TAB: CONFIG ───────────────────────────────────────────────── */}
        {activeTab === 'config' && (
          <>
            {/* Summary Cards */}
            <div className="prize-summary-grid">
              <div className="summary-card guaranteed-card">
                <div className="card-header">
                  <h3>Prêmio Garantido</h3>
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
                  <Button size="small" onClick={handleSaveGuaranteed} disabled={saving}>
                    Salvar
                  </Button>
                </div>
              </div>

              <div className="summary-card entries-card">
                <div className="card-header">
                  <h3>Total de Entradas</h3>
                  <span className="card-subtitle">Soma de todos os dias</span>
                </div>
                <div className="card-value">R$ {formatCurrency(prizeSummary?.total_entries)}</div>
              </div>

              <div className="summary-card rake-card">
                <div className="card-header">
                  <h3>Rake</h3>
                  <span className="card-subtitle">{parseFloat(prizeSummary?.rake_percentage || 20).toFixed(0)}%</span>
                </div>
                <div className="card-value">
                  R$ {formatCurrency(
                    (parseFloat(prizeSummary?.total_entries || 0) * (parseFloat(prizeSummary?.rake_percentage || 20) / 100))
                  )}
                </div>
              </div>

              <div className="summary-card player-pool-card">
                <div className="card-header">
                  <h3>Pool dos Jogadores</h3>
                  <span className="card-subtitle">{100 - parseFloat(prizeSummary?.rake_percentage || 20)}% das entradas</span>
                </div>
                <div className="card-value">R$ {formatCurrency(prizeSummary?.player_pool)}</div>
              </div>
            </div>

            {/* Allocations Section */}
            <div className="prize-pool-section">
              <div className="pool-header">
                <div className="pool-info">
                  <div className="pool-item available">
                    <span className="pool-label">Prizepool Disponível</span>
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
                      <span className="pool-warning">Alocação excede o disponível!</span>
                    )}
                  </div>
                </div>
                <Button onClick={() => {
                  setNewPosition(getNextPosition().toString());
                  setNewAmount('');
                  setShowAddModal(true);
                }}>
                  Adicionar Posição
                </Button>
              </div>

              <div className="allocations-table-container">
                {allocations.length === 0 ? (
                  <div className="prem-empty">
                    <div className="prem-empty-icon">
                      <svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                        <path d="M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94.63 1.5 1.98 2.63 3.61 2.96V17H7v2h10v-2h-4v-1.1c1.63-.33 2.98-1.46 3.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z"/>
                      </svg>
                    </div>
                    <h3>Nenhuma premiação configurada</h3>
                    <p>Adicione posições de premiação para distribuir o prizepool</p>
                  </div>
                ) : (
                  <table className="allocations-table">
                    <thead>
                      <tr>
                        <th>Posição</th>
                        <th>Prêmio</th>
                        <th>% do Pool</th>
                        <th>Ações</th>
                      </tr>
                    </thead>
                    <tbody>
                      {allocations.map((allocation) => (
                        <ConfigAllocationRow
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
                        <td><strong>
                          {availablePrizePool > 0
                            ? ((totalAllocated / availablePrizePool) * 100).toFixed(1)
                            : 0}%
                        </strong></td>
                        <td></td>
                      </tr>
                    </tfoot>
                  </table>
                )}
              </div>
            </div>
          </>
        )}

        {/* ── TAB: PAGAMENTOS ───────────────────────────────────────────── */}
        {activeTab === 'pagamentos' && (
          <div className="prize-pool-section">
            {allocations.length === 0 ? (
              <div className="prem-empty">
                <div className="prem-empty-icon">
                  <svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                    <path d="M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94.63 1.5 1.98 2.63 3.61 2.96V17H7v2h10v-2h-4v-1.1c1.63-.33 2.98-1.46 3.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z"/>
                  </svg>
                </div>
                <h3>Nenhuma posição configurada</h3>
                <p>Configure as premiações na aba "Configuração" primeiro</p>
              </div>
            ) : (
              <table className="allocations-table">
                <thead>
                  <tr>
                    <th>Posição</th>
                    <th>Prêmio</th>
                    <th>Jogador</th>
                    <th>Status</th>
                    <th>Ação</th>
                  </tr>
                </thead>
                <tbody>
                  {allocations.map((allocation) => (
                    <PayoutRow
                      key={allocation.id}
                      allocation={allocation}
                      onPay={() => handleOpenPayout(allocation)}
                      onViewVoucher={(a) => {
                        setVoucherData({
                          tournament_name: tournament?.name || '',
                          day_name: hasQualifyingDays ? finalDayName : '',
                          position: a.position,
                          prize_amount: a.prize_amount,
                          player_name: a.player_name || '—',
                          document_type: a.document_type,
                          document_number: a.document_number,
                          paid_at: a.paid_at,
                          paid_by: a.paid_by,
                        });
                        setShowVoucherModal(true);
                      }}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* ── Modal: Add Allocation ──────────────────────────────────────── */}
        {showAddModal && (
          <div className="modal-overlay" onClick={() => setShowAddModal(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>Adicionar Premiação</h2>
                <button className="close-btn" onClick={() => setShowAddModal(false)}>
                  ✕
                </button>
              </div>
              <form onSubmit={handleAddAllocation}>
                <div className="form-group">
                  <label>Posição *</label>
                  <input
                    type="number"
                    min="1"
                    value={newPosition}
                    onChange={(e) => setNewPosition(e.target.value)}
                    required
                    placeholder="Ex: 1 para campeão"
                  />
                  <small>1 = Campeão, 2 = Vice, etc.</small>
                </div>
                <div className="form-group">
                  <label>Valor do Prêmio (R$) *</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={newAmount}
                    onChange={(e) => setNewAmount(e.target.value)}
                    required
                    placeholder="0.00"
                  />
                  <small>Saldo disponível: R$ {formatCurrency(remainingBalance)}</small>
                </div>
                <div className="modal-actions">
                  <Button type="button" variant="ghost" onClick={() => setShowAddModal(false)}>
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

        {/* ── Modal: Payout ─────────────────────────────────────────────── */}
        {showPayoutModal && payoutAllocation && (
          <div className="modal-overlay" onClick={() => setShowPayoutModal(false)}>
            <div className="modal payout-modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>Registrar Pagamento</h2>
                <button className="close-btn" onClick={() => setShowPayoutModal(false)}>
                  ✕
                </button>
              </div>

              <div className="payout-position-header">
                <span className="payout-position-label">{getPositionLabel(payoutAllocation.position)}</span>
                <span className="payout-prize-value">R$ {formatCurrency(payoutAllocation.prize_amount)}</span>
              </div>

              <form onSubmit={handleConfirmPayout}>
                <div className="form-group" style={{ position: 'relative' }} ref={playerSearchRef}>
                  <label>Jogador *</label>
                  <input
                    type="text"
                    value={payoutPlayerSearch}
                    onChange={(e) => {
                      setPayoutPlayerSearch(e.target.value);
                      setPayoutPlayerId('');
                      setPayoutPlayerDropdown(true);
                    }}
                    onFocus={() => setPayoutPlayerDropdown(true)}
                    placeholder="Digite o nome do jogador..."
                    autoComplete="off"
                    style={{ borderColor: payoutPlayerId ? '#d4af37' : undefined }}
                  />
                  {/* Hidden required sentinel */}
                  <input type="hidden" value={payoutPlayerId} required />
                  {payoutPlayerDropdown && (
                    <div className="player-search-dropdown">
                      {eligiblePlayers
                        .filter(p => {
                          const q = payoutPlayerSearch.toLowerCase();
                          return !q ||
                            (p.player_name || '').toLowerCase().includes(q) ||
                            (p.player_nickname || '').toLowerCase().includes(q);
                        })
                        .slice(0, 8)
                        .map(p => (
                          <div
                            key={p.player_id}
                            className="player-search-option"
                            onMouseDown={() => handleSelectPayoutPlayer(p)}
                          >
                            <span className="pso-name">{p.player_name}</span>
                            {p.player_nickname && (
                              <span className="pso-nick">{p.player_nickname}</span>
                            )}
                          </div>
                        ))
                      }
                      {eligiblePlayers.filter(p => {
                        const q = payoutPlayerSearch.toLowerCase();
                        return !q ||
                          (p.player_name || '').toLowerCase().includes(q) ||
                          (p.player_nickname || '').toLowerCase().includes(q);
                      }).length === 0 && (
                        <div className="player-search-empty">Nenhum jogador encontrado</div>
                      )}
                    </div>
                  )}
                </div>

                {payoutRegisteredDoc && (
                  <div className="doc-registered-banner">
                    <span className="doc-registered-icon">✓</span>
                    <span>
                      Documento cadastrado: <strong>{DOC_TYPE_LABELS[payoutRegisteredDoc.type] || payoutRegisteredDoc.type}</strong> — {payoutRegisteredDoc.number}
                    </span>
                  </div>
                )}

                <div className="form-group">
                  <label>Tipo de Documento *</label>
                  <div className="doc-type-options">
                    {Object.entries(DOC_TYPE_LABELS).map(([value, label]) => (
                      <label key={value} className="radio-option">
                        <input
                          type="radio"
                          name="doc_type"
                          value={value}
                          checked={payoutDocType === value}
                          onChange={() => {
                            setPayoutDocType(value);
                            setPayoutDocError('');
                          }}
                          disabled={!!payoutRegisteredDoc}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </div>

                <div className="form-group">
                  <label>Número do Documento *</label>
                  <input
                    type="text"
                    value={payoutDocNumber}
                    onChange={(e) => {
                      setPayoutDocNumber(e.target.value);
                      setPayoutDocError('');
                    }}
                    required
                    placeholder={payoutDocType === 'national_id' ? '000.000.000-00' : 'Ex: AB123456'}
                    style={payoutDocError ? { borderColor: '#ef4444' } : undefined}
                  />
                  {payoutDocError && (
                    <div className="doc-error-msg">{payoutDocError}</div>
                  )}
                </div>

                <div className="form-group">
                  <label>Atendente (opcional)</label>
                  <input
                    type="text"
                    value={payoutPaidBy}
                    onChange={(e) => setPayoutPaidBy(e.target.value)}
                    placeholder="Nome do funcionário"
                  />
                </div>

                <div className="payout-doc-note">
                  O documento será verificado contra o cadastro do jogador.
                  Se não houver cadastro, será salvo automaticamente.
                </div>

                <div className="modal-actions">
                  <Button type="button" variant="secondary" onClick={() => setShowPayoutModal(false)}>
                    Cancelar
                  </Button>
                  <Button type="submit" disabled={payoutSaving}>
                    {payoutSaving ? 'Processando...' : 'Confirmar Pagamento'}
                  </Button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* ── Modal: Voucher ─────────────────────────────────────────────── */}
        {showVoucherModal && voucherData && (
          <div className="modal-overlay" onClick={() => setShowVoucherModal(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>Comprovante de Pagamento</h2>
                <button className="close-btn" onClick={() => setShowVoucherModal(false)}>
                  ✕
                </button>
              </div>
              <div className="modal-body">
                <PrizeVoucher payout={voucherData} />
              </div>
              <div className="modal-actions">
                <Button onClick={() => setShowVoucherModal(false)}>Fechar</Button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

// ── Config Tab Row ───────────────────────────────────────────────────────────

const ConfigAllocationRow = ({ allocation, availablePrizePool, onUpdate, onDelete, saving }) => {
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

  const percentage = availablePrizePool > 0
    ? ((parseFloat(allocation.prize_amount) / availablePrizePool) * 100).toFixed(1)
    : 0;

  return (
    <tr className={allocation.paid ? 'paid-row' : ''}>
      <td className="position-cell">
        <span className={`position-badge ${getRankClass(allocation.position)}`}>{getPositionLabel(allocation.position)}</span>
        {allocation.paid && <span className="paid-inline-badge">Pago</span>}
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
          <span
            onClick={() => !allocation.paid && setEditing(true)}
            className={`editable-value ${allocation.paid ? '' : 'clickable'}`}
          >
            R$ {formatCurrency(allocation.prize_amount)}
          </span>
        )}
      </td>
      <td className="percentage-cell">{percentage}%</td>
      <td className="actions-cell">
        <button
          className="btn-small btn-delete"
          onClick={() => onDelete(allocation.id)}
          disabled={saving || allocation.paid}
          title={allocation.paid ? 'Não pode remover prêmio pago' : 'Remover'}
        >
          X
        </button>
      </td>
    </tr>
  );
};

// ── Payout Tab Row ───────────────────────────────────────────────────────────

const PayoutRow = ({ allocation, onPay, onViewVoucher }) => {
  return (
    <tr className={allocation.paid ? 'paid-row' : ''}>
      <td className="position-cell">
        <span className={`position-badge ${getRankClass(allocation.position)}`}>{getPositionLabel(allocation.position)}</span>
      </td>
      <td className="amount-cell">
        <strong>R$ {formatCurrency(allocation.prize_amount)}</strong>
      </td>
      <td className="player-cell">
        {allocation.player_name
          ? <span className="player-assigned">{allocation.player_name}</span>
          : <span className="not-assigned">Não atribuído</span>
        }
      </td>
      <td className="status-cell">
        {allocation.paid
          ? <span className="status-badge paid">Pago</span>
          : <span className="status-badge pending">Pendente</span>
        }
      </td>
      <td className="actions-cell">
        {allocation.paid ? (
          <button className="btn-small btn-view" onClick={() => onViewVoucher(allocation)}>
            Comprovante
          </button>
        ) : (
          <button className="btn-small btn-pay" onClick={onPay}>
            Pagar
          </button>
        )}
      </td>
    </tr>
  );
};

export default Premiacao;
