import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import Button from '../components/Button';
import Breadcrumb from '../components/Breadcrumb';
import PrizeVoucher from '../components/PrizeVoucher';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { calculatePayoutAllocations } from '../utils/payoutStructure';
import './Premiacao.css';

const DOC_TYPE_LABELS = {
  passport: 'Passaporte',
  national_id: 'Identidade',
  driver_license: 'CNH',
};

const getPositionLabel = (position) => `${position}°`;

const getRankClass = () => 'rank-other';

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
  const [reservedPct, setReservedPct] = useState('0');
  const [reservedPurpose, setReservedPurpose] = useState('');
  const [allocations, setAllocations] = useState([]);

  // Add allocation modal
  const [showAddModal, setShowAddModal] = useState(false);
  const [newPosition, setNewPosition] = useState('');
  const [newAmount, setNewAmount] = useState('');
  const [newPrizeType, setNewPrizeType] = useState('cash');
  const [newVagaDayId, setNewVagaDayId] = useState('');
  const [days, setDays] = useState([]);

  // Payout modal — document-first flow: operator types the doc, the matching
  // tournament player is auto-resolved.
  const [showPayoutModal, setShowPayoutModal] = useState(false);
  const [payoutAllocation, setPayoutAllocation] = useState(null);
  const [payoutPlayerId, setPayoutPlayerId] = useState('');
  const [payoutDocType, setPayoutDocType] = useState('national_id');
  const [payoutDocNumber, setPayoutDocNumber] = useState('');
  const [payoutDocError, setPayoutDocError] = useState('');
  const [payoutPaidBy, setPayoutPaidBy] = useState('');
  const [payoutSaving, setPayoutSaving] = useState(false);
  const [payoutPlayersDocs, setPayoutPlayersDocs] = useState({}); // playerId -> {document_type, document_number, name, nickname}
  const [payoutResolvedPlayer, setPayoutResolvedPlayer] = useState(null); // { player_id, name, nickname, document_type, document_number }

  // Prize pool & cash info for payout validation
  const [prizePoolInfo, setPrizePoolInfo] = useState(null);
  const [generalCashBalance, setGeneralCashBalance] = useState(null);

  // Voucher after payout
  const [showVoucherModal, setShowVoucherModal] = useState(false);
  const [voucherData, setVoucherData] = useState(null);

  // Auto-calculate modal
  const [showAutoModal, setShowAutoModal] = useState(false);
  const [autoPreview, setAutoPreview] = useState([]);
  const [autoEntryCount, setAutoEntryCount] = useState(0);

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
      setReservedPct(String(summaryRes.data.reserved_prize_percentage ?? '0'));
      setReservedPurpose(summaryRes.data.reserved_purpose || '');
      setAllocations(summaryRes.data.allocations || []);

      // Detect qualifying structure
      const days = daysRes.data || [];
      setDays(days);
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

  const handleSaveReserved = async () => {
    try {
      setSaving(true);
      await api.patch(`/tournaments/${tournamentId}/reserved-prize`, {
        reserved_prize_percentage: parseFloat(reservedPct) || 0,
        reserved_purpose: reservedPurpose || null,
      });
      toast.success('Premiação reservada salva!');
      await loadData();
    } catch (err) {
      const detail = err.response?.data?.detail;
      setError(typeof detail === 'string' ? detail : 'Erro ao salvar premiação reservada');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleRelease = async (allocation) => {
    try {
      setSaving(true);
      await api.patch(`/tournaments/${tournamentId}/prizes/${allocation.id}/release`, {
        released: !allocation.released,
      });
      toast.success(!allocation.released ? 'Premiação liberada!' : 'Liberação revogada');
      await loadData();
    } catch (err) {
      const detail = err.response?.data?.detail;
      setError(typeof detail === 'string' ? detail : 'Erro ao alterar liberação');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleVisible = async (allocation) => {
    try {
      setSaving(true);
      await api.patch(`/tournaments/${tournamentId}/prizes/${allocation.id}`, {
        visible: !allocation.visible,
      });
      await loadData();
    } catch (err) {
      setError('Erro ao alterar visibilidade da faixa');
    } finally {
      setSaving(false);
    }
  };

  const handleAddAllocation = async (e) => {
    e.preventDefault();
    if (!newPosition) return;
    const isVaga = newPrizeType === 'vaga';
    if (isVaga && !newVagaDayId) {
      setError('Selecione o dia alvo da vaga');
      return;
    }
    if (!isVaga && !newAmount) return;
    try {
      setSaving(true);
      const payload = isVaga
        ? {
            position: parseInt(newPosition),
            prize_type: 'vaga',
            vaga_target_tournament_id: tournamentId,
            vaga_target_day_id: newVagaDayId,
          }
        : {
            position: parseInt(newPosition),
            prize_amount: parseFloat(newAmount),
          };
      await api.post(`/tournaments/${tournamentId}/prizes`, payload);
      setShowAddModal(false);
      setNewPosition('');
      setNewAmount('');
      setNewPrizeType('cash');
      setNewVagaDayId('');
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

  // ── Auto-Calculate Handlers ──────────────────────────────────────────────

  const handleOpenAutoCalculate = () => {
    // entry count = buy-ins + rebuys per player
    const entryCount = tournamentPlayers.reduce(
      (sum, p) => sum + (p.buy_in_count || 1) + (p.rebuy_count || 0), 0
    ) || tournamentPlayers.length;

    if (entryCount === 0) {
      toast.error('Nenhuma entrada registrada no torneio.');
      return;
    }
    if (availablePrizePool <= 0) {
      toast.error('Prizepool disponível é zero. Registre entradas primeiro.');
      return;
    }

    const preview = calculatePayoutAllocations(entryCount, availablePrizePool);
    if (preview.length === 0) {
      toast.error('Nenhuma estrutura encontrada para ' + entryCount + ' entradas.');
      return;
    }

    setAutoEntryCount(entryCount);
    setAutoPreview(preview);
    setShowAutoModal(true);
  };

  const handleConfirmAutoCalculate = async () => {
    try {
      setSaving(true);
      await api.post(`/tournaments/${tournamentId}/prizes/bulk`, {
        allocations: autoPreview.map(a => ({
          position: a.position,
          prize_amount: a.prize_amount,
        })),
      });
      setShowAutoModal(false);
      toast.success(`Premiação aplicada! ${autoPreview.length} posições configuradas.`);
      await loadData();
    } catch (err) {
      const detail = err.response?.data?.detail;
      setError(typeof detail === 'string' ? detail : 'Erro ao aplicar premiação automática');
    } finally {
      setSaving(false);
    }
  };

  // ── Payout Tab Handlers ──────────────────────────────────────────────────

  const normalizeDoc = (s) =>
    (s || '').replace(/[\s.\-/]/g, '').toUpperCase();

  const handleOpenPayout = async (allocation) => {
    setPayoutAllocation(allocation);
    setPayoutPlayerId('');
    setPayoutDocType('national_id');
    setPayoutDocNumber('');
    setPayoutDocError('');
    setPayoutPaidBy('');
    setPayoutResolvedPlayer(null);
    setPayoutPlayersDocs({});
    setShowPayoutModal(true);

    // Load prize pool, general cash, and the docs for every eligible player so
    // the operator can type the document and we resolve the player locally.
    try {
      const [poolRes, cashRes, playersRes] = await Promise.all([
        api.get(`/tournaments/${tournamentId}/prizes/pool`),
        api.get('/cash/general'),
        api.get('/players'),
      ]);
      setPrizePoolInfo(poolRes.data);
      setGeneralCashBalance(cashRes.data?.current_balance ?? null);

      const docMap = {};
      for (const p of (playersRes.data || [])) {
        if (p.document_number) {
          docMap[p.id] = {
            player_id: p.id,
            name: p.name,
            nickname: p.nickname,
            document_type: p.document_type,
            document_number: p.document_number,
          };
        }
      }
      setPayoutPlayersDocs(docMap);
    } catch (err) {
      console.error('Error loading pool/cash/players info:', err);
    }
  };

  const handleConfirmPayout = async (e) => {
    e.preventDefault();
    if (!payoutPlayerId || !payoutDocNumber) return;
    if (!payoutResolvedPlayer) {
      setPayoutDocError('Nenhum jogador deste torneio possui este documento.');
      return;
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
  // payable_pool already discounts the reserved portion (feature 4.1)
  const payablePool = prizeSummary && prizeSummary.payable_pool != null
    ? parseFloat(prizeSummary.payable_pool)
    : availablePrizePool;
  const remainingBalance = payablePool - totalAllocated;

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
        {/* A6.4: Breadcrumb */}
        <Breadcrumb items={[
          { label: 'Início', to: '/' },
          { label: 'Torneios', to: '/torneios' },
          { label: 'Premiação' },
        ]} />
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
          <button
            className={`prem-tab ${activeTab === 'liberacao' ? 'active' : ''}`}
            onClick={() => setActiveTab('liberacao')}
          >
            Liberação
            {allocations.filter(a => a.released && !a.paid).length > 0 && (
              <span className="tab-badge">{allocations.filter(a => a.released && !a.paid).length}</span>
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

              <div className="summary-card reserved-card">
                <div className="card-header">
                  <h3>Premiação Reservada</h3>
                  <span className="card-subtitle">Bloqueada do pagamento</span>
                </div>
                <div className="card-content">
                  <div className="input-with-prefix">
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="1"
                      value={reservedPct}
                      onChange={(e) => setReservedPct(e.target.value)}
                      className="guaranteed-input"
                    />
                    <span className="prefix">%</span>
                  </div>
                  <select
                    value={reservedPurpose}
                    onChange={(e) => setReservedPurpose(e.target.value)}
                    className="reserved-purpose-select"
                  >
                    <option value="">Destino…</option>
                    <option value="ranking">Ranking</option>
                    <option value="staff">Staff</option>
                  </select>
                  <Button size="small" onClick={handleSaveReserved} disabled={saving}>
                    Salvar
                  </Button>
                  {prizeSummary?.reserved_amount > 0 && (
                    <span className="card-subtitle">
                      = R$ {formatCurrency(prizeSummary?.reserved_amount)}
                    </span>
                  )}
                </div>
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
                <div style={{ display: 'flex', gap: '8px' }}>
                  <Button variant="secondary" onClick={handleOpenAutoCalculate}>
                    ✦ Calcular Automaticamente
                  </Button>
                  <Button onClick={() => {
                    setNewPosition(getNextPosition().toString());
                    setNewAmount('');
                    setShowAddModal(true);
                  }}>
                    Adicionar Posição
                  </Button>
                </div>
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

        {/* ── TAB: LIBERAÇÃO ────────────────────────────────────────────── */}
        {activeTab === 'liberacao' && (
          <div className="prize-pool-section">
            <div className="pool-header">
              <div className="pool-info">
                <div className="pool-item available">
                  <span className="pool-label">Liberadas</span>
                  <span className="pool-value">{allocations.filter(a => a.released).length}/{allocations.length}</span>
                  <span className="pool-note">Só prêmios liberados podem ser pagos</span>
                </div>
              </div>
            </div>
            <div className="allocations-table-container">
              {allocations.length === 0 ? (
                <div className="prem-empty">
                  <h3>Nenhuma premiação configurada</h3>
                  <p>Configure as posições antes de liberar pagamentos</p>
                </div>
              ) : (
                <table className="allocations-table">
                  <thead>
                    <tr>
                      <th>Posição</th>
                      <th>Jogador</th>
                      <th>Prêmio</th>
                      <th>Visível (público)</th>
                      <th>Liberação</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allocations.map((allocation) => (
                      <tr key={allocation.id} className={allocation.paid ? 'row-paid' : ''}>
                        <td>{getPositionLabel(allocation.position)}</td>
                        <td>{allocation.player_name || '—'}</td>
                        <td>
                          R$ {formatCurrency(allocation.prize_amount)}
                          {allocation.prize_type === 'vaga' && (
                            <span className="status-badge" style={{ marginLeft: 6, background: 'rgba(155,89,182,.18)', color: '#9b59b6' }}>Vaga</span>
                          )}
                        </td>
                        <td>
                          <button
                            type="button"
                            className={`prem-toggle ${allocation.visible ? 'on' : 'off'}`}
                            onClick={() => handleToggleVisible(allocation)}
                            disabled={saving}
                            title={allocation.visible ? 'Visível na exibição pública' : 'Oculta da exibição pública'}
                          >
                            {allocation.visible ? '👁 Visível' : '🚫 Oculta'}
                          </button>
                        </td>
                        <td>
                          {allocation.paid ? (
                            <span className="status-badge paid">Pago</span>
                          ) : (
                            <button
                              type="button"
                              className={`prem-toggle ${allocation.released ? 'on' : 'off'}`}
                              onClick={() => handleToggleRelease(allocation)}
                              disabled={saving}
                            >
                              {allocation.released ? '✓ Liberada (revogar)' : 'Liberar'}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
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
                  <label>Tipo de Premiação</label>
                  <select value={newPrizeType} onChange={(e) => setNewPrizeType(e.target.value)}>
                    <option value="cash">Dinheiro</option>
                    <option value="vaga">Vaga (ticket de entrada)</option>
                  </select>
                </div>
                {newPrizeType === 'vaga' ? (
                  <div className="form-group">
                    <label>Dia alvo da vaga *</label>
                    <select
                      value={newVagaDayId}
                      onChange={(e) => setNewVagaDayId(e.target.value)}
                      required
                    >
                      <option value="">Selecione o dia…</option>
                      {days.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.day_name} — buy-in R$ {formatCurrency(d.buy_in)}
                        </option>
                      ))}
                    </select>
                    <small>O valor da vaga é igual ao buy-in do dia alvo e não pode ser pago em dinheiro.</small>
                  </div>
                ) : (
                  <div className="form-group">
                    <label>Valor do Prêmio (R$) *</label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={newAmount}
                      onChange={(e) => setNewAmount(e.target.value)}
                      placeholder="0.00"
                    />
                    <small>Saldo disponível: R$ {formatCurrency(remainingBalance)}</small>
                  </div>
                )}
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

              {prizePoolInfo && (
                <div className="payout-balance-info">
                  <div className="payout-balance-row">
                    <span>Prize Pool do Torneio:</span>
                    <span>R$ {formatCurrency(prizePoolInfo.prize_pool)}</span>
                  </div>
                  <div className="payout-balance-row">
                    <span>Ja pago neste torneio:</span>
                    <span>R$ {formatCurrency(prizePoolInfo.total_paid)}</span>
                  </div>
                  <div className="payout-balance-row payout-balance-row--highlight">
                    <span>Disponivel no prize pool:</span>
                    <span className={prizePoolInfo.available >= parseFloat(payoutAllocation.prize_amount) ? 'payout-ok' : 'payout-warn'}>
                      R$ {formatCurrency(prizePoolInfo.available)}
                    </span>
                  </div>
                  {generalCashBalance !== null && (
                    <div className="payout-balance-row">
                      <span>Saldo caixa geral:</span>
                      <span className={generalCashBalance >= parseFloat(payoutAllocation.prize_amount) ? 'payout-ok' : 'payout-warn'}>
                        R$ {formatCurrency(generalCashBalance)}
                      </span>
                    </div>
                  )}
                </div>
              )}

              <form onSubmit={handleConfirmPayout}>
                <div className="form-group">
                  <label>Número do Documento *</label>
                  <input
                    type="text"
                    value={payoutDocNumber}
                    onChange={(e) => {
                      const value = e.target.value;
                      setPayoutDocNumber(value);
                      setPayoutDocError('');

                      const normalized = normalizeDoc(value);
                      if (!normalized) {
                        setPayoutResolvedPlayer(null);
                        setPayoutPlayerId('');
                        return;
                      }

                      // Resolve player by document among eligible tournament players.
                      const eligibleIds = new Set(eligiblePlayers.map(p => p.player_id));
                      const match = Object.values(payoutPlayersDocs).find(
                        p => eligibleIds.has(p.player_id) &&
                             normalizeDoc(p.document_number) === normalized
                      );
                      if (match) {
                        setPayoutResolvedPlayer(match);
                        setPayoutPlayerId(match.player_id);
                        setPayoutDocType(match.document_type || 'national_id');
                      } else {
                        setPayoutResolvedPlayer(null);
                        setPayoutPlayerId('');
                      }
                    }}
                    required
                    autoFocus
                    placeholder="000.000.000-00"
                    style={
                      payoutDocError
                        ? { borderColor: '#ef4444' }
                        : payoutResolvedPlayer
                          ? { borderColor: '#22c55e' }
                          : undefined
                    }
                  />
                  {/* Hidden required sentinel for player resolution */}
                  <input type="hidden" value={payoutPlayerId} required />
                  {payoutDocError && (
                    <div className="doc-error-msg">{payoutDocError}</div>
                  )}
                </div>

                {payoutResolvedPlayer ? (
                  <div className="doc-registered-banner">
                    <span className="doc-registered-icon">✓</span>
                    <span>
                      Jogador: <strong>{payoutResolvedPlayer.name}</strong>
                      {payoutResolvedPlayer.nickname && (
                        <span className="player-nickname"> ({payoutResolvedPlayer.nickname})</span>
                      )}
                      {' — '}
                      {DOC_TYPE_LABELS[payoutResolvedPlayer.document_type] || payoutResolvedPlayer.document_type}
                    </span>
                  </div>
                ) : payoutDocNumber.trim() ? (
                  <div className="doc-error-msg" style={{ marginBottom: '1rem' }}>
                    Nenhum jogador deste torneio possui este documento.
                  </div>
                ) : null}

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
                  Digite o documento de identificação. O jogador correspondente
                  no torneio será exibido automaticamente.
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

        {/* ── Modal: Auto Calculate ──────────────────────────────────────── */}
        {showAutoModal && (
          <div className="modal-overlay" onClick={() => setShowAutoModal(false)}>
            <div className="modal auto-calc-modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>Calcular Premiação Automaticamente</h2>
                <button className="close-btn" onClick={() => setShowAutoModal(false)}>✕</button>
              </div>

              <div className="auto-calc-summary">
                <div className="auto-calc-stat">
                  <span className="auto-calc-label">Entradas detectadas</span>
                  <span className="auto-calc-value">{autoEntryCount}</span>
                </div>
                <div className="auto-calc-stat">
                  <span className="auto-calc-label">Prizepool disponível</span>
                  <span className="auto-calc-value">R$ {formatCurrency(availablePrizePool)}</span>
                </div>
                <div className="auto-calc-stat">
                  <span className="auto-calc-label">Posições premiadas</span>
                  <span className="auto-calc-value">{autoPreview.length}</span>
                </div>
              </div>

              {allocations.length > 0 && (
                <div className="auto-calc-warning">
                  ⚠ As {allocations.length} posição(ões) existentes serão substituídas.
                </div>
              )}

              <div className="auto-calc-table-wrap">
                <table className="allocations-table">
                  <thead>
                    <tr>
                      <th>Posição</th>
                      <th>% do Pool</th>
                      <th>Valor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {autoPreview.map((a) => (
                      <tr key={a.position}>
                        <td className="position-cell">
                          <span className="position-badge rank-other">{getPositionLabel(a.position)}</span>
                        </td>
                        <td className="percentage-cell">{a.percentage}%</td>
                        <td className="amount-cell">R$ {formatCurrency(a.prize_amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="modal-actions">
                <Button type="button" variant="ghost" onClick={() => setShowAutoModal(false)}>
                  Cancelar
                </Button>
                <Button onClick={handleConfirmAutoCalculate} disabled={saving}>
                  {saving ? 'Aplicando...' : 'Confirmar e Aplicar'}
                </Button>
              </div>
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
