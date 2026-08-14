import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useNavigate } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import Button from '../components/Button';
import Breadcrumb from '../components/Breadcrumb';
import PrizeVoucher from '../components/PrizeVoucher';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { currencySymbol } from '../utils/currencyUtils';
import { calculatePayoutAllocations } from '../utils/payoutStructure';
import {
  amountFromPercentage,
  percentageFromAmount,
  sumAmounts,
  formatPercentage,
  isValidInput,
} from '../utils/payoutEditing';
import { useEscapeKey } from '../hooks/useEscapeKey';
import './Premiacao.css';

// Fecha só quando o clique caiu no próprio fundo, não em um filho. Substitui o
// `onClick={stopPropagation}` que ficava no conteúdo do modal — aquele era um
// clique sem equivalente de teclado, e o fundo em si não é um controle.
const aoClicarNoFundo = (aoFechar) => (evento) => {
  if (evento.target === evento.currentTarget) aoFechar();
};

const getPositionLabel = (position) => `${position}°`;

/** Destaque do pódio: 1º ouro, 2º prata, 3º bronze; o resto neutro.
 *  Antes a função ignorava o argumento e devolvia sempre 'rank-other' — as
 *  três classes existiam no CSS e nunca eram aplicadas. */
const getRankClass = (position) => {
  const p = Number(position);
  return p === 1 || p === 2 || p === 3 ? `rank-${p}` : 'rank-other';
};

// ── Main Component ──────────────────────────────────────────────────────────

