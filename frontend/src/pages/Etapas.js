import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import Button from '../components/Button';
import api from '../config/api';
import './Etapas.css';

const Etapas = () => {
  const navigate = useNavigate();
  const [stages, setStages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingStage, setEditingStage] = useState(null);
  const [formData, setFormData] = useState({
    name: '',
    location: '',
    start_date: '',
    end_date: '',
    description: '',
    status: 'upcoming',
  });

  useEffect(() => {
    loadStages();
  }, []);

  const loadStages = async () => {
    try {
      const response = await api.get('/stages');
      setStages(response.data);
    } catch (error) {
      console.error('Erro ao carregar etapas:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      if (editingStage) {
        await api.patch(`/stages/${editingStage.id}`, formData);
      } else {
        await api.post('/stages', formData);
      }
      setShowModal(false);
      setEditingStage(null);
      setFormData({
        name: '',
        location: '',
        start_date: '',
        end_date: '',
        description: '',
        status: 'upcoming',
      });
      loadStages();
    } catch (error) {
      console.error('Erro ao salvar etapa:', error);
      const errorMessage = error.response?.data?.detail || 'Erro ao salvar etapa';
      alert(errorMessage);
    }
  };

  const handleEdit = (stage) => {
    setEditingStage(stage);
    setFormData({
      name: stage.name,
      location: stage.location,
      start_date: stage.start_date || '',
      end_date: stage.end_date || '',
      description: stage.description || '',
      status: stage.status,
    });
    setShowModal(true);
  };

  const handleDelete = async (stageId) => {
    if (window.confirm('Tem certeza que deseja excluir esta etapa? Os torneios não serão excluídos.')) {
      try {
        await api.delete(`/stages/${stageId}`);
        loadStages();
      } catch (error) {
        console.error('Erro ao excluir etapa:', error);
        alert('Erro ao excluir etapa.');
      }
    }
  };

  const handleChange = (e) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value,
    });
  };

  const openNewModal = () => {
    setEditingStage(null);
    setFormData({
      name: '',
      location: '',
      start_date: '',
      end_date: '',
      description: '',
      status: 'upcoming',
    });
    setShowModal(true);
  };

  const getStatusBadge = (status) => {
    const badges = {
      upcoming: { label: 'Próxima', className: 'badge-info' },
      active: { label: 'Em Andamento', className: 'badge-success' },
      completed: { label: 'Concluída', className: 'badge-secondary' },
      cancelled: { label: 'Cancelada', className: 'badge-danger' },
    };
    const badge = badges[status] || badges.upcoming;
    return <span className={`badge ${badge.className}`}>{badge.label}</span>;
  };

  const formatDate = (dateString) => {
    if (!dateString) return '-';
    return new Date(dateString).toLocaleDateString('pt-BR');
  };

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div>
            <h1>Etapas</h1>
            <p className="subtitle">Gerenciar etapas e eventos</p>
          </div>
          <Button onClick={openNewModal}>
            Nova Etapa
          </Button>
        </div>

        {loading ? (
          <div className="loading">Carregando etapas...</div>
        ) : stages.length === 0 ? (
          <Card>
            <div className="empty-state">
              <p>Nenhuma etapa cadastrada</p>
              <Button onClick={openNewModal}>Cadastrar Primeira Etapa</Button>
            </div>
          </Card>
        ) : (
          <div className="stages-grid">
            {stages.map((stage) => (
              <Card key={stage.id} className="stage-card">
                <div className="stage-header">
                  <h3>{stage.name}</h3>
                  {getStatusBadge(stage.status)}
                </div>
                <div className="stage-info">
                  <div className="info-row">
                    <span className="info-icon"></span>
                    <span>{stage.location}</span>
                  </div>
                  {stage.start_date && (
                    <div className="info-row">
                      <span className="info-icon"></span>
                      <span>
                        {formatDate(stage.start_date)}
                        {stage.end_date && ` - ${formatDate(stage.end_date)}`}
                      </span>
                    </div>
                  )}
                  <div className="info-row">
                    <span className="info-icon"></span>
                    <span>{stage.tournament_count} torneio(s)</span>
                  </div>
                  {stage.description && (
                    <p className="stage-description">{stage.description}</p>
                  )}
                </div>
                <div className="stage-actions">
                  <Button
                    variant="secondary"
                    className="action-btn"
                    onClick={() => navigate(`/torneios?stage=${stage.id}`)}
                  >
                    Ver Torneios
                  </Button>
                  <button
                    className="btn-icon"
                    onClick={() => handleEdit(stage)}
                    title="Editar"
                  >
                    Editar
                  </button>
                  <button
                    className="btn-icon btn-delete"
                    onClick={() => handleDelete(stage.id)}
                    title="Excluir"
                  >
                    Excluir
                  </button>
                </div>
              </Card>
            ))}
          </div>
        )}

        {showModal && (
          <div className="modal-overlay" onClick={() => setShowModal(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>{editingStage ? 'Editar Etapa' : 'Nova Etapa'}</h2>
                <button className="close-btn" onClick={() => setShowModal(false)}>
                  ✕
                </button>
              </div>
              <form onSubmit={handleSubmit}>
                <div className="form-group">
                  <label htmlFor="name">Nome da Etapa *</label>
                  <input
                    id="name"
                    name="name"
                    type="text"
                    value={formData.name}
                    onChange={handleChange}
                    required
                    placeholder="Ex: Etapa Bogotá"
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="location">Local *</label>
                  <input
                    id="location"
                    name="location"
                    type="text"
                    value={formData.location}
                    onChange={handleChange}
                    required
                    placeholder="Ex: Bogotá, Colômbia"
                  />
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label htmlFor="start_date">Data de Início</label>
                    <input
                      id="start_date"
                      name="start_date"
                      type="date"
                      value={formData.start_date}
                      onChange={handleChange}
                    />
                  </div>

                  <div className="form-group">
                    <label htmlFor="end_date">Data de Término</label>
                    <input
                      id="end_date"
                      name="end_date"
                      type="date"
                      value={formData.end_date}
                      onChange={handleChange}
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label htmlFor="status">Status</label>
                  <select
                    id="status"
                    name="status"
                    value={formData.status}
                    onChange={handleChange}
                    required
                  >
                    <option value="upcoming">Próxima</option>
                    <option value="active">Em Andamento</option>
                    <option value="completed">Concluída</option>
                    <option value="cancelled">Cancelada</option>
                  </select>
                </div>

                <div className="form-group">
                  <label htmlFor="description">Descrição</label>
                  <textarea
                    id="description"
                    name="description"
                    value={formData.description}
                    onChange={handleChange}
                    rows="3"
                    placeholder="Descrição da etapa (opcional)..."
                  />
                </div>

                <div className="modal-actions">
                  <Button type="button" variant="secondary" onClick={() => setShowModal(false)}>
                    Cancelar
                  </Button>
                  <Button type="submit">
                    {editingStage ? 'Atualizar' : 'Cadastrar'}
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

export default Etapas;
