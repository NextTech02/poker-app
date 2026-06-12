import React, { useEffect, useState, useCallback } from 'react';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import Button from '../components/Button';
import PlayerSelect from '../components/PlayerSelect';
import EmptyState from '../components/EmptyState';
import { SkeletonStatCard, SkeletonTableRow } from '../components/SkeletonLoader';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import './CaixaJogadores.css';

const fmt = (n) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n ?? 0);

const CaixaJogadores = () => {
  const { toast } = useToast();

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
      toast.error('Erro ao carregar dados do jogador');
    } finally {
      setLoading(false);
    }
  }, [filters, toast]);

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
      toast.warning('Selecione um jogador primeiro');
      return;
    }
    try {
      await api.post('/player-credits', {
        player_id: selectedPlayerId,
        sponsor_id: creditForm.sponsor_id,
        amount: parseFloat(creditForm.amount),
        notes: creditForm.notes || null,
      });
      toast.success('Crédito concedido com sucesso!');
      setShowCreditModal(false);
      setCreditForm({ sponsor_id: '', amount: '', notes: '' });
      loadPlayerData(selectedPlayerId);
    } catch (err) {
      const msg = err.response?.data?.detail || 'Erro ao conceder crédito';
      toast.error(msg);
    }
  };

  // ---- Create Sponsor ----
  const handleCreateSponsor = async (e) => {
    e.preventDefault();
    try {
      await api.post('/sponsors', sponsorForm);
      toast.success('Patrocinador cadastrado!');
      setShowSponsorModal(false);
      setSponsorForm({ name: '', email: '', phone: '', contact_person: '' });
      loadSponsors();
    } catch (err) {
      toast.error('Erro ao cadastrar patrocinador');
    }
  };

  // ---- Cancel Credit ----
  const handleCancelCredit = async (creditId) => {
    if (!window.confirm('Tem certeza que deseja cancelar este crédito?')) return;
    try {
      await api.post(`/player-credits/${creditId}/cancel`);
      toast.success('Crédito cancelado');
      loadPlayerData(selectedPlayerId);
    } catch (err) {
      const msg = err.response?.data?.detail || 'Erro ao cancelar crédito';
      toast.error(msg);
    }
  };

  // ---- Badge helpers ----
  const getTypeBadge = (type) => {
    const map = {
      buy_in: { label: 'Buy-in', cls: 'badge-success' },
      rebuy: { label: 'Rebuy', cls: 'badge-warning' },
      addon: { label: 'Add-on', cls: 'badge-info' },
      prize: { label: 'Prêmio', cls: 'badge-prize' },
      credit_granted: { label: 'Crédito Recebido', cls: 'badge-credit' },
      credit_used_buyin: { label: 'Crédito → Buy-in', cls: 'badge-credit-used' },
      credit_used_rebuy: { label: 'Crédito → Rebuy', cls: 'badge-credit-used' },
      credit_used_addon: { label: 'Crédito → Add-on', cls: 'badge-credit-used' },
      prize_deduction: { label: 'Desc. Premiação', cls: 'badge-deduction' },
      sponsor_payment: { label: 'Pgto Patrocinador', cls: 'badge-sponsor' },
      credit_cancelled: { label: 'Cancelado', cls: 'badge-cancelled' },
      credit_refund: { label: 'Estorno', cls: 'badge-refund' },
    };
    const badge = map[type] || { label: type, cls: 'badge-default' };
    return <span className={`badge ${badge.cls}`}>{badge.label}</span>;
  };

  const getCreditStatusBadge = (status) => {
    const map = {
      active: { label: 'Ativo', cls: 'cj-status--active' },
      fully_used: { label: 'Utilizado', cls: 'cj-status--used' },
      settled_by_prize: { label: 'Quitado (Prêmio)', cls: 'cj-status--settled' },
      settled_by_sponsor: { label: 'Quitado (Patrocinador)', cls: 'cj-status--settled' },
      cancelled: { label: 'Cancelado', cls: 'cj-status--cancelled' },
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
              <h1 className="cx-title">Jogadores</h1>
              <p className="cx-subtitle">Extrato financeiro e créditos dos jogadores</p>
            </div>
          </div>
          <div className="cj-header-actions">
            <Button variant="secondary" onClick={() => setShowSponsorModal(true)}>
              + Patrocinador
            </Button>
            {selectedPlayerId && (
              <Button onClick={() => setShowCreditModal(true)}>
                + Conceder Crédito
              </Button>
            )}
          </div>
        </div>

        {/* Player Selector */}
        <Card className="cj-player-selector">
          <div className="form-group">
            <label>Selecione um jogador</label>
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
                      <h3 className="cj-stat-positive">{fmt(summary.total_credits_received)}</h3>
                      <p>Créditos Recebidos</p>
                    </div>
                  </Card>
                  <Card className="stat-card">
                    <div className="stat-info">
                      <h3 className="cj-stat-highlight">{fmt(summary.total_credits_remaining)}</h3>
                      <p>Crédito Disponível</p>
                    </div>
                  </Card>
                  <Card className="stat-card">
                    <div className="stat-info">
                      <h3>{fmt(summary.total_credits_used)}</h3>
                      <p>Crédito Utilizado</p>
                    </div>
                  </Card>
                  <Card className="stat-card">
                    <div className="stat-info">
                      <h3 className="cj-stat-warning">{fmt(summary.total_sponsor_owes)}</h3>
                      <p>Patrocinador Deve</p>
                    </div>
                  </Card>
                </>
              ) : null}
            </div>

            {/* Active Credits */}
            {credits.length > 0 && (
              <Card title="Créditos" className="cj-credits-card">
                <div className="table-container">
                  <table className="transactions-table">
                    <thead>
                      <tr>
                        <th>Patrocinador</th>
                        <th>Original</th>
                        <th>Disponível</th>
                        <th>Usado</th>
                        <th>Desc. Prêmio</th>
                        <th>Patrocinador Deve</th>
                        <th>Status</th>
                        <th>Ações</th>
                      </tr>
                    </thead>
                    <tbody>
                      {credits.map((c) => (
                        <tr key={c.id}>
                          <td>{c.sponsor_name}</td>
                          <td>{fmt(c.original_amount)}</td>
                          <td className="cj-amount-positive">{fmt(c.remaining_amount)}</td>
                          <td>{fmt(c.used_amount)}</td>
                          <td>{fmt(c.prize_deduction_amount)}</td>
                          <td className={c.sponsor_owes > 0 ? 'cj-amount-warning' : ''}>{fmt(c.sponsor_owes)}</td>
                          <td>{getCreditStatusBadge(c.status)}</td>
                          <td>
                            {c.status === 'active' && c.used_amount === 0 && (
                              <button
                                className="cj-action-btn cj-action-btn--danger"
                                onClick={() => handleCancelCredit(c.id)}
                                title="Cancelar crédito"
                              >
                                Cancelar
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
                  <label>Categoria</label>
                  <select name="category" value={filters.category} onChange={handleFilterChange}>
                    <option value="">Todas</option>
                    <option value="transaction">Transações</option>
                    <option value="credit">Créditos</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Tipo</label>
                  <select name="type" value={filters.type} onChange={handleFilterChange}>
                    <option value="">Todos</option>
                    <option value="buy_in">Buy-in</option>
                    <option value="rebuy">Rebuy</option>
                    <option value="addon">Add-on</option>
                    <option value="prize">Prêmio</option>
                    <option value="credit_granted">Crédito Recebido</option>
                    <option value="credit_used_buyin">Crédito → Buy-in</option>
                    <option value="credit_used_rebuy">Crédito → Rebuy</option>
                    <option value="credit_used_addon">Crédito → Add-on</option>
                    <option value="prize_deduction">Desc. Premiação</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>De</label>
                  <input type="date" name="date_from" value={filters.date_from} onChange={handleFilterChange} />
                </div>
                <div className="form-group">
                  <label>Até</label>
                  <input type="date" name="date_to" value={filters.date_to} onChange={handleFilterChange} />
                </div>
                <div className="cj-filter-actions">
                  <Button variant="secondary" onClick={clearFilters}>Limpar</Button>
                  <Button onClick={applyFilters}>Filtrar</Button>
                </div>
              </div>
            </Card>

            {/* Statement */}
            <Card title="Extrato Financeiro">
              {loading ? (
                <table className="transactions-table">
                  <thead>
                    <tr>
                      <th>Data</th><th>Categoria</th><th>Tipo</th><th>Torneio</th><th>Patrocinador</th><th>Valor</th>
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
                  title="Nenhuma movimentação"
                  subtitle="Este jogador ainda não possui transações ou créditos"
                />
              ) : (
                <div className="table-container">
                  <table className="transactions-table">
                    <thead>
                      <tr>
                        <th>Data</th>
                        <th>Categoria</th>
                        <th>Tipo</th>
                        <th>Torneio</th>
                        <th>Patrocinador</th>
                        <th>Valor</th>
                      </tr>
                    </thead>
                    <tbody>
                      {statement.map((entry) => (
                        <tr key={entry.id}>
                          <td>{new Date(entry.date).toLocaleString('pt-BR')}</td>
                          <td>
                            <span className={`badge ${entry.category === 'credit' ? 'badge-credit' : 'badge-default'}`}>
                              {entry.category === 'credit' ? 'Crédito' : 'Transação'}
                            </span>
                          </td>
                          <td>{getTypeBadge(entry.type)}</td>
                          <td>{entry.tournament_name || '—'}</td>
                          <td>{entry.sponsor_name || '—'}</td>
                          <td className={`amount ${isIncoming(entry.type) ? 'cj-amount-positive' : 'cj-amount-negative'}`}>
                            {isIncoming(entry.type) ? '+' : '-'} {fmt(entry.amount)}
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
            title="Selecione um jogador"
            subtitle="Escolha um jogador acima para ver seu extrato financeiro e créditos"
          />
        )}

        {/* Grant Credit Modal */}
        {showCreditModal && (
          <div className="modal-overlay" onClick={() => setShowCreditModal(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>Conceder Crédito</h2>
                <button className="close-btn" onClick={() => setShowCreditModal(false)} aria-label="Fechar">
                  <span className="close-icon"></span>
                </button>
              </div>
              <form onSubmit={handleGrantCredit}>
                <div className="form-group">
                  <label>Patrocinador</label>
                  <div className="cj-sponsor-select-row">
                    <select
                      value={creditForm.sponsor_id}
                      onChange={(e) => setCreditForm(prev => ({ ...prev, sponsor_id: e.target.value }))}
                      required
                    >
                      <option value="">Selecione um patrocinador</option>
                      {sponsors.map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="cj-add-sponsor-btn"
                      onClick={() => setShowSponsorModal(true)}
                      title="Cadastrar novo patrocinador"
                    >
                      +
                    </button>
                  </div>
                </div>

                <div className="form-group">
                  <label>Valor do Crédito</label>
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
                  <label>Observações</label>
                  <textarea
                    value={creditForm.notes}
                    onChange={(e) => setCreditForm(prev => ({ ...prev, notes: e.target.value }))}
                    placeholder="Observações sobre o crédito..."
                    rows={3}
                  />
                </div>

                <div className="modal-actions">
                  <Button type="button" variant="secondary" onClick={() => setShowCreditModal(false)}>
                    Cancelar
                  </Button>
                  <Button type="submit">Conceder Crédito</Button>
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
                <h2>Cadastrar Patrocinador</h2>
                <button className="close-btn" onClick={() => setShowSponsorModal(false)} aria-label="Fechar">
                  <span className="close-icon"></span>
                </button>
              </div>
              <form onSubmit={handleCreateSponsor}>
                <div className="form-group">
                  <label>Nome *</label>
                  <input
                    type="text"
                    value={sponsorForm.name}
                    onChange={(e) => setSponsorForm(prev => ({ ...prev, name: e.target.value }))}
                    required
                    placeholder="Nome do patrocinador"
                  />
                </div>
                <div className="form-group">
                  <label>Pessoa de Contato</label>
                  <input
                    type="text"
                    value={sponsorForm.contact_person}
                    onChange={(e) => setSponsorForm(prev => ({ ...prev, contact_person: e.target.value }))}
                    placeholder="Nome do contato"
                  />
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label>Email</label>
                    <input
                      type="email"
                      value={sponsorForm.email}
                      onChange={(e) => setSponsorForm(prev => ({ ...prev, email: e.target.value }))}
                      placeholder="email@exemplo.com"
                    />
                  </div>
                  <div className="form-group">
                    <label>Telefone</label>
                    <input
                      type="text"
                      value={sponsorForm.phone}
                      onChange={(e) => setSponsorForm(prev => ({ ...prev, phone: e.target.value }))}
                      placeholder="(00) 00000-0000"
                    />
                  </div>
                </div>
                <div className="modal-actions">
                  <Button type="button" variant="secondary" onClick={() => setShowSponsorModal(false)}>
                    Cancelar
                  </Button>
                  <Button type="submit">Cadastrar</Button>
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