const Premiacao = () => {
  const { t } = useTranslation();
  const { toast, confirm } = useToast();
  const { formatCurrency, currency } = useCurrency();
  const DOC_TYPE_LABELS = {
    passport: t('premiacao.docPassport'),
    national_id: t('premiacao.docIdentity'),
    driver_license: t('premiacao.docCnh'),
  };
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

  // Esc fecha o modal aberto — sem isso, quem opera só pelo teclado só sai
  // caçando o X com o mouse.
  const fecharAdicionar = useCallback(() => setShowAddModal(false), []);
  const fecharPagamento = useCallback(() => setShowPayoutModal(false), []);
  const fecharAuto = useCallback(() => setShowAutoModal(false), []);
  const fecharComprovante = useCallback(() => setShowVoucherModal(false), []);
  useEscapeKey(showAddModal, fecharAdicionar);
  useEscapeKey(showPayoutModal, fecharPagamento);
  useEscapeKey(showAutoModal, fecharAuto);
  useEscapeKey(showVoucherModal, fecharComprovante);
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
      setError(t('premiacao.loadError'));
    } finally {
      setLoading(false);
    }
  }, [tournamentId, t]);

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
      toast.success(t('premiacao.guaranteedSaved'));
      await loadData();
    } catch (err) {
      setError(t('premiacao.guaranteedSaveError'));
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
      toast.success(t('premiacao.reservedSaved'));
      await loadData();
    } catch (err) {
      const detail = err.response?.data?.detail;
      setError(typeof detail === 'string' ? detail : t('premiacao.reservedSaveError'));
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
      toast.success(!allocation.released ? t('premiacao.releaseGranted') : t('premiacao.releaseRevoked'));
      await loadData();
    } catch (err) {
      const detail = err.response?.data?.detail;
      setError(typeof detail === 'string' ? detail : t('premiacao.releaseError'));
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
      setError(t('premiacao.visibilityError'));
    } finally {
      setSaving(false);
    }
  };

  const handleAddAllocation = async (e) => {
    e.preventDefault();
    if (!newPosition) return;
    const isVaga = newPrizeType === 'vaga';
    if (isVaga && !newVagaDayId) {
      setError(t('premiacao.selectVagaDay'));
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
      setError(typeof detail === 'string' ? detail : t('premiacao.addError'));
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteAllocation = async (allocationId) => {
    const ok = await confirm(t('premiacao.confirmRemovePosition'), { variant: 'danger', confirmText: t('premiacao.removeTitle') });
    if (!ok) return;
    try {
      setSaving(true);
      await api.delete(`/tournaments/${tournamentId}/prizes/${allocationId}`);
      await loadData();
    } catch (err) {
      const detail = err.response?.data?.detail;
      setError(typeof detail === 'string' ? detail : t('premiacao.removeError'));
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateAllocation = async (allocationId, newAmount) => {
    // Campo vazio virava NaN → null no JSON, e o backend respondia "No fields
    // to update". O operador via um erro genérico sem saber que não digitou nada.
    if (!isValidInput(newAmount)) return;
    try {
      setSaving(true);
      await api.patch(`/tournaments/${tournamentId}/prizes/${allocationId}`, {
        prize_amount: parseFloat(newAmount)
      });
      await loadData();
    } catch (err) {
      setError(t('premiacao.updateError'));
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
      toast.error(t('premiacao.noEntries'));
      return;
    }
    // A estrutura é gerada sobre o pool PAGÁVEL: o que sobra depois da
    // premiação reservada é o único dinheiro que o caixa pode entregar.
    if (payablePool <= 0) {
      toast.error(t('premiacao.prizepoolZero'));
      return;
    }

    const preview = calculatePayoutAllocations(entryCount, payablePool);
    if (preview.length === 0) {
      toast.error(t('premiacao.noStructureFound', { count: entryCount }));
      return;
    }

    setAutoEntryCount(entryCount);
    setAutoPreview(preview);
    setShowAutoModal(true);
  };

  // A prévia é RASCUNHO: nada vai para o banco antes do "Confirmar e aplicar".
  // Os campos guardam o TEXTO digitado (não o número) para o operador poder
  // apagar e redigitar sem que a linha vire NaN no meio do caminho.
  const setPreviewRow = (position, changes) =>
    setAutoPreview((prev) => prev.map((a) => (a.position === position ? { ...a, ...changes } : a)));

  const handlePreviewPercentage = (position, value) =>
    setPreviewRow(position, {
      percentage: value,
      prize_amount: isValidInput(value) ? amountFromPercentage(value, payablePool) : '',
    });

  const handlePreviewAmount = (position, value) =>
    setPreviewRow(position, {
      prize_amount: value,
      percentage: isValidInput(value)
        ? formatPercentage(percentageFromAmount(value, payablePool))
        : '',
    });

  // Só a linha tocada muda: rebalancear as outras sozinho surpreenderia quem
  // acabou de digitar um número. A sobra aparece no rodapé do modal.
  const handleRemovePreviewRow = (position) =>
    setAutoPreview((prev) => prev.filter((a) => a.position !== position));

  const handleAddPreviewRow = () =>
    setAutoPreview((prev) => [
      ...prev,
      {
        position: prev.length ? Math.max(...prev.map((a) => a.position)) + 1 : 1,
        percentage: '0',
        prize_amount: 0,
      },
    ]);

  const handleRestoreSuggestion = () =>
    setAutoPreview(calculatePayoutAllocations(autoEntryCount, payablePool));

  const handleConfirmAutoCalculate = async () => {
    try {
      setSaving(true);
      await api.post(`/tournaments/${tournamentId}/prizes/bulk`, {
        allocations: autoPreview.map(a => ({
          position: a.position,
          prize_amount: Number.parseFloat(a.prize_amount),
        })),
      });
      setShowAutoModal(false);
      toast.success(t('premiacao.autoApplied', { count: autoPreview.length }));
      await loadData();
    } catch (err) {
      const detail = err.response?.data?.detail;
      // Toast, não o banner da página: o modal do cálculo continua aberto por
      // cima e o banner ficaria ATRÁS dele. As recusas do servidor (soma acima
      // do pool pagável, torneio com faixa já paga) são justamente as que o
      // operador precisa ler para corrigir os valores antes de tentar de novo —
      // sem retorno visível ele reclica achando que o botão travou.
      toast.error(typeof detail === 'string' ? detail : t('premiacao.autoApplyError'));
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
      setPayoutDocError(t('premiacao.noPlayerWithDoc'));
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
      toast.success(t('premiacao.paymentSuccess'));

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
      setError(typeof detail === 'string' ? detail : t('premiacao.paymentError'));
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
  const allocatedPercentage = percentageFromAmount(totalAllocated, payablePool);
  const paidCount = allocations.filter(a => a.paid).length;

  // ── Prévia do cálculo automático (rascunho editável) ────────────────────
  const autoTotal = sumAmounts(autoPreview);
  const autoLeftover = payablePool - autoTotal;
  // Tolerância de 1 centavo: arredondamento não pode travar a aplicação.
  const autoOverPool = autoLeftover < -0.01;
  const autoHasInvalid = autoPreview.some(a => !isValidInput(a.prize_amount));
  // Distribuir mais do que o pool pagável é a única situação provadamente
  // impagável (o pagamento recusa lá na frente e quem fica sem receber são as
  // ÚLTIMAS posições). Sobrar dinheiro só avisa.
  const autoBlocked =
    autoOverPool || autoHasInvalid || autoPreview.length === 0 || paidCount > 0;

  const getNextPosition = () => {
    if (allocations.length === 0) return 1;
    return Math.max(...allocations.map(a => a.position)) + 1;
  };

  // Deduplicate by player_id (same player can appear in multiple days/rebuys).
  // Memoizado: só recalcula quando a lista muda (não a cada render).
  const eligiblePlayers = useMemo(() => Object.values(
    tournamentPlayers.reduce((acc, p) => {
      if (!acc[p.player_id]) acc[p.player_id] = p;
      return acc;
    }, {})
  ).sort((a, b) => (a.player_name || '').localeCompare(b.player_name || '')), [tournamentPlayers]);

  if (loading) {
    return (
      <div className="app-layout">
        <Sidebar />
        <main className="main-content">
          <div className="loading-state">{t('common.loading')}</div>
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
          { label: t('premiacao.breadcrumbHome'), to: '/' },
          { label: t('premiacao.breadcrumbTournaments'), to: '/torneios' },
          { label: t('premiacao.title') },
        ]} />
        <div className="premiacao-header">
          <div className="premiacao-title-block">
            <div className="premiacao-trophy-icon">
              <svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                <path d="M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94.63 1.5 1.98 2.63 3.61 2.96V17H7v2h10v-2h-4v-1.1c1.63-.33 2.98-1.46 3.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z"/>
              </svg>
            </div>
            <div>
              <h1>{t('premiacao.title')}</h1>
              <p className="page-subtitle">{tournament?.name}</p>
            </div>
          </div>
          <Button variant="ghost" onClick={() => navigate(-1)}>
            <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 16, height: 16, flexShrink: 0 }}>
              <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/>
            </svg>
            {t('common.back')}
          </Button>
        </div>

        {hasQualifyingDays && (
          <div className="qualifying-banner">
            <span className="banner-icon">ℹ</span>
            <span>
              {t('premiacao.qualifyingBanner')}
              {finalDayName ? `. ${t('premiacao.finalDayLabel', { name: finalDayName })}` : ''}.
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
            {t('premiacao.tabConfig')}
          </button>
          <button
            className={`prem-tab ${activeTab === 'reservada' ? 'active' : ''}`}
            onClick={() => setActiveTab('reservada')}
          >
            {t('premiacao.reservedPrize')}
          </button>
          <button
            className={`prem-tab ${activeTab === 'pagamentos' ? 'active' : ''}`}
            onClick={() => setActiveTab('pagamentos')}
          >
            {t('premiacao.tabPayments')}
            {allocations.filter(a => a.paid).length > 0 && (
              <span className="tab-badge">{allocations.filter(a => a.paid).length}</span>
            )}
          </button>
          <button
            className={`prem-tab ${activeTab === 'liberacao' ? 'active' : ''}`}
            onClick={() => setActiveTab('liberacao')}
          >
            {t('premiacao.tabRelease')}
            {allocations.filter(a => a.released && !a.paid).length > 0 && (
              <span className="tab-badge">{allocations.filter(a => a.released && !a.paid).length}</span>
            )}
          </button>
        </div>

        {/* ── TAB: PREMIAÇÃO RESERVADA ──────────────────────────────────── */}
        {activeTab === 'reservada' && (
          <div className="reserved-tab">
            <div className="summary-card reserved-card">
              <div className="card-header">
                <h3>{t('premiacao.reservedPrize')}</h3>
                <span className="card-subtitle">{t('premiacao.blockedFromPayment')}</span>
              </div>
              <div className="card-content reserved-content">
                <div className="reserved-fields-row">
                  <div className="reserved-field">
                    <label className="reserved-label">{t('premiacao.percentage')}</label>
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
                  </div>
                  <div className="reserved-field">
                    <label className="reserved-label">{t('premiacao.purpose')}</label>
                    <select
                      value={reservedPurpose}
                      onChange={(e) => setReservedPurpose(e.target.value)}
                      className="reserved-purpose-select"
                    >
                      <option value="">{t('premiacao.selectEllipsis')}</option>
                      <option value="ranking">{t('premiacao.purposeRanking')}</option>
                      <option value="staff">{t('premiacao.purposeStaff')}</option>
                    </select>
                  </div>
                </div>
                <Button
                  size="small"
                  onClick={handleSaveReserved}
                  disabled={saving}
                  className="reserved-save-btn"
                >
                  {saving ? t('common.saving') : t('common.save')}
                </Button>
                {prizeSummary?.reserved_amount > 0 && (
                  <span className="reserved-result">
                    {t('premiacao.reservedResult', { value: formatCurrency(prizeSummary?.reserved_amount) })}
                  </span>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── TAB: CONFIG ───────────────────────────────────────────────── */}
        {activeTab === 'config' && (
          <>
            {/* Summary Cards */}
            <div className="prize-summary-grid">
              <div className="summary-card guaranteed-card">
                <div className="card-header">
                  <h3>{t('premiacao.guaranteedPrize')}</h3>
                </div>
                <div className="card-content">
                  <div className="input-with-prefix">
                    <span className="prefix">{currencySymbol(currency)}</span>
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
                    {t('common.save')}
                  </Button>
                </div>
              </div>

              <div className="summary-card entries-card">
                <div className="card-header">
                  <h3>{t('premiacao.totalEntries')}</h3>
                  <span className="card-subtitle">{t('premiacao.sumOfAllDays')}</span>
                </div>
                <div className="card-value">{formatCurrency(prizeSummary?.total_entries)}</div>
              </div>

              <div className="summary-card player-pool-card">
                <div className="card-header">
                  <h3>{t('premiacao.playerPool')}</h3>
                  <span className="card-subtitle">{t('premiacao.percentOfEntries', { percent: 100 - parseFloat(prizeSummary?.rake_percentage || 20) })}</span>
                </div>
                <div className="card-value">{formatCurrency(prizeSummary?.player_pool)}</div>
              </div>

              <div className="summary-card rake-card">
                <div className="card-header">
                  <h3>{t('premiacao.rake')}</h3>
                  <span className="card-subtitle">{parseFloat(prizeSummary?.rake_percentage || 20).toFixed(0)}%</span>
                </div>
                <div className="card-value">
                  {formatCurrency(
                    (parseFloat(prizeSummary?.total_entries || 0) * (parseFloat(prizeSummary?.rake_percentage || 20) / 100))
                  )}
                </div>
              </div>
            </div>

            {/* Allocations Section */}
            <div className="prize-pool-section">
              <div className="pool-header">
                <div className="pool-info">
                  <div className="pool-item available">
                    <span className="pool-label">{t('premiacao.prizepoolAvailable')}</span>
                    <span className="pool-value">{formatCurrency(availablePrizePool)}</span>
                    <span className="pool-note">{t('premiacao.guaranteedPlusPool')}</span>
                  </div>
                  <div className="pool-item allocated">
                    <span className="pool-label">{t('premiacao.totalAllocated')}</span>
                    <span className="pool-value">{formatCurrency(totalAllocated)}</span>
                  </div>
                  <div className={`pool-item remaining ${remainingBalance < 0 ? 'negative' : ''}`}>
                    <span className="pool-label">{t('premiacao.remainingBalance')}</span>
                    <span className="pool-value">{formatCurrency(remainingBalance)}</span>
                    {remainingBalance < 0 && (
                      <span className="pool-warning">{t('premiacao.allocationExceeds')}</span>
                    )}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <Button variant="secondary" onClick={handleOpenAutoCalculate}>
                    {t('premiacao.calculateAuto')}
                  </Button>
                  <Button onClick={() => {
                    setNewPosition(getNextPosition().toString());
                    setNewAmount('');
                    setShowAddModal(true);
                  }}>
                    {t('premiacao.addPosition')}
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
                    <h3>{t('premiacao.noPrizesConfigured')}</h3>
                    <p>{t('premiacao.addPositionsHint')}</p>
                  </div>
                ) : (
                  <table className="allocations-table">
                    <thead>
                      <tr>
                        <th>{t('premiacao.position')}</th>
                        <th>{t('premiacao.prize')}</th>
                        <th>
                          {t('premiacao.percentOfPool')}
                          {/* O pool cresce com late entries: sem dizer qual é a
                              base, o operador não entende por que o % mudou
                              sozinho depois de gravar o valor. */}
                          <span className="percent-base-note">
                            {t('premiacao.percentBaseNote', 'base: pool pagável')}
                          </span>
                        </th>
                        <th>{t('premiacao.actions')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {allocations.map((allocation) => (
                        <ConfigAllocationRow
                          key={allocation.id}
                          allocation={allocation}
                          poolBase={payablePool}
                          onUpdate={handleUpdateAllocation}
                          onDelete={handleDeleteAllocation}
                          saving={saving}
                        />
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td><strong>{t('premiacao.total')}</strong></td>
                        <td><strong>{formatCurrency(totalAllocated)}</strong></td>
                        <td className={`percent-total ${allocatedPercentage > 100 ? 'negative' : ''}`}>
                          <strong>{formatPercentage(allocatedPercentage)}%</strong>
                          {allocatedPercentage > 100 && (
                            <span className="pool-warning">{t('premiacao.allocationExceeds')}</span>
                          )}
                        </td>
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
                  <span className="pool-label">{t('premiacao.releasedColumn')}</span>
                  <span className="pool-value">{allocations.filter(a => a.released).length}/{allocations.length}</span>
                  <span className="pool-note">{t('premiacao.onlyReleasedPaid')}</span>
                </div>
              </div>
            </div>
            <div className="allocations-table-container">
              {allocations.length === 0 ? (
                <div className="prem-empty">
                  <h3>{t('premiacao.noPrizesConfigured')}</h3>
                  <p>{t('premiacao.configBeforeRelease')}</p>
                </div>
              ) : (
                <table className="allocations-table">
                  <thead>
                    <tr>
                      <th>{t('premiacao.position')}</th>
                      <th>{t('premiacao.player')}</th>
                      <th>{t('premiacao.prize')}</th>
                      <th>{t('premiacao.visiblePublic')}</th>
                      <th>{t('premiacao.release')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allocations.map((allocation) => (
                      <tr key={allocation.id} className={allocation.paid ? 'row-paid' : ''}>
                        <td>{getPositionLabel(allocation.position)}</td>
                        <td>{allocation.player_name || '—'}</td>
                        <td>
                          {formatCurrency(allocation.prize_amount)}
                          {allocation.prize_type === 'vaga' && (
                            <span className="status-badge" style={{ marginLeft: 6, background: 'rgba(155,89,182,.18)', color: '#9b59b6' }}>{t('premiacao.vaga')}</span>
                          )}
                        </td>
                        <td>
                          <button
                            type="button"
                            className={`prem-toggle ${allocation.visible ? 'on' : 'off'}`}
                            onClick={() => handleToggleVisible(allocation)}
                            disabled={saving}
                            title={allocation.visible ? t('premiacao.visibleInPublic') : t('premiacao.hiddenFromPublic')}
                          >
                            {allocation.visible ? t('premiacao.toggleVisible') : t('premiacao.toggleHidden')}
                          </button>
                        </td>
                        <td>
                          {allocation.paid ? (
                            <span className="status-badge paid">{t('premiacao.statusPaid')}</span>
                          ) : (
                            <button
                              type="button"
                              className={`prem-toggle ${allocation.released ? 'on' : 'off'}`}
                              onClick={() => handleToggleRelease(allocation)}
                              disabled={saving}
                            >
                              {allocation.released ? t('premiacao.releasedRevoke') : t('premiacao.releaseAction')}
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
                <h3>{t('premiacao.noPositionConfigured')}</h3>
                <p>{t('premiacao.configFirst')}</p>
              </div>
            ) : (
              <table className="allocations-table">
                <thead>
                  <tr>
                    <th>{t('premiacao.position')}</th>
                    <th>{t('premiacao.prize')}</th>
                    <th>{t('premiacao.player')}</th>
                    <th>{t('premiacao.statusColumn')}</th>
                    <th>{t('premiacao.actionColumn')}</th>
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
          <div className="modal-overlay" role="presentation" onClick={aoClicarNoFundo(fecharAdicionar)}>
            <div className="modal">
              <div className="modal-header">
                <h2>{t('premiacao.addPrizeModalTitle')}</h2>
                <button className="close-btn" onClick={() => setShowAddModal(false)}>
                  ✕
                </button>
              </div>
              <form onSubmit={handleAddAllocation}>
                <div className="form-group">
                  <label>{t('premiacao.positionRequired')}</label>
                  <input
                    type="number"
                    min="1"
                    value={newPosition}
                    onChange={(e) => setNewPosition(e.target.value)}
                    required
                    placeholder={t('premiacao.positionPlaceholder')}
                  />
                  <small>{t('premiacao.positionHint')}</small>
                </div>
                <div className="form-group">
                  <label>{t('premiacao.prizeType')}</label>
                  <select value={newPrizeType} onChange={(e) => setNewPrizeType(e.target.value)}>
                    <option value="cash">{t('premiacao.prizeTypeCash')}</option>
                    <option value="vaga">{t('premiacao.prizeTypeVaga')}</option>
                  </select>
                </div>
                {newPrizeType === 'vaga' ? (
                  <div className="form-group">
                    <label>{t('premiacao.vagaTargetDay')}</label>
                    <select
                      value={newVagaDayId}
                      onChange={(e) => setNewVagaDayId(e.target.value)}
                      required
                    >
                      <option value="">{t('premiacao.selectDayEllipsis')}</option>
                      {days.map((d) => (
                        <option key={d.id} value={d.id}>
                          {t('premiacao.vagaDayOption', { dayName: d.day_name, buyIn: formatCurrency(d.buy_in) })}
                        </option>
                      ))}
                    </select>
                    <small>{t('premiacao.vagaHint')}</small>
                  </div>
                ) : (
                  <div className="form-group">
                    <label>{t('premiacao.prizeAmountRequired')}</label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={newAmount}
                      onChange={(e) => setNewAmount(e.target.value)}
                      placeholder="0.00"
                    />
                    <small>{t('premiacao.availableBalance', { value: formatCurrency(remainingBalance) })}</small>
                  </div>
                )}
                <div className="modal-actions">
                  <Button type="button" variant="ghost" onClick={() => setShowAddModal(false)}>
                    {t('common.cancel')}
                  </Button>
                  <Button type="submit" disabled={saving}>
                    {saving ? t('common.saving') : t('common.add')}
                  </Button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* ── Modal: Payout ─────────────────────────────────────────────── */}
        {showPayoutModal && payoutAllocation && (
          <div className="modal-overlay" role="presentation" onClick={aoClicarNoFundo(fecharPagamento)}>
            <div className="modal payout-modal">
              <div className="modal-header">
                <h2>{t('premiacao.registerPayment')}</h2>
                <button className="close-btn" onClick={() => setShowPayoutModal(false)}>
                  ✕
                </button>
              </div>

              <div className="payout-position-header">
                <span className="payout-position-label">{getPositionLabel(payoutAllocation.position)}</span>
                <span className="payout-prize-value">{formatCurrency(payoutAllocation.prize_amount)}</span>
              </div>

              {prizePoolInfo && (
                <div className="payout-balance-info">
                  <div className="payout-balance-row">
                    <span>{t('premiacao.tournamentPrizePool')}</span>
                    <span>{formatCurrency(prizePoolInfo.prize_pool)}</span>
                  </div>
                  <div className="payout-balance-row">
                    <span>{t('premiacao.alreadyPaid')}</span>
                    <span>{formatCurrency(prizePoolInfo.total_paid)}</span>
                  </div>
                  <div className="payout-balance-row payout-balance-row--highlight">
                    <span>{t('premiacao.availableInPool')}</span>
                    <span className={prizePoolInfo.available >= parseFloat(payoutAllocation.prize_amount) ? 'payout-ok' : 'payout-warn'}>
                      {formatCurrency(prizePoolInfo.available)}
                    </span>
                  </div>
                  {generalCashBalance !== null && (
                    <div className="payout-balance-row">
                      <span>{t('premiacao.generalCashBalance')}</span>
                      <span className={generalCashBalance >= parseFloat(payoutAllocation.prize_amount) ? 'payout-ok' : 'payout-warn'}>
                        {formatCurrency(generalCashBalance)}
                      </span>
                    </div>
                  )}
                </div>
              )}

              <form onSubmit={handleConfirmPayout}>
                <div className="form-group">
                  <label>{t('premiacao.documentNumberRequired')}</label>
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
                    placeholder={t('premiacao.docNumberPlaceholder')}
                    style={
                      payoutDocError
                        ? { borderColor: '#ef4444' }
                        : payoutResolvedPlayer
                          ? { borderColor: '#7233f8' }
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
                      {t('premiacao.playerResolved', { name: '' })}<strong>{payoutResolvedPlayer.name}</strong>
                      {payoutResolvedPlayer.nickname && (
                        <span className="player-nickname"> ({payoutResolvedPlayer.nickname})</span>
                      )}
                      {' — '}
                      {DOC_TYPE_LABELS[payoutResolvedPlayer.document_type] || payoutResolvedPlayer.document_type}
                    </span>
                  </div>
                ) : payoutDocNumber.trim() ? (
                  <div className="doc-error-msg" style={{ marginBottom: '1rem' }}>
                    {t('premiacao.noPlayerWithDoc')}
                  </div>
                ) : null}

                <div className="form-group">
                  <label>{t('premiacao.attendantOptional')}</label>
                  <input
                    type="text"
                    value={payoutPaidBy}
                    onChange={(e) => setPayoutPaidBy(e.target.value)}
                    placeholder={t('premiacao.staffNamePlaceholder')}
                  />
                </div>

                <div className="payout-doc-note">
                  {t('premiacao.docNote')}
                </div>

                <div className="modal-actions">
                  <Button type="button" variant="secondary" onClick={() => setShowPayoutModal(false)}>
                    {t('common.cancel')}
                  </Button>
                  <Button type="submit" disabled={payoutSaving}>
                    {payoutSaving ? t('premiacao.processing') : t('premiacao.confirmPayment')}
                  </Button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* ── Modal: Auto Calculate ──────────────────────────────────────── */}
        {showAutoModal && (
          <div className="modal-overlay" role="presentation" onClick={aoClicarNoFundo(fecharAuto)}>
            <div className="modal auto-calc-modal">
              <div className="modal-header">
                <h2>{t('premiacao.autoCalcModalTitle')}</h2>
                <button className="close-btn" onClick={() => setShowAutoModal(false)}>✕</button>
              </div>

              <div className="auto-calc-summary">
                <div className="auto-calc-stat">
                  <span className="auto-calc-label">{t('premiacao.entriesDetected')}</span>
                  <span className="auto-calc-value">{autoEntryCount}</span>
                </div>
                <div className="auto-calc-stat">
                  {/* A estrutura é distribuída sobre o pool PAGÁVEL: usar o
                      bruto geraria uma premiação maior que o dinheiro que o
                      caixa pode entregar em torneios com reserva. */}
                  <span className="auto-calc-label">{t('premiacao.payablePoolShort', 'Pool pagável')}</span>
                  <span className="auto-calc-value">{formatCurrency(payablePool)}</span>
                </div>
                <div className="auto-calc-stat">
                  <span className="auto-calc-label">{t('premiacao.awardedPositions')}</span>
                  <span className="auto-calc-value">{autoPreview.length}</span>
                </div>
              </div>

              {allocations.length > 0 && (
                <div className="auto-calc-warning">
                  {t('premiacao.positionsReplaced', { count: allocations.length })}
                </div>
              )}

              {/* Aplicar apaga TODAS as faixas e recria: uma faixa já paga
                  perderia o registro do dinheiro que saiu do caixa. O backend
                  recusa; aqui a gente nem deixa chegar lá. */}
              {paidCount > 0 && (
                <div className="auto-calc-warning auto-calc-blocked">
                  {t('premiacao.autoBlockedByPaid', 'Há posições já pagas; o recálculo apagaria o registro do pagamento.')}
                </div>
              )}

              <div className="auto-calc-hint">
                {t('premiacao.autoEditHint', 'Ajuste o percentual ou o valor de cada posição antes de aplicar.')}
              </div>

              <div className="auto-calc-table-wrap">
                <table className="allocations-table">
                  <thead>
                    <tr>
                      <th>{t('premiacao.position')}</th>
                      <th>{t('premiacao.percentOfPool')}</th>
                      <th>{t('premiacao.value')}</th>
                      <th>{t('premiacao.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {autoPreview.map((a) => (
                      <tr key={a.position}>
                        <td className="position-cell">
                          <span className="position-badge rank-other">{getPositionLabel(a.position)}</span>
                        </td>
                        <td className="percentage-cell">
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            className="preview-input preview-percent"
                            aria-label={t('premiacao.percentOfPool')}
                            value={a.percentage}
                            onChange={(e) => handlePreviewPercentage(a.position, e.target.value)}
                          />%
                        </td>
                        <td className="amount-cell">
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            className="preview-input preview-amount"
                            aria-label={t('premiacao.value')}
                            value={a.prize_amount}
                            onChange={(e) => handlePreviewAmount(a.position, e.target.value)}
                          />
                        </td>
                        <td className="actions-cell">
                          <button
                            type="button"
                            className="btn-small btn-delete"
                            onClick={() => handleRemovePreviewRow(a.position)}
                            title={t('premiacao.removeTitle')}
                          >
                            X
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td><strong>{t('premiacao.total')}</strong></td>
                      <td className="percentage-cell">
                        <strong>{formatPercentage(percentageFromAmount(autoTotal, payablePool))}%</strong>
                      </td>
                      <td className="amount-cell"><strong>{formatCurrency(autoTotal)}</strong></td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              <div className={`auto-calc-totals ${autoOverPool ? 'negative' : ''}`}>
                {autoOverPool ? (
                  <span className="auto-calc-over">
                    {t('premiacao.previewOverPool', 'Acima do pool pagável em')}{' '}
                    {formatCurrency(-autoLeftover)}
                  </span>
                ) : (
                  <span className="auto-calc-leftover">
                    {t('premiacao.previewLeftover', 'Sobra do pool pagável:')}{' '}
                    {formatCurrency(autoLeftover)}
                  </span>
                )}
              </div>

              <div className="modal-actions">
                <Button type="button" variant="ghost" onClick={() => setShowAutoModal(false)}>
                  {t('common.cancel')}
                </Button>
                <Button type="button" variant="secondary" onClick={handleAddPreviewRow}>
                  {t('premiacao.addPreviewRow', 'Adicionar posição')}
                </Button>
                <Button type="button" variant="secondary" onClick={handleRestoreSuggestion}>
                  {t('premiacao.restoreSuggestion', 'Restaurar sugestão')}
                </Button>
                <Button onClick={handleConfirmAutoCalculate} disabled={saving || autoBlocked}>
                  {saving ? t('premiacao.applying') : t('premiacao.confirmAndApply')}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* ── Modal: Voucher ─────────────────────────────────────────────── */}
        {showVoucherModal && voucherData && (
          <div className="modal-overlay" role="presentation" onClick={aoClicarNoFundo(fecharComprovante)}>
            <div className="modal">
              <div className="modal-header">
                <h2>{t('premiacao.paymentVoucher')}</h2>
                <button className="close-btn" onClick={() => setShowVoucherModal(false)}>
                  ✕
                </button>
              </div>
              <div className="modal-body">
                <PrizeVoucher payout={voucherData} />
              </div>
              <div className="modal-actions">
                <Button onClick={() => setShowVoucherModal(false)}>{t('common.close')}</Button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

// ── Config Tab Row ───────────────────────────────────────────────────────────

/**
 * Valor da faixa clicável para editar. Quando dá para editar é um <button> de
 * verdade — foco, Enter e Espaço vêm de graça, e quem opera só pelo teclado
 * alcança a edição. Travado (faixa paga ou vaga), volta a ser só texto, para o
 * Tab não parar num campo que não faz nada.
 */
const ValorEditavel = ({ podeEditar, aoEditar, titulo, children }) => {
  if (!podeEditar) {
    return <span className="editable-value" title={titulo}>{children}</span>;
  }
  return (
    <button type="button" className="editable-value clickable" onClick={aoEditar} title={titulo}>
      {children}
    </button>
  );
};

const ConfigAllocationRow = ({ allocation, poolBase, onUpdate, onDelete, saving }) => {
  const { t } = useTranslation();
  const { formatCurrency } = useCurrency();
  // 'amount' | 'percent' | null — um campo por vez, para não gravar dois
  // números conflitantes na mesma faixa.
  const [editing, setEditing] = useState(null);
  const [editValue, setEditValue] = useState('');

  const percentage = percentageFromAmount(allocation.prize_amount, poolBase);

  // A vaga vale o buy-in do dia alvo (o backend recalcula). Editar valor ou
  // percentual aqui desconfiguraria a vaga sem avisar ninguém.
  const isVaga = allocation.prize_type === 'vaga';
  const canEdit = !allocation.paid && !isVaga;

  // Clicar num campo bloqueado e nada acontecer faz o operador achar que a tela
  // travou (antes da vaga, essa faixa era editável). O motivo vai no title dos
  // dois campos e num selo ao lado do valor, para ele saber que o número está
  // certo e vem do dia alvo.
  const motivoBloqueio = isVaga
    ? t(
        'premiacao.vagaNotEditable',
        'Esta faixa é uma vaga: vale o buy-in do dia alvo e é calculada pelo sistema.'
      )
    : allocation.paid
      ? t('premiacao.cannotEditPaid', 'Faixa já paga: o valor não pode mais ser alterado.')
      : null;

  // O estado era inicializado UMA vez e ficava velho quando o valor mudava por
  // outro caminho (cálculo automático, outro operador). Agora ele é carregado
  // na hora de abrir a edição.
  const startEditing = (campo) => {
    if (!canEdit) return;
    setEditValue(campo === 'percent' ? formatPercentage(percentage) : String(allocation.prize_amount));
    setEditing(campo);
  };

  const handleSave = () => {
    if (!isValidInput(editValue)) return;
    // O que vai para o banco é SEMPRE o valor em dinheiro; o percentual é só
    // um modo de entrada e não é persistido.
    onUpdate(
      allocation.id,
      editing === 'percent' ? amountFromPercentage(editValue, poolBase) : editValue
    );
    setEditing(null);
  };

  const handleCancel = () => {
    setEditValue('');
    setEditing(null);
  };

  return (
    <tr className={allocation.paid ? 'paid-row' : ''}>
      <td className="position-cell">
        <span className={`position-badge ${getRankClass(allocation.position)}`}>{getPositionLabel(allocation.position)}</span>
        {allocation.paid && <span className="paid-inline-badge">{t('premiacao.statusPaid')}</span>}
      </td>
      <td className="amount-cell">
        {editing === 'amount' ? (
          <div className="inline-edit">
            <input
              type="number"
              min="0"
              step="0.01"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              autoFocus
            />
            <button type="button" className="btn-save" onClick={handleSave} disabled={saving || !isValidInput(editValue)}>OK</button>
            <button type="button" className="btn-cancel" onClick={handleCancel}>X</button>
          </div>
        ) : (
          <ValorEditavel
            podeEditar={canEdit}
            aoEditar={() => startEditing('amount')}
            titulo={motivoBloqueio || t('premiacao.editAmount', 'Editar o valor da faixa')}
          >
            {formatCurrency(allocation.prize_amount)}
            {isVaga && (
              <span className="vaga-inline-badge" title={motivoBloqueio}>
                {t('premiacao.vagaBadge', 'vaga')}
              </span>
            )}
          </ValorEditavel>
        )}
      </td>
      <td className="percentage-cell">
        {editing === 'percent' ? (
          <div className="inline-edit">
            <input
              type="number"
              min="0"
              step="0.01"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              autoFocus
            />
            {/* Prévia em dinheiro: o operador vê o que será gravado ANTES de
                confirmar — é o valor, não o percentual, que o caixa paga. */}
            <span className="percent-preview">
              {t('premiacao.percentageResultingValue', 'vale')}{' '}
              {formatCurrency(amountFromPercentage(editValue, poolBase))}
            </span>
            <button type="button" className="btn-save" onClick={handleSave} disabled={saving || !isValidInput(editValue)}>OK</button>
            <button type="button" className="btn-cancel" onClick={handleCancel}>X</button>
          </div>
        ) : (
          <ValorEditavel
            podeEditar={canEdit}
            aoEditar={() => startEditing('percent')}
            titulo={motivoBloqueio || t('premiacao.editPercentage', 'Editar o percentual da faixa')}
          >
            {formatPercentage(percentage)}%
          </ValorEditavel>
        )}
      </td>
      <td className="actions-cell">
        <button
          className="btn-small btn-delete"
          onClick={() => onDelete(allocation.id)}
          disabled={saving || allocation.paid}
          title={allocation.paid ? t('premiacao.cannotRemovePaid') : t('premiacao.removeTitle')}
        >
          X
        </button>
      </td>
    </tr>
  );
};

// ── Payout Tab Row ───────────────────────────────────────────────────────────

const PayoutRow = ({ allocation, onPay, onViewVoucher }) => {
  const { t } = useTranslation();
  const { formatCurrency } = useCurrency();
  return (
    <tr className={allocation.paid ? 'paid-row' : ''}>
      <td className="position-cell">
        <span className={`position-badge ${getRankClass(allocation.position)}`}>{getPositionLabel(allocation.position)}</span>
      </td>
      <td className="amount-cell">
        <strong>{formatCurrency(allocation.prize_amount)}</strong>
      </td>
      <td className="player-cell">
        {allocation.player_name
          ? <span className="player-assigned">{allocation.player_name}</span>
          : <span className="not-assigned">{t('premiacao.notAssigned')}</span>
        }
      </td>
      <td className="status-cell">
        {allocation.paid
          ? <span className="status-badge paid">{t('premiacao.statusPaid')}</span>
          : <span className="status-badge pending">{t('premiacao.statusPending')}</span>
        }
      </td>
      <td className="actions-cell">
        {allocation.paid ? (
          <button className="btn-small btn-view" onClick={() => onViewVoucher(allocation)}>
            {t('premiacao.voucher')}
          </button>
        ) : (
          <button className="btn-small btn-pay" onClick={onPay}>
            {t('premiacao.pay')}
          </button>
        )}
      </td>
    </tr>
  );
};

export default Premiacao;
