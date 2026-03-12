import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import Button from '../components/Button';
import PlayerSelect from '../components/PlayerSelect';
import SeatTicket from '../components/SeatTicket';
import EmptyState from '../components/EmptyState';
import { SkeletonStatCard, SkeletonTableRow } from '../components/SkeletonLoader';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import './Caixa.css';

// Fix 3: formatação pt-BR consistente com resto do sistema
const fmt = (n) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n ?? 0);

const Caixa = () => {
  const { t } = useTranslation();
  const [transactions, setTransactions] = useState([]);
  const [tournaments, setTournaments] = useState([]);
  const [tournamentDays, setTournamentDays] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [showTicketModal, setShowTicketModal] = useState(false);
  const [allocationData, setAllocationData] = useState(null);
  const { toast } = useToast();
  const [formData, setFormData] = useState({
    tournament_id: '',
    tournament_day_id: '',
    player_id: '',
    type: 'buy_in',
    amount: '',
    payment_method: 'cash',
  });

  useEffect(() => {
    loadData();

    // Setup polling (every 5 seconds)
    const pollingInterval = setInterval(() => {
      loadData();
    }, 5000);

    return () => {
      clearInterval(pollingInterval);
    };
  }, []);

  const loadData = async () => {
    try {
      // ISSUE-004 fix: use separate calls so one failure doesn't block the other
      const [transactionsRes, tournamentsRes] = await Promise.all([
        api.get('/transactions').catch(() => ({ data: [] })),
        api.get('/tournaments?status=active,pending').catch(() => ({ data: [] })),
      ]);
      setTransactions(transactionsRes.data || []);
      setTournaments(tournamentsRes.data || []);
    } catch (error) {
      console.error('Erro ao carregar dados:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadTournamentDays = async (tournamentId) => {
    if (!tournamentId) {
      setTournamentDays([]);
      return;
    }
    try {
      const response = await api.get(`/tournament-days/tournament/${tournamentId}`);
      // Filter only active/pending days and exclude final days (no buy-ins for finals)
      const activeDays = response.data.filter(day =>
        (day.status === 'active' || day.status === 'pending') && day.day_type !== 'final'
      );
      setTournamentDays(activeDays);
    } catch (error) {
      console.error('Erro ao carregar dias do torneio:', error);
      setTournamentDays([]);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    // Validate that a day is selected if days exist
    if (tournamentDays.length > 0 && !formData.tournament_day_id) {
      toast.warning('Por favor, selecione um dia do torneio');
      return;
    }

    try {
      // If it's a buy_in, register the player in the tournament day
      if (formData.type === 'buy_in') {
        await api.post('/tournament-players', {
          tournament_id: formData.tournament_id,
          tournament_day_id: formData.tournament_day_id || null,
          player_id: formData.player_id,
          buy_in_count: 1,
          notes: `Registrado via Caixa - ${formData.payment_method}`,
        });

        // Check allocation: prefer day-scoped if a day is selected
        const tournament = tournaments.find(t => t.id === formData.tournament_id);
        const selectedDay = tournamentDays.find(d => d.id === formData.tournament_day_id);

        const allocationTypeToUse = selectedDay?.allocation_type || tournament?.allocation_type;
        const tablesLocked = selectedDay?.tables_locked ?? false;

        if (allocationTypeToUse === 'automatic') {
          if (tablesLocked) {
            // Tables are locked — player becomes alternate, show alternate ticket
            setAllocationData({
              player_name: null, // filled below
              tournament_name: tournament?.name || '',
              day_name: selectedDay?.day_name || '',
              is_alternate: true,
              created_at: new Date().toISOString(),
              id: formData.player_id,
            });
            // Fetch player name for ticket
            try {
              const pRes = await api.get(`/players/${formData.player_id}`);
              setAllocationData(prev => ({ ...prev, player_name: pRes.data.name }));
            } catch (_) {
              setAllocationData(prev => ({ ...prev, player_name: '—' }));
            }
            setShowTicketModal(true);
          } else {
            try {
              let allocationResponse;
              if (formData.tournament_day_id) {
                // Day-scoped auto-allocation
                allocationResponse = await api.post(
                  `/allocations/day/${formData.tournament_day_id}/auto?player_id=${formData.player_id}`
                );
              } else {
                // Tournament-scoped fallback
                allocationResponse = await api.post(
                  `/allocations/tournament/${formData.tournament_id}/auto?player_id=${formData.player_id}`
                );
              }
              setAllocationData({
                ...allocationResponse.data,
                day_name: selectedDay?.day_name || allocationResponse.data.day_name || '',
              });
              setShowTicketModal(true);
            } catch (allocationError) {
              console.error('Erro ao alocar jogador:', allocationError);
              const errDetail = allocationError.response?.data?.detail || '';
              const noSeats = errDetail.toLowerCase().includes('tables are full')
                || errDetail.toLowerCase().includes('no active tables');
              if (noSeats) {
                // No seats available — player becomes alternate
                const baseData = {
                  player_name: null,
                  tournament_name: tournament?.name || '',
                  day_name: selectedDay?.day_name || '',
                  is_alternate: true,
                  created_at: new Date().toISOString(),
                  id: formData.player_id,
                };
                setAllocationData(baseData);
                try {
                  const pRes = await api.get(`/players/${formData.player_id}`);
                  setAllocationData(prev => ({ ...prev, player_name: pRes.data.name }));
                } catch (_) {
                  setAllocationData(prev => ({ ...prev, player_name: '—' }));
                }
                setShowTicketModal(true);
              } else {
                const errorMsg = errDetail || 'Erro desconhecido';
                toast.warning(`Jogador registrado, mas não foi possível alocar automaticamente. Motivo: ${errorMsg}. Aloque manualmente.`);
              }
            }
          }
        }
      } else if (formData.type === 'rebuy') {
        // Find tournament player and add rebuy
        const playersRes = await api.get(`/tournament-players/tournament/${formData.tournament_id}`);
        const tournamentPlayer = playersRes.data.find(p => p.player_id === formData.player_id);
        if (tournamentPlayer) {
          // If player was eliminated, remove from ranking first
          if (tournamentPlayer.status === 'eliminated') {
            try {
              await api.delete(`/rankings/tournament-player/${tournamentPlayer.id}/ranking`);
              console.log('Player removed from ranking after rebuy');
            } catch (rankingError) {
              console.error('Error removing from ranking:', rankingError);
              // Continue with rebuy even if ranking removal fails
            }
          }

          // Process the rebuy
          await api.post(`/tournament-players/${tournamentPlayer.id}/rebuy`);

          // Try to auto-allocate after rebuy
          const tournament = tournaments.find(t => t.id === formData.tournament_id);
          const selectedDay = tournamentDays.find(d => d.id === formData.tournament_day_id);
          const allocationTypeToUse = selectedDay?.allocation_type || tournament?.allocation_type;
          const tablesLocked = selectedDay?.tables_locked ?? false;

          if (allocationTypeToUse === 'automatic') {
            if (tablesLocked) {
              setAllocationData({
                player_name: null,
                tournament_name: tournament?.name || '',
                day_name: selectedDay?.day_name || '',
                is_alternate: true,
                created_at: new Date().toISOString(),
                id: formData.player_id,
              });
              try {
                const pRes = await api.get(`/players/${formData.player_id}`);
                setAllocationData(prev => ({ ...prev, player_name: pRes.data.name }));
              } catch (_) {
                setAllocationData(prev => ({ ...prev, player_name: '—' }));
              }
              setShowTicketModal(true);
            } else {
              try {
                let allocationResponse;
                if (formData.tournament_day_id) {
                  allocationResponse = await api.post(
                    `/allocations/day/${formData.tournament_day_id}/auto?player_id=${formData.player_id}`
                  );
                } else {
                  allocationResponse = await api.post(
                    `/allocations/tournament/${formData.tournament_id}/auto?player_id=${formData.player_id}`
                  );
                }
                setAllocationData({
                  ...allocationResponse.data,
                  day_name: selectedDay?.day_name || allocationResponse.data.day_name || '',
                });
                setShowTicketModal(true);
              } catch (allocationError) {
                console.error('Erro ao alocar jogador após rebuy:', allocationError);
                const errDetail = allocationError.response?.data?.detail || '';
                const noSeats = errDetail.toLowerCase().includes('tables are full')
                  || errDetail.toLowerCase().includes('no active tables');
                if (noSeats) {
                  const baseData = {
                    player_name: null,
                    tournament_name: tournament?.name || '',
                    day_name: selectedDay?.day_name || '',
                    is_alternate: true,
                    created_at: new Date().toISOString(),
                    id: formData.player_id,
                  };
                  setAllocationData(baseData);
                  try {
                    const pRes = await api.get(`/players/${formData.player_id}`);
                    setAllocationData(prev => ({ ...prev, player_name: pRes.data.name }));
                  } catch (_) {
                    setAllocationData(prev => ({ ...prev, player_name: '—' }));
                  }
                  setShowTicketModal(true);
                } else {
                  const errorMsg = errDetail || 'Erro desconhecido';
                  toast.warning(`Rebuy registrado! Mas não foi possível alocar automaticamente. Motivo: ${errorMsg}. Aloque manualmente.`);
                }
              }
            }
          }
        } else {
          toast.error('Jogador nao esta registrado neste torneio');
          return;
        }
      } else if (formData.type === 'addon') {
        // Find tournament player and add addon
        const playersRes = await api.get(`/tournament-players/tournament/${formData.tournament_id}`);
        const tournamentPlayer = playersRes.data.find(p => p.player_id === formData.player_id);
        if (tournamentPlayer) {
          await api.post(`/tournament-players/${tournamentPlayer.id}/addon`);
        } else {
          toast.error('Jogador nao esta registrado neste torneio');
          return;
        }
      }

      setShowModal(false);
      setFormData({
        tournament_id: '',
        tournament_day_id: '',
        player_id: '',
        type: 'buy_in',
        amount: '',
        payment_method: 'cash',
      });
      setTournamentDays([]);
      loadData();
    } catch (error) {
      // ISSUE-004 fix: use userMessage from global interceptor for readable error
      const errorMessage =
        error.userMessage ||
        error.response?.data?.detail ||
        'Erro ao registrar transação';
      toast.error(typeof errorMessage === 'string' ? errorMessage : 'Erro ao registrar transação');
    }
  };

  const handleChange = async (e) => {
    const { name, value } = e.target;

    let newFormData = {
      ...formData,
      [name]: value,
    };

    // When tournament changes, load days and reset day selection
    if (name === 'tournament_id') {
      newFormData.tournament_day_id = '';
      loadTournamentDays(value);
    }

    // Auto-fill amount based on tournament day or tournament and transaction type
    if (name === 'tournament_id' || name === 'tournament_day_id' || name === 'type') {
      const tournamentId = name === 'tournament_id' ? value : formData.tournament_id;
      const dayId = name === 'tournament_day_id' ? value : newFormData.tournament_day_id;
      const transactionType = name === 'type' ? value : formData.type;

      // Try to get values from day first, then fallback to tournament
      let amount = 0;
      const selectedDay = tournamentDays.find(d => d.id === dayId);
      const tournament = tournaments.find(t => t.id === tournamentId);

      if (selectedDay) {
        // Use day-specific values
        switch (transactionType) {
          case 'buy_in':
            amount = selectedDay.buy_in;
            break;
          case 'rebuy':
            amount = selectedDay.rebuy_amount || selectedDay.buy_in;
            break;
          case 'addon':
            amount = selectedDay.addon_amount || selectedDay.buy_in;
            break;
          default:
            amount = selectedDay.buy_in;
        }
      } else if (tournament) {
        // Fallback to tournament values
        switch (transactionType) {
          case 'buy_in':
            amount = tournament.buy_in;
            break;
          case 'rebuy':
            amount = tournament.rebuy || tournament.buy_in;
            break;
          case 'addon':
            amount = tournament.addon || tournament.buy_in;
            break;
          default:
            amount = tournament.buy_in;
        }
      }

      newFormData.amount = amount;
    }

    setFormData(newFormData);
  };

  const getTransactionTypeBadge = (type) => {
    const types = {
      buy_in: { label: 'Buy-in', className: 'badge-success' },
      rebuy: { label: 'Rebuy', className: 'badge-warning' },
      addon: { label: 'Add-on', className: 'badge-info' },
    };
    const badge = types[type] || types.buy_in;
    return <span className={`badge ${badge.className}`}>{badge.label}</span>;
  };

  const getTotalByType = () => {
    const totals = {
      buy_in: 0,
      rebuy: 0,
      addon: 0,
      total: 0,
    };

    transactions.forEach(t => {
      totals[t.type] += parseFloat(t.amount);
      totals.total += parseFloat(t.amount);
    });

    return totals;
  };

  const totals = getTotalByType();

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        {/* ── Page header (A9) ── */}
        <div className="cx-header">
          <div className="cx-header-left">
            <div className="cx-header-icon">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z"/>
              </svg>
            </div>
            <div>
              <h1 className="cx-title">{t('cashRegister.title')}</h1>
              <p className="cx-subtitle">{t('cashRegister.subtitle')}</p>
            </div>
          </div>
          <Button onClick={() => setShowModal(true)}>
            {t('cashRegister.newTransaction')}
          </Button>
        </div>

        {/* B1: Skeleton nos KPI cards enquanto carrega */}
        <div className="stats-grid">
          {loading ? (
            <>
              <SkeletonStatCard />
              <SkeletonStatCard />
              <SkeletonStatCard />
              <SkeletonStatCard />
            </>
          ) : (
            <>
              <Card className="stat-card">
                <div className="cx-stat-icon">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z"/></svg>
                </div>
                <div className="stat-info">
                  <h3>{fmt(totals.buy_in)}</h3>
                  <p>{t('cashRegister.totalBuyIns')}</p>
                </div>
              </Card>
              <Card className="stat-card">
                <div className="cx-stat-icon">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
                </div>
                <div className="stat-info">
                  <h3>{fmt(totals.rebuy)}</h3>
                  <p>{t('cashRegister.totalRebuys')}</p>
                </div>
              </Card>
              <Card className="stat-card">
                <div className="cx-stat-icon">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 3c1.93 0 3.5 1.57 3.5 3.5S13.93 13 12 13s-3.5-1.57-3.5-3.5S10.07 6 12 6zm7 13H5v-.23c0-.62.28-1.2.76-1.58C7.47 15.82 9.64 15 12 15s4.53.82 6.24 2.19c.48.38.76.97.76 1.58V19z"/></svg>
                </div>
                <div className="stat-info">
                  <h3>{fmt(totals.addon)}</h3>
                  <p>{t('cashRegister.totalAddons')}</p>
                </div>
              </Card>
              <Card className="stat-card">
                <div className="cx-stat-icon cx-stat-icon--total">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z"/></svg>
                </div>
                <div className="stat-info">
                  <h3 className="cx-stat-total">{fmt(totals.total)}</h3>
                  <p>{t('cashRegister.totalGeneral')}</p>
                </div>
              </Card>
            </>
          )}
        </div>

        <Card title={t('cashRegister.recentTransactions')}>
          {loading ? (
            /* B1: Skeleton table rows */
            <table className="transactions-table">
              <thead>
                <tr>
                  <th>{t('common.date','Data')}</th><th>{t('cashRegister.player','Jogador')}</th><th>{t('cashRegister.tournament','Torneio')}</th><th>{t('cashRegister.type','Tipo')}</th><th>{t('cashRegister.amount','Valor')}</th>
                </tr>
              </thead>
              <tbody>
                <SkeletonTableRow cols={5} />
                <SkeletonTableRow cols={5} />
                <SkeletonTableRow cols={5} />
                <SkeletonTableRow cols={5} />
              </tbody>
            </table>
          ) : transactions.length === 0 ? (
            /* A2: EmptyState unificado */
            <EmptyState
              icon="💰"
              title={t('cashRegister.noTransactions')}
              subtitle={t('cashRegister.noTransactionsHint')}
            />
          ) : (
            <div className="table-container">
              <table className="transactions-table">
                <thead>
                  <tr>
                    <th>{t('common.date','Data')}</th>
                    <th>{t('cashRegister.player','Jogador')}</th>
                    <th>{t('cashRegister.tournament','Torneio')}</th>
                    <th>{t('cashRegister.type','Tipo')}</th>
                    <th>{t('cashRegister.amount','Valor')}</th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((transaction) => (
                    <tr key={transaction.id}>
                      <td>{new Date(transaction.created_at).toLocaleString('pt-BR')}</td>
                      <td>
                        {transaction.player_name}
                        {transaction.player_nickname && (
                          <span className="player-nickname"> ({transaction.player_nickname})</span>
                        )}
                      </td>
                      <td>{transaction.tournament_name}</td>
                      <td>{getTransactionTypeBadge(transaction.type)}</td>
                      <td className="amount">{fmt(transaction.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {showModal && (
          <div className="modal-overlay" onClick={() => setShowModal(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>{t('cashRegister.newTransaction')}</h2>
                <button className="close-btn" onClick={() => setShowModal(false)} aria-label="Fechar">
                  <span className="close-icon"></span>
                </button>
              </div>
              <form onSubmit={handleSubmit}>
                <div className="form-group">
                  <label htmlFor="tournament_id">{t('cashRegister.tournament')}</label>
                  <select
                    id="tournament_id"
                    name="tournament_id"
                    value={formData.tournament_id}
                    onChange={handleChange}
                    required
                  >
                    <option value="">{t('cashRegister.selectTournament')}</option>
                    {tournaments.map((tournament) => (
                      <option key={tournament.id} value={tournament.id}>
                        {tournament.name}
                      </option>
                    ))}
                  </select>
                </div>

                {tournamentDays.length > 0 && (
                  <div className="form-group">
                    <label htmlFor="tournament_day_id">{t('cashRegister.day')}</label>
                    <select
                      id="tournament_day_id"
                      name="tournament_day_id"
                      value={formData.tournament_day_id}
                      onChange={handleChange}
                      required
                    >
                      <option value="">{t('cashRegister.selectDay')}</option>
                      {tournamentDays.map((day) => (
                        <option key={day.id} value={day.id}>
                          {day.day_name} - {fmt(day.buy_in)} ({day.registered_players}/{day.max_players} jogadores)
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="form-group">
                  <label htmlFor="player_id">{t('cashRegister.player')}</label>
                  <PlayerSelect
                    value={formData.player_id}
                    onChange={handleChange}
                    required
                    name="player_id"
                  />
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label htmlFor="type">{t('cashRegister.type')}</label>
                    <select
                      id="type"
                      name="type"
                      value={formData.type}
                      onChange={handleChange}
                      required
                    >
                      <option value="buy_in">{t('cashRegister.buyIn')}</option>
                      <option value="rebuy">{t('cashRegister.rebuy')}</option>
                      <option value="addon">{t('cashRegister.addon')}</option>
                    </select>
                  </div>

                  <div className="form-group">
                    <label htmlFor="amount">{t('cashRegister.amount')}</label>
                    <input
                      id="amount"
                      name="amount"
                      type="number"
                      step="0.01"
                      value={formData.amount}
                      onChange={handleChange}
                      required
                      placeholder="0.00"
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label htmlFor="payment_method">{t('cashRegister.paymentMethod')}</label>
                  <select
                    id="payment_method"
                    name="payment_method"
                    value={formData.payment_method}
                    onChange={handleChange}
                  >
                    <option value="cash">{t('cashRegister.cash')}</option>
                    <option value="pix">{t('cashRegister.pix')}</option>
                    <option value="card">{t('cashRegister.card')}</option>
                    <option value="transfer">{t('cashRegister.transfer')}</option>
                  </select>
                </div>

                <div className="modal-actions">
                  <Button type="button" variant="secondary" onClick={() => setShowModal(false)}>
                    {t('common.cancel')}
                  </Button>
                  <Button type="submit">{t('cashRegister.register')}</Button>
                </div>
              </form>
            </div>
          </div>
        )}

        {showTicketModal && allocationData && (
          <div className="modal-overlay" onClick={() => { setShowTicketModal(false); loadData(); }}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>
                  {allocationData.is_alternate
                    ? 'Jogador Registrado como Alternate!'
                    : 'Jogador Registrado e Alocado!'}
                </h2>
                <button className="close-btn" onClick={() => { setShowTicketModal(false); loadData(); }} aria-label="Fechar">
                  <span className="close-icon"></span>
                </button>
              </div>
              <div className="modal-body">
                <SeatTicket
                  allocation={{
                    id: allocationData.id,
                    player_name: allocationData.player_name,
                    tournament_name: allocationData.tournament_name,
                    day_name: allocationData.day_name,
                    table_number: allocationData.table_number,
                    seat_number: allocationData.seat_number,
                    created_at: allocationData.created_at,
                    is_alternate: allocationData.is_alternate,
                  }}
                  onPrint={() => {
                    setShowTicketModal(false);
                    loadData();
                  }}
                />
              </div>
              <div className="modal-actions">
                <Button onClick={() => { setShowTicketModal(false); loadData(); }}>
                  Fechar
                </Button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default Caixa;
