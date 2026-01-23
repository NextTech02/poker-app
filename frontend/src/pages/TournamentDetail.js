import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import Button from '../components/Button';
import api from '../config/api';
import './TournamentDetail.css';

// Import the Dashboard component (we'll adapt it later)
import TournamentDashboard from './TournamentDashboard';

const TournamentDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [tournament, setTournament] = useState(null);
  const [days, setDays] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [showCreateDayModal, setShowCreateDayModal] = useState(false);
  const [editingDay, setEditingDay] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const [formData, setFormData] = useState({
    day_name: '',
    day_number: 1,
    buy_in: 100,
    rebuy_amount: 100,
    addon_amount: 100,
    max_players: 100,
    rake_percentage: 20,
    starting_chips: 10000,
    rebuy_chips: 10000,
    addon_chips: 10000,
    blind_duration: 15,
    initial_small_blind: 50,
    initial_big_blind: 100,
    blind_increase_type: 'double',
    bb_ante_start_level: 3,
    rebuy_level_limit: '',
    break_interval: 60,
    break_duration: 10,
    allocation_type: 'automatic',
  });

  const loadTournamentData = async () => {
    try {
      const [tournamentRes, daysRes] = await Promise.all([
        api.get(`/tournaments/${id}`),
        api.get(`/tournament-days/tournament/${id}`)
      ]);
      setTournament(tournamentRes.data);
      setDays(daysRes.data);
    } catch (err) {
      console.error('Error loading tournament:', err);
      setError('Erro ao carregar torneio');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTournamentData();
  }, [id]);

  const handleCreateDay = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const dayData = {
        ...formData,
        tournament_id: id,
        rebuy_amount: formData.rebuy_amount > 0 ? formData.rebuy_amount : null,
        addon_amount: formData.addon_amount > 0 ? formData.addon_amount : null,
        rebuy_level_limit: formData.rebuy_level_limit ? parseInt(formData.rebuy_level_limit) : null,
      };

      if (editingDay) {
        await api.patch(`/tournament-days/${editingDay.id}`, dayData);
      } else {
        await api.post('/tournament-days', dayData);
      }

      setShowCreateDayModal(false);
      setEditingDay(null);
      resetForm();
      loadTournamentData();
    } catch (err) {
      console.error('Error creating/updating day:', err);
      const errorMessage = err.response?.data?.detail || 'Erro ao salvar dia do torneio';
      setError(errorMessage);
      alert(errorMessage);
    } finally {
      setSubmitting(false);
    }
  };

  const handleEditDay = (day) => {
    setEditingDay(day);
    setFormData({
      day_name: day.day_name,
      day_number: day.day_number,
      buy_in: day.buy_in,
      rebuy_amount: day.rebuy_amount || 0,
      addon_amount: day.addon_amount || 0,
      max_players: day.max_players,
      rake_percentage: day.rake_percentage,
      starting_chips: day.starting_chips,
      rebuy_chips: day.rebuy_chips,
      addon_chips: day.addon_chips,
      blind_duration: day.blind_duration,
      initial_small_blind: day.initial_small_blind,
      initial_big_blind: day.initial_big_blind,
      blind_increase_type: day.blind_increase_type,
      bb_ante_start_level: day.bb_ante_start_level,
      rebuy_level_limit: day.rebuy_level_limit || '',
      break_interval: day.break_interval,
      break_duration: day.break_duration,
      allocation_type: day.allocation_type,
    });
    setShowCreateDayModal(true);
  };

  const handleDeleteDay = async (dayId) => {
    if (!window.confirm('Tem certeza que deseja excluir este dia do torneio?')) {
      return;
    }

    try {
      await api.delete(`/tournament-days/${dayId}`);
      loadTournamentData();
    } catch (err) {
      console.error('Error deleting day:', err);
      alert('Erro ao excluir dia do torneio');
    }
  };

  const handleStartDay = async (dayId) => {
    if (!window.confirm('Tem certeza que deseja iniciar este dia do torneio?')) {
      return;
    }

    try {
      await api.patch(`/tournament-days/${dayId}`, { status: 'active' });
      loadTournamentData();
    } catch (err) {
      console.error('Error starting day:', err);
      alert('Erro ao iniciar dia do torneio');
    }
  };

  const handleViewBroadcast = (dayId) => {
    // Navigate to broadcast page for this tournament day
    navigate(`/broadcast/${dayId}`);
  };

  const handleConfigureBlinds = (dayId) => {
    // Navigate to blinds management page for this tournament day
    navigate(`/blinds/${dayId}`);
  };

  const handleFinishDay = async (dayId) => {
    if (!window.confirm('Tem certeza que deseja finalizar este dia do torneio?')) {
      return;
    }

    try {
      await api.patch(`/tournament-days/${dayId}`, { status: 'completed' });
      loadTournamentData();
    } catch (err) {
      console.error('Error finishing day:', err);
      alert('Erro ao finalizar dia do torneio');
    }
  };

  const handleRestartDay = async (dayId) => {
    if (!window.confirm('Tem certeza que deseja reiniciar o timer deste dia? O torneio voltará ao nível 1.')) {
      return;
    }

    try {
      // Reset start_time to now and set status to active
      await api.patch(`/tournament-days/${dayId}`, {
        status: 'active',
        start_time: new Date().toISOString()
      });
      loadTournamentData();
    } catch (err) {
      console.error('Error restarting day:', err);
      alert('Erro ao reiniciar dia do torneio');
    }
  };

  const resetForm = () => {
    setFormData({
      day_name: '',
      day_number: days.length + 1,
      buy_in: 100,
      rebuy_amount: 100,
      addon_amount: 100,
      max_players: 100,
      rake_percentage: 20,
      starting_chips: 10000,
      rebuy_chips: 10000,
      addon_chips: 10000,
      blind_duration: 15,
      initial_small_blind: 50,
      initial_big_blind: 100,
      blind_increase_type: 'double',
      bb_ante_start_level: 3,
      rebuy_level_limit: '',
      break_interval: 60,
      break_duration: 10,
      allocation_type: 'automatic',
    });
  };

  const openCreateDayModal = () => {
    setEditingDay(null);
    resetForm();
    setShowCreateDayModal(true);
  };

  const getStatusBadge = (status) => {
    const labels = {
      pending: 'Pendente',
      active: 'Em Andamento',
      completed: 'Concluído',
      cancelled: 'Cancelado',
    };
    return <span className={`day-status-badge ${status}`}>{labels[status] || status}</span>;
  };

  if (loading) {
    return (
      <div className="app-container">
        <Sidebar />
        <main className="main-content">
          <div className="loading">Carregando...</div>
        </main>
      </div>
    );
  }

  if (!tournament) {
    return (
      <div className="app-container">
        <Sidebar />
        <main className="main-content">
          <Card>
            <p>Torneio não encontrado</p>
            <Button onClick={() => navigate('/torneios')}>Voltar</Button>
          </Card>
        </main>
      </div>
    );
  }

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div>
            <h1>{tournament.name}</h1>
            <p className="subtitle">Gerenciamento do Torneio</p>
          </div>
          <div className="header-actions">
            <Button onClick={() => navigate(`/premiacao/${id}`)}>
              Premiacao
            </Button>
            <Button onClick={openCreateDayModal}>
              Adicionar Dia ao Torneio
            </Button>
            <Button variant="secondary" onClick={() => navigate('/torneios')}>
              Voltar
            </Button>
          </div>
        </div>

        {/* Days List - Show only if there are days */}
        {days.length > 0 && (
          <div className="days-list-section">
            <h2 className="section-title">Dias Cadastrados ({days.length})</h2>
            <div className="days-list">
              {days.map((day) => (
                <Card key={day.id} className="day-card">
                  <div className="day-card-header">
                    <div className="day-card-title">
                      <h3>{day.day_name}</h3>
                      <span className="day-number-badge">Dia {day.day_number}</span>
                      {getStatusBadge(day.status)}
                    </div>
                    <div className="day-card-actions">
                      {day.status === 'pending' && (
                        <Button
                          size="small"
                          variant="primary"
                          onClick={() => handleStartDay(day.id)}
                        >
                          Iniciar Torneio
                        </Button>
                      )}
                      {day.status === 'active' && (
                        <>
                          <Button
                            size="small"
                            variant="primary"
                            onClick={() => handleViewBroadcast(day.id)}
                          >
                            Ver Apresentação
                          </Button>
                          <Button
                            size="small"
                            variant="secondary"
                            onClick={() => handleRestartDay(day.id)}
                          >
                            Reiniciar Timer
                          </Button>
                          <Button
                            size="small"
                            variant="warning"
                            onClick={() => handleFinishDay(day.id)}
                          >
                            Finalizar
                          </Button>
                        </>
                      )}
                      {day.status === 'completed' && (
                        <Button
                          size="small"
                          variant="secondary"
                          onClick={() => handleRestartDay(day.id)}
                        >
                          Reabrir Dia
                        </Button>
                      )}
                      <Button
                        size="small"
                        variant="secondary"
                        onClick={() => handleConfigureBlinds(day.id)}
                      >
                        Configurar Blinds
                      </Button>
                      <Button size="small" onClick={() => handleEditDay(day)}>
                        Editar
                      </Button>
                      <Button
                        size="small"
                        variant="danger"
                        onClick={() => handleDeleteDay(day.id)}
                        disabled={day.status !== 'pending'}
                      >
                        Excluir
                      </Button>
                    </div>
                  </div>

                  <div className="day-info-grid">
                    <div className="day-info-item">
                      <span className="day-info-label">Buy-in</span>
                      <span className="day-info-value">R$ {day.buy_in.toFixed(2)}</span>
                    </div>
                    <div className="day-info-item">
                      <span className="day-info-label">Rebuy</span>
                      <span className="day-info-value">
                        {day.rebuy_amount ? `R$ ${day.rebuy_amount.toFixed(2)}` : 'Não disponível'}
                      </span>
                    </div>
                    <div className="day-info-item">
                      <span className="day-info-label">Add-on</span>
                      <span className="day-info-value">
                        {day.addon_amount ? `R$ ${day.addon_amount.toFixed(2)}` : 'Não disponível'}
                      </span>
                    </div>
                    <div className="day-info-item">
                      <span className="day-info-label">Vagas</span>
                      <span className="day-info-value">
                        {day.registered_players} / {day.max_players}
                      </span>
                    </div>
                    <div className="day-info-item">
                      <span className="day-info-label">Rake</span>
                      <span className="day-info-value">{day.rake_percentage}%</span>
                    </div>
                    <div className="day-info-item">
                      <span className="day-info-label">Fichas Iniciais</span>
                      <span className="day-info-value">{day.starting_chips.toLocaleString()}</span>
                    </div>
                    <div className="day-info-item">
                      <span className="day-info-label">Duração dos Blinds</span>
                      <span className="day-info-value">{day.blind_duration} min</span>
                    </div>
                    <div className="day-info-item">
                      <span className="day-info-label">Entradas</span>
                      <span className="day-info-value">{day.total_entries || 0}</span>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </div>
        )}

        {/* Tabs Navigation */}
        <div className="tabs-container">
          <button
            className={`tab-button ${activeTab === 'dashboard' ? 'active' : ''}`}
            onClick={() => setActiveTab('dashboard')}
          >
            Dashboard
          </button>
          <button
            className={`tab-button ${activeTab === 'days' ? 'active' : ''}`}
            onClick={() => setActiveTab('days')}
          >
            Dias
          </button>
        </div>

        {/* Dashboard Tab */}
        {activeTab === 'dashboard' && (
          <div className="tab-content active">
            <TournamentDashboard tournamentId={id} />
          </div>
        )}

        {/* Days Tab */}
        {activeTab === 'days' && (
          <div className="tab-content active">
            <div className="section-header">
              <h2>Dias do Torneio ({days.length})</h2>
              <Button onClick={openCreateDayModal}>
                Criar Novo Dia
              </Button>
            </div>

            {days.length === 0 ? (
              <div className="empty-days">
                <div className="empty-days-icon"></div>
                <h3>Nenhum dia criado</h3>
                <p>Crie o primeiro dia deste torneio para começar a configuração</p>
                <Button onClick={openCreateDayModal}>
                  Criar Primeiro Dia
                </Button>
              </div>
            ) : (
              <div className="days-list">
                {days.map((day) => (
                  <Card key={day.id} className="day-card">
                    <div className="day-card-header">
                      <div className="day-card-title">
                        <h3>{day.day_name}</h3>
                        <span className="day-number-badge">Dia {day.day_number}</span>
                        {getStatusBadge(day.status)}
                      </div>
                      <div className="day-card-actions">
                        {day.status === 'pending' && (
                          <Button
                            size="small"
                            variant="primary"
                            onClick={() => handleStartDay(day.id)}
                          >
                            Iniciar Torneio
                          </Button>
                        )}
                        {day.status === 'active' && (
                          <>
                            <Button
                              size="small"
                              variant="primary"
                              onClick={() => handleViewBroadcast(day.id)}
                            >
                              Ver Apresentação
                            </Button>
                            <Button
                              size="small"
                              variant="secondary"
                              onClick={() => handleRestartDay(day.id)}
                            >
                              Reiniciar Timer
                            </Button>
                            <Button
                              size="small"
                              variant="warning"
                              onClick={() => handleFinishDay(day.id)}
                            >
                              Finalizar
                            </Button>
                          </>
                        )}
                        {day.status === 'completed' && (
                          <Button
                            size="small"
                            variant="secondary"
                            onClick={() => handleRestartDay(day.id)}
                          >
                            Reabrir Dia
                          </Button>
                        )}
                        <Button
                          size="small"
                          variant="secondary"
                          onClick={() => handleConfigureBlinds(day.id)}
                        >
                          Configurar Blinds
                        </Button>
                        <Button size="small" onClick={() => handleEditDay(day)}>
                          Editar
                        </Button>
                        <Button
                          size="small"
                          variant="danger"
                          onClick={() => handleDeleteDay(day.id)}
                          disabled={day.status !== 'pending'}
                        >
                          Excluir
                        </Button>
                      </div>
                    </div>

                    <div className="day-info-grid">
                      <div className="day-info-item">
                        <span className="day-info-label">Buy-in</span>
                        <span className="day-info-value">R$ {day.buy_in.toFixed(2)}</span>
                      </div>
                      <div className="day-info-item">
                        <span className="day-info-label">Rebuy</span>
                        <span className="day-info-value">
                          {day.rebuy_amount ? `R$ ${day.rebuy_amount.toFixed(2)}` : 'Não disponível'}
                        </span>
                      </div>
                      <div className="day-info-item">
                        <span className="day-info-label">Add-on</span>
                        <span className="day-info-value">
                          {day.addon_amount ? `R$ ${day.addon_amount.toFixed(2)}` : 'Não disponível'}
                        </span>
                      </div>
                      <div className="day-info-item">
                        <span className="day-info-label">Vagas</span>
                        <span className="day-info-value">
                          {day.registered_players} / {day.max_players}
                        </span>
                      </div>
                      <div className="day-info-item">
                        <span className="day-info-label">Rake</span>
                        <span className="day-info-value">{day.rake_percentage}%</span>
                      </div>
                      <div className="day-info-item">
                        <span className="day-info-label">Fichas Iniciais</span>
                        <span className="day-info-value">{day.starting_chips.toLocaleString()}</span>
                      </div>
                      <div className="day-info-item">
                        <span className="day-info-label">Duração dos Blinds</span>
                        <span className="day-info-value">{day.blind_duration} min</span>
                      </div>
                      <div className="day-info-item">
                        <span className="day-info-label">Entradas</span>
                        <span className="day-info-value">{day.total_entries || 0}</span>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Create/Edit Day Modal */}
        {showCreateDayModal && (
          <div className="modal-overlay" onClick={() => setShowCreateDayModal(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>{editingDay ? 'Editar Dia' : 'Criar Novo Dia'}</h2>
                <button className="close-btn" onClick={() => setShowCreateDayModal(false)} aria-label="Fechar">
                  <span className="close-icon"></span>
                </button>
              </div>
              <form onSubmit={handleCreateDay}>
                {/* Basic Info */}
                <div className="form-section">
                  <h4 className="form-section-title">Informações Básicas</h4>
                  <div className="form-row">
                    <div className="form-group">
                      <label htmlFor="day_name">Nome do Dia *</label>
                      <input
                        id="day_name"
                        type="text"
                        value={formData.day_name}
                        onChange={(e) => setFormData({ ...formData, day_name: e.target.value })}
                        placeholder="Ex: Dia 1A, Dia 1B, Dia Final"
                        required
                      />
                    </div>
                    <div className="form-group">
                      <label htmlFor="day_number">Número do Dia *</label>
                      <input
                        id="day_number"
                        type="number"
                        min="1"
                        value={formData.day_number}
                        onChange={(e) => setFormData({ ...formData, day_number: parseInt(e.target.value) })}
                        required
                      />
                    </div>
                  </div>
                </div>

                {/* Financial */}
                <div className="form-section">
                  <h4 className="form-section-title">Valores</h4>
                  <div className="form-row">
                    <div className="form-group">
                      <label htmlFor="buy_in">Buy-in (R$) *</label>
                      <input
                        id="buy_in"
                        type="number"
                        min="0"
                        step="0.01"
                        value={formData.buy_in}
                        onChange={(e) => setFormData({ ...formData, buy_in: parseFloat(e.target.value) })}
                        required
                      />
                    </div>
                    <div className="form-group">
                      <label htmlFor="rebuy_amount">Rebuy (R$)</label>
                      <input
                        id="rebuy_amount"
                        type="number"
                        min="0"
                        step="0.01"
                        value={formData.rebuy_amount}
                        onChange={(e) => setFormData({ ...formData, rebuy_amount: parseFloat(e.target.value) })}
                      />
                    </div>
                    <div className="form-group">
                      <label htmlFor="addon_amount">Add-on (R$)</label>
                      <input
                        id="addon_amount"
                        type="number"
                        min="0"
                        step="0.01"
                        value={formData.addon_amount}
                        onChange={(e) => setFormData({ ...formData, addon_amount: parseFloat(e.target.value) })}
                      />
                    </div>
                    <div className="form-group">
                      <label htmlFor="rake_percentage">Rake (%)</label>
                      <input
                        id="rake_percentage"
                        type="number"
                        min="0"
                        max="100"
                        step="0.1"
                        value={formData.rake_percentage}
                        onChange={(e) => setFormData({ ...formData, rake_percentage: parseFloat(e.target.value) })}
                      />
                    </div>
                  </div>
                </div>

                {/* Players and Chips */}
                <div className="form-section">
                  <h4 className="form-section-title">Jogadores e Fichas</h4>
                  <div className="form-row">
                    <div className="form-group">
                      <label htmlFor="max_players">Máximo de Jogadores *</label>
                      <input
                        id="max_players"
                        type="number"
                        min="1"
                        value={formData.max_players}
                        onChange={(e) => setFormData({ ...formData, max_players: parseInt(e.target.value) })}
                        required
                      />
                    </div>
                    <div className="form-group">
                      <label htmlFor="starting_chips">Fichas Iniciais *</label>
                      <input
                        id="starting_chips"
                        type="number"
                        min="1"
                        value={formData.starting_chips}
                        onChange={(e) => setFormData({ ...formData, starting_chips: parseInt(e.target.value) })}
                        required
                      />
                    </div>
                    <div className="form-group">
                      <label htmlFor="rebuy_chips">Fichas do Rebuy</label>
                      <input
                        id="rebuy_chips"
                        type="number"
                        min="0"
                        value={formData.rebuy_chips}
                        onChange={(e) => setFormData({ ...formData, rebuy_chips: parseInt(e.target.value) })}
                      />
                    </div>
                    <div className="form-group">
                      <label htmlFor="addon_chips">Fichas do Add-on</label>
                      <input
                        id="addon_chips"
                        type="number"
                        min="0"
                        value={formData.addon_chips}
                        onChange={(e) => setFormData({ ...formData, addon_chips: parseInt(e.target.value) })}
                      />
                    </div>
                  </div>
                </div>

                {/* Rebuy Limit */}
                <div className="form-section">
                  <h4 className="form-section-title">Configuração de Rebuy</h4>
                  <div className="form-row">
                    <div className="form-group">
                      <label htmlFor="rebuy_level_limit">Nível Limite Rebuy</label>
                      <input
                        id="rebuy_level_limit"
                        type="number"
                        min="1"
                        value={formData.rebuy_level_limit}
                        onChange={(e) => setFormData({ ...formData, rebuy_level_limit: e.target.value })}
                        placeholder="Deixe vazio para ilimitado"
                      />
                      <small>Até qual nível de blind o rebuy é permitido</small>
                    </div>
                  </div>
                </div>

                {/* Breaks */}
                <div className="form-section">
                  <h4 className="form-section-title">Intervalos</h4>
                  <div className="form-row">
                    <div className="form-group">
                      <label htmlFor="break_interval">Intervalo entre Breaks (min)</label>
                      <input
                        id="break_interval"
                        type="number"
                        min="1"
                        value={formData.break_interval}
                        onChange={(e) => setFormData({ ...formData, break_interval: parseInt(e.target.value) })}
                      />
                    </div>
                    <div className="form-group">
                      <label htmlFor="break_duration">Duração do Break (min)</label>
                      <input
                        id="break_duration"
                        type="number"
                        min="1"
                        value={formData.break_duration}
                        onChange={(e) => setFormData({ ...formData, break_duration: parseInt(e.target.value) })}
                      />
                    </div>
                    <div className="form-group">
                      <label htmlFor="allocation_type">Tipo de Alocação</label>
                      <select
                        id="allocation_type"
                        value={formData.allocation_type}
                        onChange={(e) => setFormData({ ...formData, allocation_type: e.target.value })}
                      >
                        <option value="automatic">Automática</option>
                        <option value="manual">Manual</option>
                      </select>
                    </div>
                  </div>
                </div>

                <div className="modal-actions">
                  <Button type="button" variant="secondary" onClick={() => setShowCreateDayModal(false)}>
                    Cancelar
                  </Button>
                  <Button type="submit" disabled={submitting}>
                    {submitting ? 'Salvando...' : (editingDay ? 'Salvar Alterações' : 'Criar Dia')}
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

export default TournamentDetail;
