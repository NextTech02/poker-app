import React, { useEffect, useState } from 'react';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import Button from '../components/Button';
import PlayerSelect from '../components/PlayerSelect';
import PlayerMultiSelect from '../components/PlayerMultiSelect';
import EmptyState from '../components/EmptyState';
import { SkeletonStatCard, SkeletonTableRow } from '../components/SkeletonLoader';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { usePermissions } from '../contexts/PermissionContext';
import { usePaymentMethods } from '../contexts/PaymentMethodsContext';
import { useTranslation } from 'react-i18next';
import './SatelliteTickets.css';

const SatelliteTickets = () => {
  const { toast } = useToast();
  const { formatCurrency } = useCurrency();
  const { isAdmin, hasPermission } = usePermissions();
  const { activeMethods } = usePaymentMethods();
  const { t } = useTranslation();

  // Emitir em lote é decisão de dono: um erro multiplica por dezenas de
  // entradas já pagas. O backend também exige a permissão — aqui é só para
  // não oferecer um botão que vai dar 403.
  const podeLote = isAdmin || hasPermission('cashier_tickets.master');

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
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkPlayerIds, setBulkPlayerIds] = useState([]);
  const [creating, setCreating] = useState(false);

  // Transferência / venda de ticket
  const [transferTicket, setTransferTicket] = useState(null);
  const [transferForm, setTransferForm] = useState({
    to_player_id: '', amount: '', payment_method: '', register_in_cash: true, notes: '',
  });
  const [transferHistory, setTransferHistory] = useState([]);
  const [transferring, setTransferring] = useState(false);

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
  const fecharCriacao = () => {
    setShowCreateModal(false);
    setCreateForm({ player_id: '', target_tournament_id: '', target_tournament_day_id: '', won_at: '', funded_by: '' });
    setBulkPlayerIds([]);
    setBulkMode(false);
    setCreateDays([]);
  };

  const handleCreateTicket = async (e) => {
    e.preventDefault();
    setCreating(true);
    try {
      if (bulkMode) {
        const { player_id, ...destino } = createForm;
        const res = await api.post('/satellite-tickets/bulk', { ...destino, player_ids: bulkPlayerIds });
        const criados = res.data?.created?.length || 0;
        const ignorados = res.data?.skipped || [];
        if (criados === 0) {
          // Modal continua aberto: o operador precisa corrigir a seleção.
          toast.error(t('satelliteTickets.bulkNoneCreated', 'Nenhum ticket foi emitido. Confira os jogadores selecionados.'));
          return;
        }
        toast.success(t('satelliteTickets.bulkCreated', '{{count}} ticket(s) emitido(s).', { count: criados }));
        if (ignorados.length > 0) {
          toast.warning(t('satelliteTickets.bulkPartial', '{{count}} jogador(es) ficaram de fora do lote.', { count: ignorados.length }));
        }
      } else {
        await api.post('/satellite-tickets', createForm);
        toast.success(t('satelliteTickets.toastCreated'));
      }
      fecharCriacao();
      loadData();
    } catch (err) {
      toast.error(err.response?.data?.detail || t('satelliteTickets.toastCreateError'));
    } finally {
      setCreating(false);
    }
  };

  const selectedCreateDay = createDays.find(d => d.id === createForm.target_tournament_day_id);

  // Valor total do lote = nº de jogadores × buy-in do dia. É o dinheiro que vai
  // entrar no pool do torneio-destino bancado pelo financiador.
  const bulkTotal = (selectedCreateDay?.buy_in || 0) * bulkPlayerIds.length;

  // ── Transferir / Vender ──
  const openTransferModal = async (ticket) => {
    setTransferTicket(ticket);
    setTransferForm({ to_player_id: '', amount: '', payment_method: '', register_in_cash: true, notes: '' });
    setTransferHistory([]);
    try {
      const res = await api.get(`/satellite-tickets/${ticket.id}/transfers`);
      setTransferHistory(res.data || []);
    } catch (err) {
      setTransferHistory([]);
    }
  };

  const handleTransferTicket = async (e) => {
    e.preventDefault();
    if (!transferTicket) return;
    const valor = Number(transferForm.amount) || 0;
    setTransferring(true);
    try {
      await api.post(`/satellite-tickets/${transferTicket.id}/transfer`, {
        to_player_id: transferForm.to_player_id,
        amount: valor,
        payment_method: transferForm.payment_method || null,
        register_in_cash: valor > 0 ? transferForm.register_in_cash : false,
        notes: transferForm.notes.trim() || null,
      });
      toast.success(valor > 0
        ? t('satelliteTickets.toastSold', 'Ticket vendido e lançado no caixa.')
        : t('satelliteTickets.toastTransferred', 'Ticket transferido.'));
      setTransferTicket(null);
      loadData();
    } catch (err) {
      toast.error(err.response?.data?.detail || t('satelliteTickets.toastTransferError', 'Não foi possível transferir o ticket.'));
    } finally {
      setTransferring(false);
    }
  };

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
                          <>
                            <button className="st-action-btn" onClick={() => openTransferModal(ticket)}>
                              {t('satelliteTickets.transferAction', 'Transferir/Vender')}
                            </button>
                            <button className="st-action-btn st-action-btn--danger" onClick={() => handleCancelTicket(ticket.id)}>
                              {t('satelliteTickets.cancelAction')}
                            </button>
                          </>
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
          <div className="modal-overlay" onClick={fecharCriacao}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>{t('satelliteTickets.createModalTitle')}</h2>
                <button className="close-btn" onClick={fecharCriacao} aria-label={t('common.close')}><span className="close-icon"></span></button>
              </div>
              <form onSubmit={handleCreateTicket}>
                {podeLote && (
                  <div className="st-bulk-toggle" role="group" aria-label={t('satelliteTickets.bulkToggle', 'Quantidade de jogadores')}>
                    <button
                      type="button"
                      className={`st-bulk-tab ${!bulkMode ? 'is-active' : ''}`}
                      onClick={() => setBulkMode(false)}
                    >
                      {t('satelliteTickets.bulkModeSingle', 'Um jogador')}
                    </button>
                    <button
                      type="button"
                      className={`st-bulk-tab ${bulkMode ? 'is-active' : ''}`}
                      onClick={() => setBulkMode(true)}
                    >
                      {t('satelliteTickets.bulkModeMultiple', 'Vários jogadores')}
                    </button>
                  </div>
                )}
                <div className="form-group">
                  <label>{t('satelliteTickets.playerLabel')}</label>
                  {bulkMode ? (
                    <PlayerMultiSelect
                      values={bulkPlayerIds}
                      onChange={setBulkPlayerIds}
                      disabled={creating}
                    />
                  ) : (
                    <PlayerSelect
                      value={createForm.player_id}
                      onChange={(e) => setCreateForm(p => ({ ...p, player_id: e.target.value }))}
                      required
                      name="create_player_id"
                    />
                  )}
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
                {bulkMode && (
                  <div className="st-info-box st-info-box--detail">
                    <div>
                      <span>{t('satelliteTickets.bulkSelected', 'Jogadores selecionados')}</span>
                      <strong>{bulkPlayerIds.length}</strong>
                    </div>
                    <div>
                      <span>{t('satelliteTickets.bulkTotal', 'Valor total do lote')}</span>
                      <strong>{fmt(bulkTotal)}</strong>
                    </div>
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
                  <Button type="button" variant="secondary" onClick={fecharCriacao}>{t('satelliteTickets.cancelAction')}</Button>
                  <Button
                    type="submit"
                    disabled={
                      creating ||
                      (bulkMode ? bulkPlayerIds.length === 0 : !createForm.player_id) ||
                      !createForm.target_tournament_id ||
                      !createForm.target_tournament_day_id ||
                      !createForm.won_at.trim() ||
                      !createForm.funded_by.trim()
                    }
                  >
                    {bulkMode
                      ? t('satelliteTickets.bulkSubmit', 'Emitir lote')
                      : t('satelliteTickets.submitCreate')}
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

        {/* Transferir / Vender Ticket */}
        {transferTicket && (
          <div className="modal-overlay" onClick={() => !transferring && setTransferTicket(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>{t('satelliteTickets.transferModalTitle', 'Transferir ou vender ticket')}</h2>
                <button className="close-btn" onClick={() => setTransferTicket(null)} aria-label={t('common.close')}><span className="close-icon"></span></button>
              </div>
              <form onSubmit={handleTransferTicket}>
                <div className="st-info-box st-info-box--detail">
                  <div><span>{t('satelliteTickets.detailPlayer')}</span><strong>{transferTicket.player_name || '--'}</strong></div>
                  <div><span>{t('satelliteTickets.detailTournament')}</span><strong>{transferTicket.target_tournament_name}</strong></div>
                  <div><span>{t('satelliteTickets.detailValue')}</span><strong>{fmt(transferTicket.ticket_value)}</strong></div>
                  <div><span>{t('satelliteTickets.detailFundedBy')}</span><strong>{transferTicket.funded_by || '--'}</strong></div>
                </div>
                {/* Quem banca o buy-in no torneio-destino NÃO muda com a venda:
                    é outro dinheiro, e o resgate depende do financiador para o
                    clube saber de quem cobrar a entrada. */}
                <small className="form-hint">
                  {t('satelliteTickets.transferFundedByHint', 'Quem banca o buy-in continua sendo o mesmo — a venda é o dinheiro pela vaga.')}
                </small>

                <div className="form-group">
                  <label>{t('satelliteTickets.transferTo', 'Novo dono')}</label>
                  <PlayerSelect
                    value={transferForm.to_player_id}
                    onChange={(e) => setTransferForm(p => ({ ...p, to_player_id: e.target.value }))}
                    required
                    name="transfer_to_player_id"
                  />
                </div>

                <div className="form-group">
                  <label>{t('satelliteTickets.saleAmountLabel', 'Valor da venda')}</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={transferForm.amount}
                    onChange={(e) => setTransferForm(p => ({ ...p, amount: e.target.value }))}
                    placeholder="0"
                  />
                  <small className="form-hint">{t('satelliteTickets.saleAmountHint', 'Deixe em 0 para transferência sem cobrança.')}</small>
                </div>

                {Number(transferForm.amount) > 0 && (
                  <>
                    <div className="form-group">
                      <label>{t('satelliteTickets.paymentMethodLabel', 'Forma de pagamento')}</label>
                      <select
                        value={transferForm.payment_method}
                        onChange={(e) => setTransferForm(p => ({ ...p, payment_method: e.target.value }))}
                      >
                        <option value="">{t('satelliteTickets.selectPaymentMethod', 'Selecione...')}</option>
                        {(activeMethods || []).map(m => (
                          <option key={m.id || m.code} value={m.code}>{m.label}</option>
                        ))}
                      </select>
                    </div>
                    <div className="form-group">
                      <label className="st-check-label">
                        <input
                          type="checkbox"
                          checked={transferForm.register_in_cash}
                          onChange={(e) => setTransferForm(p => ({ ...p, register_in_cash: e.target.checked }))}
                        />
                        {t('satelliteTickets.registerInCash', 'Lançar no caixa geral')}
                      </label>
                    </div>
                  </>
                )}

                <div className="form-group">
                  <label>{t('satelliteTickets.transferNotesLabel', 'Observação')}</label>
                  <input
                    type="text"
                    value={transferForm.notes}
                    onChange={(e) => setTransferForm(p => ({ ...p, notes: e.target.value }))}
                    maxLength={300}
                  />
                </div>

                <div className="st-transfer-history">
                  <h3>{t('satelliteTickets.historyTitle', 'Histórico do ticket')}</h3>
                  {transferHistory.length === 0 ? (
                    <p className="st-no-tickets-msg">{t('satelliteTickets.historyEmpty', 'Este ticket nunca mudou de dono.')}</p>
                  ) : (
                    <ul className="st-history-list">
                      {transferHistory.map(h => (
                        <li key={h.id}>
                          {h.from_player_name || '--'} → {h.to_player_name || '--'}
                          {h.kind === 'sale' ? ` — ${fmt(h.amount)}` : ''}
                          {' '}({new Date(h.created_at).toLocaleDateString('pt-BR')})
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="modal-actions">
                  <Button type="button" variant="secondary" onClick={() => setTransferTicket(null)}>{t('satelliteTickets.cancelAction')}</Button>
                  <Button type="submit" disabled={transferring || !transferForm.to_player_id}>
                    {t('satelliteTickets.transferSubmit', 'Confirmar')}
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
