import React, { useEffect, useState, useCallback } from 'react';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import Button from '../components/Button';
import PlayerSelect from '../components/PlayerSelect';
import EmptyState from '../components/EmptyState';
import { SkeletonStatCard, SkeletonTableRow } from '../components/SkeletonLoader';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { useTranslation } from 'react-i18next';
import './CaixaJogadores.css';

const CaixaJogadores = () => {
  const { toast } = useToast();
  const { formatCurrency } = useCurrency();
  const { t } = useTranslation();

  // Player selection
  const [selectedPlayerId, setSelectedPlayerId] = useState('');

  // Data
  const [summary, setSummary] = useState(null);
  const [statement, setStatement] = useState([]);
  const [credits, setCredits] = useState([]);
  const [sponsors, setSponsors] = useState([]);
  const [loading, setLoading] = useState(false);

  // Filters
  const [filters, setFilters] = useState({
    category: '',
    type: '',
    date_from: '',
    date_to: '',
  });

  // Modals
  const [showCreditModal, setShowCreditModal] = useState(false);
  const [showSponsorModal, setShowSponsorModal] = useState(false);
  const [creditForm, setCreditForm] = useState({
    sponsor_id: '',
    amount: '',
    notes: '',
  });
  const [sponsorForm, setSponsorForm] = useState({
    name: '',
    email: '',
    phone: '',
    contact_person: '',
  });

  // Load sponsors on mount
  useEffect(() => {
    loadSponsors();
  }, []);

  const loadSponsors = async () => {
    try {
      const res = await api.get('/sponsors');
      setSponsors(res.data || []);
    } catch (err) {
      console.error('Error loading sponsors:', err);
    }
  };

  const loadPlayerData = useCallback(async (playerId) => {
    if (!playerId) {
      setSummary(null);
      setStatement([]);
      setCredits([]);
      return;
    }

    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filters.category) params.set('category', filters.category);
      if (filters.type) params.set('type', filters.type);
      if (filters.date_from) params.set('date_from', filters.date_from);
      if (filters.date_to) params.set('date_to', filters.date_to);

      const [summaryRes, statementRes, creditsRes] = await Promise.all([
        api.get(`/player-credits/player/${playerId}/summary`),
        api.get(`/player-credits/player/${playerId}/statement?${params.toString()}`),
        api.get(`/player-credits/player/${playerId}/credits`),
      ]);

      setSummary(summaryRes.data);
      setStatement(statementRes.data || []);
      setCredits(creditsRes.data || []);
    } catch (err) {
      console.error('Error loading player data:', err);
      toast.error(t('playerCash.loadDataError'));
    } finally {
      setLoading(false);
    }
  }, [filters, toast, t]);

  useEffect(() => {
    if (selectedPlayerId) {
      loadPlayerData(selectedPlayerId);
    }
  }, [selectedPlayerId, loadPlayerData]);

  const handlePlayerChange = (e) => {
    setSelectedPlayerId(e.target.value);
  };

  const handleFilterChange = (e) => {
    const { name, value } = e.target;
    setFilters(prev => ({ ...prev, [name]: value }));
  };

  const applyFilters = () => {
    if (selectedPlayerId) {
      loadPlayerData(selectedPlayerId);
    }
  };

  const clearFilters = () => {
    setFilters({ category: '', type: '', date_from: '', date_to: '' });
  };

  // ---- Credit Grant ----
  const handleGrantCredit = async (e) => {
    e.preventDefault();
    if (!selectedPlayerId) {
      toast.warning(t('playerCash.selectPlayerFirst'));
      return;
    }
    try {
      await api.post('/player-credits', {
        player_id: selectedPlayerId,
        sponsor_id: creditForm.sponsor_id,
        amount: parseFloat(creditForm.amount),
        notes: creditForm.notes || null,
      });
      toast.success(t('playerCash.creditGrantedSuccess'));
      setShowCreditModal(false);
      setCreditForm({ sponsor_id: '', amount: '', notes: '' });
      loadPlayerData(selectedPlayerId);
    } catch (err) {
      const msg = err.response?.data?.detail || t('playerCash.grantCreditError');
      toast.error(msg);
    }
  };

  // ---- Create Sponsor ----
  const handleCreateSponsor = async (e) => {
    e.preventDefault();
    try {
      await api.post('/sponsors', sponsorForm);
      toast.success(t('playerCash.sponsorCreatedSuccess'));
      setShowSponsorModal(false);
      setSponsorForm({ name: '', email: '', phone: '', contact_person: '' });
      loadSponsors();
    } catch (err) {
      toast.error(t('playerCash.createSponsorError'));
    }
  };

  // ---- Cancel Credit ----
  const handleCancelCredit = async (creditId) => {
    if (!window.confirm(t('playerCash.confirmCancelCredit'))) return;
    try {
      await api.post(`/player-credits/${creditId}/cancel`);
      toast.success(t('playerCash.creditCancelledSuccess'));
      loadPlayerData(selectedPlayerId);
    } catch (err) {
      const msg = err.response?.data?.detail || t('playerCash.cancelCreditError');
      toast.error(msg);
    }
  };

  // ---- Badge helpers ----
  const getTypeBadge = (type) => {
    const map = {
      buy_in: { label: t('playerCash.typeBuyIn'), cls: 'badge-success' },
      rebuy: { label: t('playerCash.typeRebuy'), cls: 'badge-warning' },
      addon: { label: t('playerCash.typeAddon'), cls: 'badge-info' },
      prize: { label: t('playerCash.typePrize'), cls: 'badge-prize' },
      credit_granted: { label: t('playerCash.typeCreditGranted'), cls: 'badge-credit' },
      credit_used_buyin: { label: t('playerCash.typeCreditUsedBuyin'), cls: 'badge-credit-used' },
      credit_used_rebuy: { label: t('playerCash.typeCreditUsedRebuy'), cls: 'badge-credit-used' },
      credit_used_addon: { label: t('playerCash.typeCreditUsedAddon'), cls: 'badge-credit-used' },
      prize_deduction: { label: t('playerCash.typePrizeDeduction'), cls: 'badge-deduction' },
      sponsor_payment: { label: t('playerCash.typeSponsorPayment'), cls: 'badge-sponsor' },
      credit_cancelled: { label: t('playerCash.typeCreditCancelled'), cls: 'badge-cancelled' },
      credit_refund: { label: t('playerCash.typeCreditRefund'), cls: 'badge-refund' },
    };
    const badge = map[type] || { label: type, cls: 'badge-default' };
    return <span className={`badge ${badge.cls}`}>{badge.label}</span>;
  };

  const getCreditStatusBadge = (status) => {
    const map = {
      active: { label: t('playerCash.statusActive'), cls: 'cj-status--active' },
      fully_used: { label: t('playerCash.statusFullyUsed'), cls: 'cj-status--used' },
      settled_by_prize: { label: t('playerCash.statusSettledByPrize'), cls: 'cj-status--settled' },
      settled_by_sponsor: { label: t('playerCash.statusSettledBySponsor'), cls: 'cj-status--settled' },
      cancelled: { label: t('playerCash.statusCancelled'), cls: 'cj-status--cancelled' },
    };
    const s = map[status] || { label: status, cls: '' };
    return <span className={`cj-status-badge ${s.cls}`}>{s.label}</span>;
  };

  const isIncoming = (type) => ['credit_granted', 'prize', 'credit_refund'].includes(type);

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        {/* Header */}
        <div className="cx-header">
          <div className="cx-header-left">
            <div className="cx-header-icon">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
              </svg>
            </div>
            <div>
              <h1 className="cx-title">{t('playerCash.title')}</h1>
              <p className="cx-subtitle">{t('playerCash.subtitle')}</p>
            </div>
          </div>
          <div className="cj-header-actions">
            <Button variant="secondary" onClick={() => setShowSponsorModal(true)}>
              {t('playerCash.addSponsor')}
            </Button>
            {selectedPlayerId && (
              <Button onClick={() => setShowCreditModal(true)}>
                {t('playerCash.grantCredit')}
              </Button>
            )}
          </div>
        </div>

        {/* Player Selector */}
        <Card className="cj-player-selector">
          <div className="form-group">
            <label>{t('playerCash.selectPlayerLabel')}</label>
            <PlayerSelect
              value={selectedPlayerId}
              onChange={handlePlayerChange}
              name="player_id"
            />
          </div>
        </Card>

        {selectedPlayerId && (
          <>
            {/* Balance Summary */}
            <div className="stats-grid">
              {loading && !summary ? (
                <>
                  <SkeletonStatCard />
                  <SkeletonStatCard />
                  <SkeletonStatCard />
                  <SkeletonStatCard />
                </>
              ) : summary ? (
                <>
                  <Card className="stat-card">
                    <div className="stat-info">
                      <h3 className="cj-stat-positive">{formatCurrency(summary.total_credits_received)}</h3>
                      <p>{t('playerCash.creditsReceived')}</p>
                    </div>
                  </Card>
                  <Card className="stat-card">
                    <div className="stat-info">
                      <h3 className="cj-stat-highlight">{formatCurrency(summary.total_credits_remaining)}</h3>
                      <p>{t('playerCash.creditAvailable')}</p>
                    </div>
                  </Card>
                  <Card className="stat-card">
                    <div className="stat-info">
                      <h3>{formatCurrency(summary.total_credits_used)}</h3>
                      <p>{t('playerCash.creditUsed')}</p>
                    </div>
                  </Card>
                  <Card className="stat-card">
                    <div className="stat-info">
                      <h3 className="cj-stat-warning">{formatCurrency(summary.total_sponsor_owes)}</h3>
                      <p>{t('playerCash.sponsorOwes')}</p>
                    </div>
                  </Card>
                </>
              ) : null}
            </div>

            {/* Active Credits */}
            {credits.length > 0 && (
              <Card title={t('playerCash.creditsCardTitle')} className="cj-credits-card">
                <div className="table-container">
                  <table className="transactions-table">
                    <thead>
                      <tr>
                        <th>{t('playerCash.colSponsor')}</th>
                        <th>{t('playerCash.colOriginal')}</th>
                        <th>{t('playerCash.colAvailable')}</th>
                        <th>{t('playerCash.colUsed')}</th>
                        <th>{t('playerCash.colPrizeDeduction')}</th>
                        <th>{t('playerCash.colSponsorOwes')}</th>
                        <th>{t('common.status')}</th>
                        <th>{t('common.actions')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {credits.map((c) => (
                        <tr key={c.id}>
                          <td>{c.sponsor_name}</td>
                          <td>{formatCurrency(c.original_amount)}</td>
                          <td className="cj-amount-positive">{formatCurrency(c.remaining_amount)}</td>
                          <td>{formatCurrency(c.used_amount)}</td>
                          <td>{formatCurrency(c.prize_deduction_amount)}</td>
                          <td className={c.sponsor_owes > 0 ? 'cj-amount-warning' : ''}>{formatCurrency(c.sponsor_owes)}</td>
                          <td>{getCreditStatusBadge(c.status)}</td>
                          <td>
                            {c.status === 'active' && c.used_amount === 0 && (
                              <button
                                className="cj-action-btn cj-action-btn--danger"
                                onClick={() => handleCancelCredit(c.id)}
                                title={t('playerCash.cancelCreditTitle')}
                              >
                                {t('common.cancel')}
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}

            {/* Filters */}
            <Card className="cj-filters-card">
              <div className="cj-filters">
                <div className="form-group">
                  <label>{t('playerCash.filterCategory')}</label>
                  <select name="category" value={filters.category} onChange={handleFilterChange}>
                    <option value="">{t('playerCash.filterAllCategories')}</option>
                    <option value="transaction">{t('playerCash.filterTransactions')}</option>
                    <option value="credit">{t('playerCash.filterCredits')}</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>{t('playerCash.filterType')}</label>
                  <select name="type" value={filters.type} onChange={handleFilterChange}>
                    <option value="">{t('playerCash.filterAllTypes')}</option>
                    <option value="buy_in">{t('playerCash.optBuyIn')}</option>
                    <option value="rebuy">{t('playerCash.optRebuy')}</option>
                    <option value="addon">{t('playerCash.optAddon')}</option>
                    <option value="prize">{t('playerCash.optPrize')}</option>
                    <option value="credit_granted">{t('playerCash.optCreditGranted')}</option>
                    <option value="credit_used_buyin">{t('playerCash.optCreditUsedBuyin')}</option>
                    <option value="credit_used_rebuy">{t('playerCash.optCreditUsedRebuy')}</option>
                    <option value="credit_used_addon">{t('playerCash.optCreditUsedAddon')}</option>
                    <option value="prize_deduction">{t('playerCash.optPrizeDeduction')}</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>{t('playerCash.filterFrom')}</label>
                  <input type="date" name="date_from" value={filters.date_from} onChange={handleFilterChange} />
                </div>
                <div className="form-group">
                  <label>{t('playerCash.filterTo')}</label>
                  <input type="date" name="date_to" value={filters.date_to} onChange={handleFilterChange} />
                </div>
                <div className="cj-filter-actions">
                  <Button variant="secondary" onClick={clearFilters}>{t('common.clear')}</Button>
                  <Button onClick={applyFilters}>{t('common.filter')}</Button>
                </div>
              </div>
            </Card>

            {/* Statement */}
            <Card title={t('playerCash.statementTitle')}>
              {loading ? (
                <table className="transactions-table">
                  <thead>
                    <tr>
                      <th>{t('common.date')}</th><th>{t('playerCash.colCategory')}</th><th>{t('playerCash.colType')}</th><th>{t('playerCash.colTournament')}</th><th>{t('playerCash.colSponsor')}</th><th>{t('playerCash.colAmount')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <SkeletonTableRow cols={6} />
                    <SkeletonTableRow cols={6} />
                    <SkeletonTableRow cols={6} />
                  </tbody>
                </table>
              ) : statement.length === 0 ? (
                <EmptyState
                  icon={null}
                  title={t('playerCash.noMovements')}
                  subtitle={t('playerCash.noMovementsHint')}
                />
              ) : (
                <div className="table-container">
                  <table className="transactions-table">
                    <thead>
                      <tr>
                        <th>{t('common.date')}</th>
                        <th>{t('playerCash.colCategory')}</th>
                        <th>{t('playerCash.colType')}</th>
                        <th>{t('playerCash.colTournament')}</th>
                        <th>{t('playerCash.colSponsor')}</th>
                        <th>{t('playerCash.colAmount')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {statement.map((entry) => (
                        <tr key={entry.id}>
                          <td>{new Date(entry.date).toLocaleString('pt-BR')}</td>
                          <td>
                            <span className={`badge ${entry.category === 'credit' ? 'badge-credit' : 'badge-default'}`}>
                              {entry.category === 'credit' ? t('playerCash.categoryCredit') : t('playerCash.categoryTransaction')}
                            </span>
                          </td>
                          <td>{getTypeBadge(entry.type)}</td>
                          <td>{entry.tournament_name || '—'}</td>
                          <td>{entry.sponsor_name || '—'}</td>
                          <td className={`amount ${isIncoming(entry.type) ? 'cj-amount-positive' : 'cj-amount-negative'}`}>
                            {isIncoming(entry.type) ? '+' : '-'} {formatCurrency(entry.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </>
        )}

        {!selectedPlayerId && !loading && (
          <EmptyState
            icon={null}
            title={t('playerCash.selectPlayerEmpty')}
            subtitle={t('playerCash.selectPlayerEmptyHint')}
          />
        )}

        {/* Grant Credit Modal */}
        {showCreditModal && (
          <div className="modal-overlay" onClick={() => setShowCreditModal(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>{t('playerCash.grantCreditTitle')}</h2>
                <button className="close-btn" onClick={() => setShowCreditModal(false)} aria-label={t('common.close')}>
                  <span className="close-icon"></span>
                </button>
              </div>
              <form onSubmit={handleGrantCredit}>
                <div className="form-group">
                  <label>{t('playerCash.sponsorLabel')}</label>
                  <div className="cj-sponsor-select-row">
                    <select
                      value={creditForm.sponsor_id}
                      onChange={(e) => setCreditForm(prev => ({ ...prev, sponsor_id: e.target.value }))}
                      required
                    >
                      <option value="">{t('playerCash.selectSponsorOption')}</option>
                      {sponsors.map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="cj-add-sponsor-btn"
                      onClick={() => setShowSponsorModal(true)}
                      title={t('playerCash.newSponsorTitle')}
                    >
                      +
                    </button>
                  </div>
                </div>

                <div className="form-group">
                  <label>{t('playerCash.creditAmountLabel')}</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={creditForm.amount}
                    onChange={(e) => setCreditForm(prev => ({ ...prev, amount: e.target.value }))}
                    required
                    placeholder="0.00"
                  />
                </div>

                <div className="form-group">
                  <label>{t('playerCash.notesLabel')}</label>
                  <textarea
                    value={creditForm.notes}
                    onChange={(e) => setCreditForm(prev => ({ ...prev, notes: e.target.value }))}
                    placeholder={t('playerCash.creditNotesPlaceholder')}
                    rows={3}
                  />
                </div>

                <div className="modal-actions">
                  <Button type="button" variant="secondary" onClick={() => setShowCreditModal(false)}>
                    {t('common.cancel')}
                  </Button>
                  <Button type="submit">{t('playerCash.grantCreditTitle')}</Button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Sponsor Modal */}
        {showSponsorModal && (
          <div className="modal-overlay" onClick={() => setShowSponsorModal(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>{t('playerCash.registerSponsorTitle')}</h2>
                <button className="close-btn" onClick={() => setShowSponsorModal(false)} aria-label={t('common.close')}>
                  <span className="close-icon"></span>
                </button>
              </div>
              <form onSubmit={handleCreateSponsor}>
                <div className="form-group">
                  <label>{t('playerCash.sponsorNameLabel')}</label>
                  <input
                    type="text"
                    value={sponsorForm.name}
                    onChange={(e) => setSponsorForm(prev => ({ ...prev, name: e.target.value }))}
                    required
                    placeholder={t('playerCash.sponsorNamePlaceholder')}
                  />
                </div>
                <div className="form-group">
                  <label>{t('playerCash.contactPersonLabel')}</label>
                  <input
                    type="text"
                    value={sponsorForm.contact_person}
                    onChange={(e) => setSponsorForm(prev => ({ ...prev, contact_person: e.target.value }))}
                    placeholder={t('playerCash.contactPersonPlaceholder')}
                  />
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label>{t('playerCash.emailLabel')}</label>
                    <input
                      type="email"
                      value={sponsorForm.email}
                      onChange={(e) => setSponsorForm(prev => ({ ...prev, email: e.target.value }))}
                      placeholder={t('playerCash.emailPlaceholder')}
                    />
                  </div>
                  <div className="form-group">
                    <label>{t('playerCash.phoneLabel')}</label>
                    <input
                      type="text"
                      value={sponsorForm.phone}
                      onChange={(e) => setSponsorForm(prev => ({ ...prev, phone: e.target.value }))}
                      placeholder={t('playerCash.phonePlaceholder')}
                    />
                  </div>
                </div>
                <div className="modal-actions">
                  <Button type="button" variant="secondary" onClick={() => setShowSponsorModal(false)}>
                    {t('common.cancel')}
                  </Button>
                  <Button type="submit">{t('common.register')}</Button>
                </div>
              </form>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default CaixaJogadores;
