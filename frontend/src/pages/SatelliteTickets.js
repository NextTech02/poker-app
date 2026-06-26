import React, { useEffect, useState } from 'react';
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
import './SatelliteTickets.css';

const SatelliteTickets = () => {
  const { toast } = useToast();
  const { formatCurrency } = useCurrency();
  const { t } = useTranslation();

  const fmt = (n) => formatCurrency(n ?? 0);

  const [tickets, setTickets] = useState([]);
  const [tournaments, setTournaments] = useState([]);
  const [createDays, setCreateDays] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);

  // Filters
  const [filters, setFilters] = useState({ status: '', target_tournament_id: '' });

  // Modals
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showRedeemModal, setShowRedeemModal] = useState(false);

  // Create form — player + target tournament + target day + audit info
  const [createForm, setCreateForm] = useState({
    player_id: '',
    target_tournament_id: '',
    target_tournament_day_id: '',
    won_at: '',
    funded_by: '',
  });

  // Redeem form — pick a ticket, then enter funding source
  const [availableTickets, setAvailableTickets] = useState([]);
  const [redeemForm, setRedeemForm] = useState({ ticket_id: '', funded_by: '' });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [ticketsRes, tournamentsRes, summaryRes] = await Promise.all([
        api.get('/satellite-tickets').catch(() => ({ data: [] })),
        api.get('/tournaments').catch(() => ({ data: [] })),
        api.get('/satellite-tickets/summary').catch(() => ({ data: {} })),
      ]);
      setTickets(ticketsRes.data || []);
      setTournaments(tournamentsRes.data || []);
      setSummary(summaryRes.data);
    } catch (err) {
      console.error('Error loading data:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadFilteredTickets = async () => {
    try {
      const params = new URLSearchParams();
      if (filters.status) params.set('status', filters.status);
      if (filters.target_tournament_id) params.set('target_tournament_id', filters.target_tournament_id);
      const res = await api.get(`/satellite-tickets?${params.toString()}`);
      setTickets(res.data || []);
    } catch (err) {
      console.error('Error filtering tickets:', err);
    }
  };

  const loadCreateDays = async (tournamentId) => {
    if (!tournamentId) { setCreateDays([]); return; }
    try {
      const res = await api.get(`/tournament-days/tournament/${tournamentId}`);
      setCreateDays(res.data || []);
    } catch (err) {
      setCreateDays([]);
    }
  };

  // ── Create Ticket ──
  const handleCreateTicket = async (e) => {
    e.preventDefault();
    try {
      await api.post('/satellite-tickets', createForm);
      toast.success(t('satelliteTickets.toastCreated'));
      setShowCreateModal(false);
      setCreateForm({ player_id: '', target_tournament_id: '', target_tournament_day_id: '', won_at: '', funded_by: '' });
      setCreateDays([]);
      loadData();
    } catch (err) {
      toast.error(err.response?.data?.detail || t('satelliteTickets.toastCreateError'));
    }
  };

  const selectedCreateDay = createDays.find(d => d.id === createForm.target_tournament_day_id);

  // ── Redeem Ticket ──
  const openRedeemModal = async () => {
    setShowRedeemModal(true);
    setRedeemForm({ ticket_id: '', funded_by: '' });
    try {
      const res = await api.get('/satellite-tickets/available');
      setAvailableTickets(res.data || []);
    } catch (err) {
      setAvailableTickets([]);
    }
  };

  const selectedRedeemTicket = availableTickets.find(t => t.id === redeemForm.ticket_id);

  const handleRedeemTicket = async (e) => {
    e.preventDefault();
    try {
      const payload = {};
      // Only send funded_by when the user actually filled it in (legacy tickets);
      // for new tickets the funder is already attached and the backend reuses it.
      if (redeemForm.funded_by.trim()) {
        payload.funded_by = redeemForm.funded_by.trim();
      }
      const result = await api.post(`/satellite-tickets/${redeemForm.ticket_id}/redeem`, payload);
      toast.success(result.data.message || t('satelliteTickets.toastRedeemed'));
      setShowRedeemModal(false);
      setRedeemForm({ ticket_id: '', funded_by: '' });
      setAvailableTickets([]);
      loadData();
    } catch (err) {
      toast.error(err.response?.data?.detail || t('satelliteTickets.toastRedeemError'));
    }
  };

  // ── Cancel ──
  const handleCancelTicket = async (ticketId) => {
    if (!window.confirm(t('satelliteTickets.confirmCancel'))) return;
    try {
      await api.post(`/satellite-tickets/${ticketId}/cancel`);
      toast.success(t('satelliteTickets.toastCancelled'));
      loadData();
    } catch (err) {
      toast.error(err.response?.data?.detail || t('satelliteTickets.toastCancelError'));
    }
  };

  const getStatusBadge = (status) => {
    const map = {
      awarded: { label: t('satelliteTickets.badgeAvailable'), cls: 'st-status--available' },
      available: { label: t('satelliteTickets.badgeAvailable'), cls: 'st-status--available' },
      redeemed: { label: t('satelliteTickets.badgeRedeemed'), cls: 'st-status--redeemed' },
      cancelled: { label: t('satelliteTickets.badgeCancelled'), cls: 'st-status--cancelled' },
    };
    const s = map[status] || { label: status, cls: '' };
    return <span className={`st-status-badge ${s.cls}`}>{s.label}</span>;
  };

  const isAwarded = (status) => status === 'awarded' || status === 'available';

  const renderPlayer = (ticket) => {
    if (!ticket.player_name) return <span className="st-unassigned">--</span>;
    return (
      <>
        {ticket.player_name}
        {ticket.player_nickname && <span className="player-nickname"> ({ticket.player_nickname})</span>}
      </>
    );
  };

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        {/* Header */}
        <div className="cx-header">
          <div className="cx-header-left">
            <div className="cx-header-icon">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z" />
              </svg>
            </div>
            <div>
              <h1 className="cx-title">{t('satelliteTickets.title')}</h1>
              <p className="cx-subtitle">{t('satelliteTickets.subtitle')}</p>
            </div>
          </div>
          <div className="st-header-actions">
            <Button variant="secondary" onClick={() => setShowCreateModal(true)}>{t('satelliteTickets.registerTicket')}</Button>
            <Button onClick={openRedeemModal}>{t('satelliteTickets.redeemTicket')}</Button>
          </div>
        </div>

        {/* Summary */}
        <div className="stats-grid">
          {loading ? (
            <><SkeletonStatCard /><SkeletonStatCard /><SkeletonStatCard /></>
          ) : summary ? (
            <>
              <Card className="stat-card">
                <div className="stat-info">
                  <h3 className="st-stat-available">{summary.total_available}</h3>
                  <p>{t('satelliteTickets.statsAvailable')}</p>
                </div>
              </Card>
              <Card className="stat-card">
                <div className="stat-info">
                  <h3 className="st-stat-redeemed">{summary.total_redeemed}</h3>
                  <p>{t('satelliteTickets.statsRedeemed')}</p>
                </div>
              </Card>
              <Card className="stat-card">
                <div className="stat-info">
                  <h3>{summary.total_cancelled}</h3>
                  <p>{t('satelliteTickets.statsCancelled')}</p>
                </div>
              </Card>
            </>
          ) : null}
        </div>

        {/* Filters */}
        <Card className="st-filters-card">
          <div className="st-filters">
            <div className="form-group">
              <label>{t('common.status')}</label>
              <select value={filters.status} onChange={(e) => setFilters(p => ({ ...p, status: e.target.value }))}>
                <option value="">{t('satelliteTickets.allFilter')}</option>
                <option value="awarded">{t('satelliteTickets.statusAvailable')}</option>
                <option value="redeemed">{t('satelliteTickets.statusRedeemed')}</option>
                <option value="cancelled">{t('satelliteTickets.statusCancelled')}</option>
              </select>
            </div>
            <div className="form-group">
              <label>{t('satelliteTickets.targetTournament')}</label>
              <select value={filters.target_tournament_id} onChange={(e) => setFilters(p => ({ ...p, target_tournament_id: e.target.value }))}>
                <option value="">{t('satelliteTickets.allFilter')}</option>
                {tournaments.map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
            <div className="st-filter-actions">
              <Button variant="secondary" onClick={() => setFilters({ status: '', target_tournament_id: '' })}>{t('satelliteTickets.clear')}</Button>
              <Button onClick={loadFilteredTickets}>{t('common.filter')}</Button>
            </div>
          </div>
        </Card>

        {/* Tickets Table */}
        <Card title={t('satelliteTickets.ticketsCardTitle')}>
          {loading ? (
            <table className="transactions-table">
              <thead><tr><th>{t('satelliteTickets.colPlayer')}</th><th>{t('satelliteTickets.colTargetTournament')}</th><th>{t('satelliteTickets.colDay')}</th><th>{t('satelliteTickets.colValue')}</th><th>{t('satelliteTickets.colStatus')}</th><th>{t('satelliteTickets.colOrigin')}</th><th>{t('satelliteTickets.colFundedBy')}</th><th>{t('satelliteTickets.colDate')}</th><th>{t('satelliteTickets.colActions')}</th></tr></thead>
              <tbody><SkeletonTableRow cols={9} /><SkeletonTableRow cols={9} /><SkeletonTableRow cols={9} /></tbody>
            </table>
          ) : tickets.length === 0 ? (
            <EmptyState icon={null} title={t('satelliteTickets.emptyTitle')} subtitle={t('satelliteTickets.emptySubtitle')} />
          ) : (
            <div className="table-container">
              <table className="transactions-table">
                <thead>
                  <tr>
                    <th>{t('satelliteTickets.colPlayer')}</th>
                    <th>{t('satelliteTickets.colTargetTournament')}</th>
                    <th>{t('satelliteTickets.colDay')}</th>
                    <th>{t('satelliteTickets.colValue')}</th>
                    <th>{t('satelliteTickets.colStatus')}</th>
                    <th>{t('satelliteTickets.colOrigin')}</th>
                    <th>{t('satelliteTickets.colFundedBy')}</th>
                    <th>{t('satelliteTickets.colDate')}</th>
                    <th>{t('satelliteTickets.colActions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {tickets.map((ticket) => (
                    <tr key={ticket.id}>
                      <td>{renderPlayer(ticket)}</td>
                      <td>{ticket.target_tournament_name}</td>
                      <td>{ticket.target_day_name || <span className="st-unassigned">--</span>}</td>
                      <td>{fmt(ticket.ticket_value)}</td>
                      <td>{getStatusBadge(ticket.status)}</td>
                      <td>
                        {ticket.won_at || <span className="st-unassigned">--</span>}
                      </td>
                      <td>
                        {ticket.funded_by || <span className="st-unassigned">--</span>}
                      </td>
                      <td>{new Date(ticket.created_at).toLocaleDateString('pt-BR')}</td>
                      <td>
                        {isAwarded(ticket.status) && (
                          <button className="st-action-btn st-action-btn--danger" onClick={() => handleCancelTicket(ticket.id)}>
                            {t('satelliteTickets.cancelAction')}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* Create Ticket Modal */}
        {showCreateModal && (
          <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>{t('satelliteTickets.createModalTitle')}</h2>
                <button className="close-btn" onClick={() => setShowCreateModal(false)} aria-label={t('common.close')}><span className="close-icon"></span></button>
              </div>
              <form onSubmit={handleCreateTicket}>
                <div className="form-group">
                  <label>{t('satelliteTickets.playerLabel')}</label>
                  <PlayerSelect
                    value={createForm.player_id}
                    onChange={(e) => setCreateForm(p => ({ ...p, player_id: e.target.value }))}
                    required
                    name="create_player_id"
                  />
                </div>
                <div className="form-group">
                  <label>{t('satelliteTickets.targetTournamentLabel')}</label>
                  <select
                    value={createForm.target_tournament_id}
                    onChange={(e) => {
                      setCreateForm(p => ({ ...p, target_tournament_id: e.target.value, target_tournament_day_id: '' }));
                      loadCreateDays(e.target.value);
                    }}
                    required
                  >
                    <option value="">{t('satelliteTickets.selectTargetTournament')}</option>
                    {tournaments.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label>{t('satelliteTickets.targetDayLabel')}</label>
                  <select
                    value={createForm.target_tournament_day_id}
                    onChange={(e) => setCreateForm(p => ({ ...p, target_tournament_day_id: e.target.value }))}
                    required
                    disabled={!createForm.target_tournament_id || createDays.length === 0}
                  >
                    <option value="">
                      {!createForm.target_tournament_id
                        ? t('satelliteTickets.selectTournamentFirst')
                        : createDays.length === 0
                          ? t('satelliteTickets.noDayAvailable')
                          : t('satelliteTickets.selectDay')}
                    </option>
                    {createDays.map(d => (
                      <option key={d.id} value={d.id}>
                        {d.day_name} - {fmt(d.buy_in)}
                      </option>
                    ))}
                  </select>
                </div>
                {selectedCreateDay && (
                  <div className="st-info-box">
                    <span>{t('satelliteTickets.ticketValueLabel')}</span>
                    <strong>{fmt(selectedCreateDay.buy_in)}</strong>
                  </div>
                )}
                <div className="form-group">
                  <label>{t('satelliteTickets.wonAtLabel')}</label>
                  <input
                    type="text"
                    value={createForm.won_at}
                    onChange={(e) => setCreateForm(p => ({ ...p, won_at: e.target.value }))}
                    required
                    placeholder={t('satelliteTickets.wonAtPlaceholder')}
                    maxLength={200}
                  />
                  <small className="form-hint">{t('satelliteTickets.wonAtHint')}</small>
                </div>
                <div className="form-group">
                  <label>{t('satelliteTickets.fundedByLabel')}</label>
                  <input
                    type="text"
                    value={createForm.funded_by}
                    onChange={(e) => setCreateForm(p => ({ ...p, funded_by: e.target.value }))}
                    required
                    placeholder={t('satelliteTickets.fundedByPlaceholder')}
                    maxLength={120}
                  />
                  <small className="form-hint">{t('satelliteTickets.fundedByHint')}</small>
                </div>
                <div className="modal-actions">
                  <Button type="button" variant="secondary" onClick={() => setShowCreateModal(false)}>{t('satelliteTickets.cancelAction')}</Button>
                  <Button
                    type="submit"
                    disabled={
                      !createForm.player_id ||
                      !createForm.target_tournament_id ||
                      !createForm.target_tournament_day_id ||
                      !createForm.won_at.trim() ||
                      !createForm.funded_by.trim()
                    }
                  >
                    {t('satelliteTickets.submitCreate')}
                  </Button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Redeem Ticket Modal */}
        {showRedeemModal && (
          <div className="modal-overlay" onClick={() => setShowRedeemModal(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>{t('satelliteTickets.redeemModalTitle')}</h2>
                <button className="close-btn" onClick={() => setShowRedeemModal(false)} aria-label={t('common.close')}><span className="close-icon"></span></button>
              </div>
              <form onSubmit={handleRedeemTicket}>
                {availableTickets.length === 0 ? (
                  <p className="st-no-tickets-msg">{t('satelliteTickets.noTicketsToRedeem')}</p>
                ) : (
                  <>
                    <div className="form-group">
                      <label>{t('satelliteTickets.ticketLabel')}</label>
                      <select
                        value={redeemForm.ticket_id}
                        onChange={(e) => setRedeemForm(p => ({ ...p, ticket_id: e.target.value }))}
                        required
                      >
                        <option value="">{t('satelliteTickets.selectTicket')}</option>
                        {availableTickets.map(at => (
                          <option key={at.id} value={at.id}>
                            {at.player_name || t('satelliteTickets.noPlayer')} → {at.target_tournament_name}
                            {at.target_day_name ? ` (${at.target_day_name})` : ''} — {fmt(at.ticket_value)}
                          </option>
                        ))}
                      </select>
                    </div>

                    {selectedRedeemTicket && (
                      <div className="st-info-box st-info-box--detail">
                        <div><span>{t('satelliteTickets.detailPlayer')}</span><strong>{selectedRedeemTicket.player_name || '--'}</strong></div>
                        <div><span>{t('satelliteTickets.detailTournament')}</span><strong>{selectedRedeemTicket.target_tournament_name}</strong></div>
                        <div><span>{t('satelliteTickets.detailDay')}</span><strong>{selectedRedeemTicket.target_day_name || '--'}</strong></div>
                        <div><span>{t('satelliteTickets.detailValue')}</span><strong>{fmt(selectedRedeemTicket.ticket_value)}</strong></div>
                        <div><span>{t('satelliteTickets.detailOrigin')}</span><strong>{selectedRedeemTicket.won_at || '--'}</strong></div>
                        <div><span>{t('satelliteTickets.detailFundedBy')}</span><strong>{selectedRedeemTicket.funded_by || '--'}</strong></div>
                      </div>
                    )}

                    {/* Legacy fallback: only ask for funder when the ticket
                        wasn't created with one (pre-redesign tickets). */}
                    {selectedRedeemTicket && !selectedRedeemTicket.funded_by && (
                      <div className="form-group">
                        <label>{t('satelliteTickets.legacyFundedByLabel')}</label>
                        <input
                          type="text"
                          value={redeemForm.funded_by}
                          onChange={(e) => setRedeemForm(p => ({ ...p, funded_by: e.target.value }))}
                          required
                          placeholder={t('satelliteTickets.legacyFundedByPlaceholder')}
                          maxLength={120}
                        />
                        <small className="form-hint">{t('satelliteTickets.legacyFundedByHint')}</small>
                      </div>
                    )}
                  </>
                )}

                <div className="modal-actions">
                  <Button type="button" variant="secondary" onClick={() => setShowRedeemModal(false)}>{t('satelliteTickets.cancelAction')}</Button>
                  <Button
                    type="submit"
                    disabled={
                      !redeemForm.ticket_id ||
                      // legacy ticket without a stored funder still requires the input
                      (selectedRedeemTicket && !selectedRedeemTicket.funded_by && !redeemForm.funded_by.trim())
                    }
                  >
                    {t('satelliteTickets.submitRedeem')}
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

export default SatelliteTickets;
