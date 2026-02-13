import React, { useEffect, useState } from 'react';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import Button from '../components/Button';
import PlayerSelect from '../components/PlayerSelect';
import SeatTicket from '../components/SeatTicket';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import './Caixa.css';

const Caixa = () => {
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
      const [transactionsRes, tournamentsRes] = await Promise.all([
        api.get('/transactions'),
        api.get('/tournaments?status=active,pending'),
      ]);
      setTransactions(transactionsRes.data);
      setTournaments(tournamentsRes.data);
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

        // Check if tournament has automatic allocation
        const tournament = tournaments.find(t => t.id === formData.tournament_id);
        if (tournament && tournament.allocation_type === 'automatic') {
          try {
            // Auto-allocate player to a seat
            const allocationResponse = await api.post(
              `/allocations/tournament/${formData.tournament_id}/auto?player_id=${formData.player_id}`
            );

            // Show ticket modal with allocation data
            setAllocationData(allocationResponse.data);
            setShowTicketModal(true);
          } catch (allocationError) {
            console.error('Erro ao alocar jogador:', allocationError);
            const errorMsg = allocationError.response?.data?.detail || 'Erro desconhecido';
            toast.warning(`Jogador registrado, mas nao foi possivel alocar automaticamente. Motivo: ${errorMsg}. Aloque manualmente na tela de Alocacao.`);
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

          // Try to auto-allocate if tournament uses automatic allocation
          const tournament = tournaments.find(t => t.id === formData.tournament_id);
          if (tournament && tournament.allocation_type === 'automatic') {
            try {
              const allocationResponse = await api.post(
                `/allocations/tournament/${formData.tournament_id}/auto?player_id=${formData.player_id}`
              );
              setAllocationData(allocationResponse.data);
              setShowTicketModal(true);
            } catch (allocationError) {
              console.error('Erro ao alocar jogador após rebuy:', allocationError);
              const errorMsg = allocationError.response?.data?.detail || 'Erro desconhecido';
              toast.warning(`Rebuy registrado! Mas nao foi possivel alocar automaticamente. Motivo: ${errorMsg}. Aloque manualmente na tela de Alocacao.`);
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
      console.error('Erro ao registrar transação:', error);
      const errorMessage = error.response?.data?.detail || 'Erro ao registrar transacao';
      toast.error(typeof errorMessage === 'string' ? errorMessage : 'Erro ao registrar transacao');
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
        <div className="page-header">
          <Button onClick={() => setShowModal(true)}>
            Nova Transação
          </Button>
        </div>

        <div className="stats-grid">
          <Card className="stat-card">
            <div className="stat-icon"></div>
            <div className="stat-info">
              <h3>R$ {totals.buy_in.toFixed(2)}</h3>
              <p>Total Buy-ins</p>
            </div>
          </Card>

          <Card className="stat-card">
            <div className="stat-icon"></div>
            <div className="stat-info">
              <h3>R$ {totals.rebuy.toFixed(2)}</h3>
              <p>Total Rebuys</p>
            </div>
          </Card>

          <Card className="stat-card">
            <div className="stat-icon"></div>
            <div className="stat-info">
              <h3>R$ {totals.addon.toFixed(2)}</h3>
              <p>Total Add-ons</p>
            </div>
          </Card>

          <Card className="stat-card">
            <div className="stat-icon"></div>
            <div className="stat-info">
              <h3>R$ {totals.total.toFixed(2)}</h3>
              <p>Total Geral</p>
            </div>
          </Card>
        </div>

        <Card title="Transações Recentes">
          {loading ? (
            <div className="loading">Carregando transações...</div>
          ) : transactions.length === 0 ? (
            <div className="empty-state">
              <p>Nenhuma transação registrada</p>
            </div>
          ) : (
            <div className="table-container">
              <table className="transactions-table">
                <thead>
                  <tr>
                    <th>Data</th>
                    <th>Jogador</th>
                    <th>Torneio</th>
                    <th>Tipo</th>
                    <th>Valor</th>
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
                      <td className="amount">R$ {parseFloat(transaction.amount).toFixed(2)}</td>
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
                <h2>Nova Transação</h2>
                <button className="close-btn" onClick={() => setShowModal(false)} aria-label="Fechar">
                  <span className="close-icon"></span>
                </button>
              </div>
              <form onSubmit={handleSubmit}>
                <div className="form-group">
                  <label htmlFor="tournament_id">Torneio</label>
                  <select
                    id="tournament_id"
                    name="tournament_id"
                    value={formData.tournament_id}
                    onChange={handleChange}
                    required
                  >
                    <option value="">Selecione um torneio</option>
                    {tournaments.map((tournament) => (
                      <option key={tournament.id} value={tournament.id}>
                        {tournament.name}
                      </option>
                    ))}
                  </select>
                </div>

                {tournamentDays.length > 0 && (
                  <div className="form-group">
                    <label htmlFor="tournament_day_id">Dia do Torneio</label>
                    <select
                      id="tournament_day_id"
                      name="tournament_day_id"
                      value={formData.tournament_day_id}
                      onChange={handleChange}
                      required
                    >
                      <option value="">Selecione um dia</option>
                      {tournamentDays.map((day) => (
                        <option key={day.id} value={day.id}>
                          {day.day_name} - R$ {parseFloat(day.buy_in).toFixed(2)} ({day.registered_players}/{day.max_players} jogadores)
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="form-group">
                  <label htmlFor="player_id">Jogador</label>
                  <PlayerSelect
                    value={formData.player_id}
                    onChange={handleChange}
                    required
                    name="player_id"
                  />
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label htmlFor="type">Tipo</label>
                    <select
                      id="type"
                      name="type"
                      value={formData.type}
                      onChange={handleChange}
                      required
                    >
                      <option value="buy_in">Buy-in</option>
                      <option value="rebuy">Rebuy</option>
                      <option value="addon">Add-on</option>
                    </select>
                  </div>

                  <div className="form-group">
                    <label htmlFor="amount">Valor (R$)</label>
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
                  <label htmlFor="payment_method">Forma de Pagamento</label>
                  <select
                    id="payment_method"
                    name="payment_method"
                    value={formData.payment_method}
                    onChange={handleChange}
                  >
                    <option value="cash">Dinheiro</option>
                    <option value="pix">PIX</option>
                    <option value="card">Cartão</option>
                    <option value="transfer">Transferência</option>
                  </select>
                </div>

                <div className="modal-actions">
                  <Button type="button" variant="secondary" onClick={() => setShowModal(false)}>
                    Cancelar
                  </Button>
                  <Button type="submit">Registrar</Button>
                </div>
              </form>
            </div>
          </div>
        )}

        {showTicketModal && allocationData && (
          <div className="modal-overlay" onClick={() => setShowTicketModal(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>Jogador Registrado e Alocado!</h2>
                <button className="close-btn" onClick={() => setShowTicketModal(false)} aria-label="Fechar">
                  <span className="close-icon"></span>
                </button>
              </div>
              <div className="modal-body">
                <SeatTicket
                  allocation={{
                    id: allocationData.id,
                    player_name: allocationData.player_name,
                    tournament_name: allocationData.tournament_name,
                    table_number: allocationData.table_number,
                    seat_number: allocationData.seat_number,
                    created_at: allocationData.created_at
                  }}
                  onPrint={() => {
                    setShowTicketModal(false);
                    loadData();
                  }}
                />
              </div>
              <div className="modal-actions">
                <Button onClick={() => {
                  setShowTicketModal(false);
                  loadData();
                }}>
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
