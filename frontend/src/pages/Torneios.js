import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import Button from '../components/Button';
import api from '../config/api';
import './Torneios.css';

const Torneios = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const stageId = searchParams.get('stage');
  const [tournaments, setTournaments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingTournament, setEditingTournament] = useState(null);
  const [stageName, setStageName] = useState('');
  const [formData, setFormData] = useState({
    name: '',
    buy_in: '',
    rebuy_amount: '',
    addon_amount: '',
    max_players: '',
    blind_duration: 15,
    starting_chips: 10000,
    rebuy_chips: 10000,
    addon_chips: 10000,
    rebuy_level_limit: '',
    allocation_type: 'automatic',
    rake_percentage: 0,
  });
  const [tables, setTables] = useState([]);
  const [newTableSeats, setNewTableSeats] = useState(9);
  const [tableCount, setTableCount] = useState(1);

  useEffect(() => {
    loadTournaments();
    if (stageId) {
      loadStageName();
    } else {
      setStageName('');
    }

    // Setup polling (every 5 seconds)
    const pollingInterval = setInterval(() => {
      loadTournaments();
    }, 5000);

    return () => {
      clearInterval(pollingInterval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageId]);

  const loadTournaments = async () => {
    try {
      const url = stageId ? `/tournaments?stage_id=${stageId}` : '/tournaments';
      const response = await api.get(url);
      setTournaments(response.data);
    } catch (error) {
      console.error('Erro ao carregar torneios:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadStageName = async () => {
    try {
      const response = await api.get(`/stages/${stageId}`);
      setStageName(response.data.name);
    } catch (error) {
      console.error('Erro ao carregar nome da etapa:', error);
      setStageName('Etapa Desconhecida');
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      // Calculate max_players from tables
      const totalSeats = tables.reduce((sum, table) => sum + table.seats, 0);

      // Ensure max_players is a valid positive integer
      const maxPlayers = totalSeats > 0 ? totalSeats : parseInt(formData.max_players) || 10;

      console.log('Creating tournament with stageId:', stageId);

      const tournamentData = {
        ...formData,
        max_players: maxPlayers,
        // Include stage_id if filtering by stage
        stage_id: stageId || null,
        // Ensure numeric fields are numbers, not strings
        buy_in: parseFloat(formData.buy_in),
        rebuy_amount: formData.rebuy_amount ? parseFloat(formData.rebuy_amount) : null,
        addon_amount: formData.addon_amount ? parseFloat(formData.addon_amount) : null,
        blind_duration: parseInt(formData.blind_duration),
        starting_chips: parseInt(formData.starting_chips),
        rebuy_chips: parseInt(formData.rebuy_chips),
        addon_chips: parseInt(formData.addon_chips),
        rebuy_level_limit: formData.rebuy_level_limit ? parseInt(formData.rebuy_level_limit) : null,
        rake_percentage: parseFloat(formData.rake_percentage)
      };

      const response = await api.post('/tournaments', tournamentData);
      const tournamentId = response.data.id;

      // Create tables for the tournament
      if (tables.length > 0) {
        for (const table of tables) {
          await api.post(`/tables/tournament/${tournamentId}`, {
            table_number: table.number,
            seats: table.seats
          });
        }
      }

      setShowModal(false);
      setFormData({
        name: '',
        buy_in: '',
        rebuy_amount: '',
        addon_amount: '',
        max_players: '',
        blind_duration: 15,
        starting_chips: 10000,
        rebuy_chips: 10000,
        addon_chips: 10000,
        rebuy_level_limit: '',
        allocation_type: 'automatic',
        rake_percentage: 0,
      });
      setTables([]);
      loadTournaments();
    } catch (error) {
      console.error('Erro ao criar torneio:', error);
      const errorMessage = error.response?.data?.detail
        ? (Array.isArray(error.response.data.detail)
            ? error.response.data.detail.map(e => `${e.loc?.join('.')}: ${e.msg}`).join('\n')
            : error.response.data.detail)
        : 'Erro ao criar torneio. Verifique os dados e tente novamente.';
      alert(errorMessage);
    }
  };

  const handleChange = (e) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value,
    });
  };

  const addTable = () => {
    const startNumber = tables.length + 1;
    const newTables = [];

    for (let i = 0; i < tableCount; i++) {
      newTables.push({
        number: startNumber + i,
        seats: newTableSeats
      });
    }

    setTables([...tables, ...newTables]);
    setTableCount(1); // Reset counter after adding
  };

  const removeTable = (tableNumber) => {
    const updatedTables = tables
      .filter(t => t.number !== tableNumber)
      .map((t, index) => ({ ...t, number: index + 1 }));
    setTables(updatedTables);
  };

  const updateTableSeats = (tableNumber, newSeats) => {
    setTables(tables.map(t =>
      t.number === tableNumber ? { ...t, seats: parseInt(newSeats) } : t
    ));
  };

  const handleStartTournament = async (tournamentId) => {
    if (window.confirm('Tem certeza que deseja iniciar este torneio?')) {
      try {
        await api.patch(`/tournaments/${tournamentId}`, {
          status: 'active'
        });
        loadTournaments();
      } catch (error) {
        console.error('Erro ao iniciar torneio:', error);
        alert('Erro ao iniciar torneio. Verifique se há jogadores registrados.');
      }
    }
  };

  const handleEndTournament = async (tournamentId) => {
    if (window.confirm('Tem certeza que deseja finalizar este torneio?')) {
      try {
        await api.patch(`/tournaments/${tournamentId}`, {
          status: 'completed'
        });
        loadTournaments();
      } catch (error) {
        console.error('Erro ao finalizar torneio:', error);
        alert('Erro ao finalizar torneio.');
      }
    }
  };

  const handleDeleteTournament = async (tournamentId) => {
    if (window.confirm('Tem certeza que deseja excluir este torneio? Esta ação não pode ser desfeita e removerá todos os dados relacionados (jogadores, transações, etc).')) {
      try {
        await api.delete(`/tournaments/${tournamentId}`);
        loadTournaments();
        alert('Torneio excluído com sucesso!');
      } catch (error) {
        console.error('Erro ao excluir torneio:', error);
        alert('Erro ao excluir torneio. Verifique se o torneio pode ser removido.');
      }
    }
  };

  const handleOpenEditModal = (tournament) => {
    setEditingTournament(tournament);
    setFormData({
      name: tournament.name || '',
      rebuy_level_limit: tournament.rebuy_level_limit || '',
      rebuy_amount: tournament.rebuy_amount || '',
      addon_amount: tournament.addon_amount || '',
      max_players: tournament.max_players || '',
      rake_percentage: tournament.rake_percentage || 0,
    });
    setShowEditModal(true);
  };

  const handleUpdateTournament = async (e) => {
    e.preventDefault();
    try {
      const updateData = {
        name: formData.name,
        rebuy_level_limit: formData.rebuy_level_limit ? parseInt(formData.rebuy_level_limit) : null,
        rebuy_amount: formData.rebuy_amount ? parseFloat(formData.rebuy_amount) : null,
        addon_amount: formData.addon_amount ? parseFloat(formData.addon_amount) : null,
        max_players: formData.max_players ? parseInt(formData.max_players) : null,
        rake_percentage: parseFloat(formData.rake_percentage),
      };

      await api.patch(`/tournaments/${editingTournament.id}`, updateData);
      setShowEditModal(false);
      setEditingTournament(null);
      loadTournaments();
      alert('Torneio atualizado com sucesso!');
    } catch (error) {
      console.error('Erro ao atualizar torneio:', error);
      const errorMessage = error.response?.data?.detail || 'Erro ao atualizar torneio';
      alert(errorMessage);
    }
  };

  const getStatusBadge = (status) => {
    const badges = {
      pending: { label: 'Pendente', className: 'badge-warning' },
      active: { label: 'Em Andamento', className: 'badge-success' },
      completed: { label: 'Concluído', className: 'badge-info' },
      cancelled: { label: 'Cancelado', className: 'badge-danger' },
    };
    const badge = badges[status] || badges.pending;
    return <span className={`badge ${badge.className}`}>{badge.label}</span>;
  };

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div>
            <h1>Torneios</h1>
            <p className="subtitle">
              {stageId && stageName ? (
                <>
                  Filtrando por: <strong>{stageName}</strong>
                  {' '}
                  <Button
                    variant="secondary"
                    onClick={() => navigate('/torneios')}
                    style={{ marginLeft: '10px', padding: '5px 10px', fontSize: '0.85rem' }}
                  >
                    Ver Todos
                  </Button>
                </>
              ) : (
                'Gerenciar torneios de poker'
              )}
            </p>
          </div>
          <Button onClick={() => setShowModal(true)}>
            Novo Torneio
          </Button>
        </div>

        {loading ? (
          <div className="loading">Carregando torneios...</div>
        ) : tournaments.length === 0 ? (
          <Card>
            <div className="empty-state">
              <p>Nenhum torneio encontrado</p>
              <Button onClick={() => setShowModal(true)}>Criar Primeiro Torneio</Button>
            </div>
          </Card>
        ) : (
          <div className="tournaments-grid">
            {tournaments.map((tournament) => (
              <Card key={tournament.id} className="tournament-card">
                <div className="tournament-header">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <h3>{tournament.name}</h3>
                    <button
                      onClick={() => handleOpenEditModal(tournament)}
                      style={{
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        fontSize: '1.2rem',
                        padding: '5px',
                        color: '#666',
                        transition: 'color 0.2s'
                      }}
                      onMouseOver={(e) => e.target.style.color = '#007bff'}
                      onMouseOut={(e) => e.target.style.color = '#666'}
                      title="Editar configurações do torneio"
                    >
                      ⚙️
                    </button>
                  </div>
                  {getStatusBadge(tournament.status)}
                </div>
                <div className="tournament-details">
                  <div className="detail-row">
                    <span className="detail-label">Buy-in:</span>
                    <span className="detail-value">R$ {tournament.buy_in}</span>
                  </div>
                  <div className="detail-row">
                    <span className="detail-label">Jogadores:</span>
                    <span className="detail-value">
                      {tournament.registered_players || 0} / {tournament.max_players}
                    </span>
                  </div>
                  <div className="detail-row">
                    <span className="detail-label">Fichas Iniciais:</span>
                    <span className="detail-value">{tournament.starting_chips}</span>
                  </div>
                  <div className="detail-row">
                    <span className="detail-label">Duração dos Níveis:</span>
                    <span className="detail-value">{tournament.blind_duration} min</span>
                  </div>
                </div>
                <div className="tournament-actions">
                  {(tournament.status === 'active' || tournament.status === 'pending') && (
                    <>
                      <Button
                        variant="info"
                        className="action-btn-small"
                        onClick={() => navigate(`/blinds/${tournament.id}`)}
                      >
                        Estrutura de Blinds
                      </Button>
                      <Button
                        variant="warning"
                        className="action-btn-small"
                        onClick={() => navigate(`/alocacao/${tournament.id}`)}
                      >
                        Alocar Jogadores
                      </Button>
                    </>
                  )}
                  {tournament.status === 'active' && (
                    <>
                      <Button
                        variant="info"
                        className="action-btn-small"
                        onClick={() => navigate(`/ranking/${tournament.id}`)}
                      >
                        Ver Ranking
                      </Button>
                      <Button
                        variant="info"
                        className="action-btn-small"
                        onClick={() => navigate(`/broadcast/${tournament.id}`)}
                      >
                        Transmitir
                      </Button>
                      <Button
                        variant="secondary"
                        className="action-btn-small"
                        onClick={() => navigate(`/eliminacao?tournament=${tournament.id}`)}
                      >
                        Eliminar Jogadores
                      </Button>
                    </>
                  )}
                  {tournament.status === 'pending' && (
                    <Button
                      variant="primary"
                      className="action-btn-small"
                      onClick={() => handleStartTournament(tournament.id)}
                    >
                      Iniciar
                    </Button>
                  )}
                  {tournament.status === 'active' && (
                    <Button
                      variant="warning"
                      className="action-btn-small"
                      onClick={() => handleEndTournament(tournament.id)}
                    >
                      Finalizar
                    </Button>
                  )}
                  {(tournament.status === 'pending' || tournament.status === 'completed' || tournament.status === 'cancelled') && (
                    <Button
                      variant="danger"
                      className="action-btn-small"
                      onClick={() => handleDeleteTournament(tournament.id)}
                    >
                      Excluir
                    </Button>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}

        {showModal && (
          <div className="modal-overlay" onClick={() => setShowModal(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>Novo Torneio</h2>
                <button className="close-btn" onClick={() => setShowModal(false)}>
                  ✕
                </button>
              </div>
              <form onSubmit={handleSubmit}>
                <div className="form-group">
                  <label htmlFor="name">Nome do Torneio</label>
                  <input
                    id="name"
                    name="name"
                    type="text"
                    value={formData.name}
                    onChange={handleChange}
                    required
                    placeholder="Ex: Torneio Sexta-feira"
                  />
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label htmlFor="buy_in">Buy-in (R$) *</label>
                    <input
                      id="buy_in"
                      name="buy_in"
                      type="number"
                      step="0.01"
                      value={formData.buy_in}
                      onChange={handleChange}
                      required
                      placeholder="100.00"
                    />
                  </div>

                  <div className="form-group">
                    <label htmlFor="rebuy_amount">Rebuy (R$)</label>
                    <input
                      id="rebuy_amount"
                      name="rebuy_amount"
                      type="number"
                      step="0.01"
                      value={formData.rebuy_amount}
                      onChange={handleChange}
                      placeholder="100.00"
                    />
                  </div>

                  <div className="form-group">
                    <label htmlFor="addon_amount">Add-on (R$)</label>
                    <input
                      id="addon_amount"
                      name="addon_amount"
                      type="number"
                      step="0.01"
                      value={formData.addon_amount}
                      onChange={handleChange}
                      placeholder="50.00"
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label htmlFor="rebuy_level_limit">Limite de Nível para Rebuy</label>
                  <input
                    id="rebuy_level_limit"
                    name="rebuy_level_limit"
                    type="number"
                    min="1"
                    value={formData.rebuy_level_limit}
                    onChange={handleChange}
                    placeholder="Ex: 6 (Rebuys até nível 6) - Deixe em branco para ilimitado"
                  />
                  <small>Deixe em branco para permitir rebuys ilimitados</small>
                </div>

                <div className="form-group">
                  <label htmlFor="rake_percentage">Taxa da Casa - Rake (%) *</label>
                  <input
                    id="rake_percentage"
                    name="rake_percentage"
                    type="number"
                    step="0.01"
                    min="0"
                    max="100"
                    value={formData.rake_percentage}
                    onChange={handleChange}
                    required
                    placeholder="0"
                  />
                  <small>Percentual de buy-ins/rebuys/addons que fica com a casa. O restante vai para o prize pool. (0% = todo valor vai para prêmios)</small>
                </div>

                <div className="form-group">
                  <label htmlFor="allocation_type">Tipo de Alocação *</label>
                  <select
                    id="allocation_type"
                    name="allocation_type"
                    value={formData.allocation_type}
                    onChange={handleChange}
                    required
                  >
                    <option value="automatic">Automática (Sistema aloca jogadores)</option>
                    <option value="manual">Manual (Administrador aloca jogadores)</option>
                  </select>
                  <small>
                    {formData.allocation_type === 'automatic'
                      ? 'Jogadores serão automaticamente alocados em mesas ao se registrarem'
                      : 'Administradores poderão alocar jogadores manualmente via drag-and-drop'}
                  </small>
                </div>

                <div className="form-section-title">
                  <h3>Gerenciamento de Mesas</h3>
                </div>

                <div className="tables-management">
                  <div className="add-table-section">
                    <div className="form-group-inline">
                      <label htmlFor="newTableSeats">Lugares por Mesa:</label>
                      <input
                        id="newTableSeats"
                        type="number"
                        min="2"
                        max="10"
                        value={newTableSeats}
                        onChange={(e) => setNewTableSeats(parseInt(e.target.value))}
                        className="seats-input"
                      />
                      <label htmlFor="tableCount">Quantidade:</label>
                      <input
                        id="tableCount"
                        type="number"
                        min="1"
                        max="50"
                        value={tableCount}
                        onChange={(e) => setTableCount(parseInt(e.target.value))}
                        className="seats-input"
                      />
                      <Button type="button" onClick={addTable} variant="secondary">
                        Adicionar {tableCount > 1 ? `${tableCount} Mesas` : 'Mesa'}
                      </Button>
                    </div>
                  </div>

                  {tables.length > 0 && (
                    <div className="tables-list">
                      <div className="tables-summary">
                        Total: {tables.length} mesa{tables.length !== 1 ? 's' : ''} - {tables.reduce((sum, t) => sum + t.seats, 0)} lugares
                      </div>
                      {tables.map((table) => (
                        <div key={table.number} className="table-item">
                          <span className="table-number">Mesa {table.number}</span>
                          <div className="table-seats-control">
                            <label>Lugares:</label>
                            <input
                              type="number"
                              min="2"
                              max="10"
                              value={table.seats}
                              onChange={(e) => updateTableSeats(table.number, e.target.value)}
                              className="seats-input-small"
                            />
                          </div>
                          <button
                            type="button"
                            className="remove-table-btn"
                            onClick={() => removeTable(table.number)}
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {tables.length === 0 && (
                    <div className="no-tables-message">
                      Nenhuma mesa adicionada. Clique em "Adicionar Mesa" para começar.
                    </div>
                  )}
                </div>

                <div className="form-group">
                  <label htmlFor="blind_duration">Duração Níveis (min) *</label>
                  <input
                    id="blind_duration"
                    name="blind_duration"
                    type="number"
                    value={formData.blind_duration}
                    onChange={handleChange}
                    required
                  />
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label htmlFor="starting_chips">Fichas Iniciais *</label>
                    <input
                      id="starting_chips"
                      name="starting_chips"
                      type="number"
                      value={formData.starting_chips}
                      onChange={handleChange}
                      required
                    />
                  </div>

                  <div className="form-group">
                    <label htmlFor="rebuy_chips">Fichas Rebuy</label>
                    <input
                      id="rebuy_chips"
                      name="rebuy_chips"
                      type="number"
                      value={formData.rebuy_chips}
                      onChange={handleChange}
                    />
                  </div>

                  <div className="form-group">
                    <label htmlFor="addon_chips">Fichas Add-on</label>
                    <input
                      id="addon_chips"
                      name="addon_chips"
                      type="number"
                      value={formData.addon_chips}
                      onChange={handleChange}
                    />
                  </div>
                </div>

                <div className="modal-actions">
                  <Button type="button" variant="secondary" onClick={() => setShowModal(false)}>
                    Cancelar
                  </Button>
                  <Button type="submit">Criar Torneio</Button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Edit Tournament Modal */}
        {showEditModal && (
          <div className="modal-overlay" onClick={() => setShowEditModal(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>⚙️ Editar Torneio</h2>
                <button className="close-btn" onClick={() => setShowEditModal(false)}>
                  ✕
                </button>
              </div>
              <form onSubmit={handleUpdateTournament}>
                <div className="form-group">
                  <label htmlFor="edit_name">Nome do Torneio *</label>
                  <input
                    id="edit_name"
                    name="name"
                    type="text"
                    value={formData.name}
                    onChange={handleChange}
                    required
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="edit_rebuy_level_limit">Limite de Nível para Rebuy</label>
                  <input
                    id="edit_rebuy_level_limit"
                    name="rebuy_level_limit"
                    type="number"
                    min="1"
                    value={formData.rebuy_level_limit}
                    onChange={handleChange}
                    placeholder="Ex: 6 (Rebuys até nível 6) - Deixe em branco para ilimitado"
                  />
                  <small>Deixe em branco para permitir rebuys ilimitados</small>
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label htmlFor="edit_rebuy_amount">Valor Rebuy (R$)</label>
                    <input
                      id="edit_rebuy_amount"
                      name="rebuy_amount"
                      type="number"
                      step="0.01"
                      value={formData.rebuy_amount}
                      onChange={handleChange}
                      placeholder="50.00"
                    />
                  </div>

                  <div className="form-group">
                    <label htmlFor="edit_addon_amount">Valor Add-on (R$)</label>
                    <input
                      id="edit_addon_amount"
                      name="addon_amount"
                      type="number"
                      step="0.01"
                      value={formData.addon_amount}
                      onChange={handleChange}
                      placeholder="50.00"
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label htmlFor="edit_max_players">Máximo de Jogadores</label>
                  <input
                    id="edit_max_players"
                    name="max_players"
                    type="number"
                    min="2"
                    value={formData.max_players}
                    onChange={handleChange}
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="edit_rake_percentage">Taxa da Casa - Rake (%)</label>
                  <input
                    id="edit_rake_percentage"
                    name="rake_percentage"
                    type="number"
                    step="0.01"
                    min="0"
                    max="100"
                    value={formData.rake_percentage}
                    onChange={handleChange}
                  />
                  <small>Percentual de buy-ins/rebuys/addons que fica com a casa</small>
                </div>

                <div className="modal-actions">
                  <Button type="button" variant="secondary" onClick={() => setShowEditModal(false)}>
                    Cancelar
                  </Button>
                  <Button type="submit">Salvar Alterações</Button>
                </div>
              </form>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default Torneios;
