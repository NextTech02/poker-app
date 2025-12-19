import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import Button from '../components/Button';
import api from '../config/api';
import './BlindManagement.css';

const BlindManagement = () => {
  const { tournamentId } = useParams();
  const navigate = useNavigate();
  const [tournament, setTournament] = useState(null);
  const [blinds, setBlinds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingBlind, setEditingBlind] = useState(null);
  const [formData, setFormData] = useState({
    level: '',
    small_blind: '',
    big_blind: '',
    ante: 0,
    duration: 15,
  });

  const loadData = useCallback(async () => {
    try {
      const [tournamentRes, blindsRes] = await Promise.all([
        api.get(`/tournaments/${tournamentId}`),
        api.get(`/tournaments/${tournamentId}/blinds`)
      ]);
      setTournament(tournamentRes.data);
      setBlinds(blindsRes.data.sort((a, b) => a.level - b.level));
    } catch (error) {
      console.error('Erro ao carregar dados:', error);
      alert('Erro ao carregar dados do torneio');
    } finally {
      setLoading(false);
    }
  }, [tournamentId]);

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tournamentId]);

  const handleChange = (e) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value,
    });
  };

  const handleAddBlind = async (e) => {
    e.preventDefault();
    try {
      await api.post(`/tournaments/${tournamentId}/blinds`, {
        level: parseInt(formData.level),
        small_blind: parseInt(formData.small_blind),
        big_blind: parseInt(formData.big_blind),
        ante: parseInt(formData.ante) || 0,
        duration: parseInt(formData.duration),
      });
      setShowAddModal(false);
      setFormData({
        level: '',
        small_blind: '',
        big_blind: '',
        ante: 0,
        duration: 15,
      });
      loadData();
      alert('Blind adicionado com sucesso!');
    } catch (error) {
      console.error('Erro ao adicionar blind:', error);
      const errorMessage = error.response?.data?.detail || 'Erro ao adicionar blind';
      alert(errorMessage);
    }
  };

  const handleEditBlind = async (e) => {
    e.preventDefault();
    try {
      await api.patch(`/tournaments/${tournamentId}/blinds/${editingBlind.id}`, {
        level: parseInt(formData.level),
        small_blind: parseInt(formData.small_blind),
        big_blind: parseInt(formData.big_blind),
        ante: parseInt(formData.ante) || 0,
        duration: parseInt(formData.duration),
      });
      setShowEditModal(false);
      setEditingBlind(null);
      setFormData({
        level: '',
        small_blind: '',
        big_blind: '',
        ante: 0,
        duration: 15,
      });
      loadData();
      alert('Blind atualizado com sucesso!');
    } catch (error) {
      console.error('Erro ao atualizar blind:', error);
      const errorMessage = error.response?.data?.detail || 'Erro ao atualizar blind';
      alert(errorMessage);
    }
  };

  const handleDeleteBlind = async (blindId) => {
    if (window.confirm('Tem certeza que deseja excluir este blind?')) {
      try {
        await api.delete(`/tournaments/${tournamentId}/blinds/${blindId}`);
        loadData();
        alert('Blind excluído com sucesso!');
      } catch (error) {
        console.error('Erro ao excluir blind:', error);
        alert('Erro ao excluir blind');
      }
    }
  };

  const openEditModal = (blind) => {
    setEditingBlind(blind);
    setFormData({
      level: blind.level,
      small_blind: blind.small_blind,
      big_blind: blind.big_blind,
      ante: blind.ante || 0,
      duration: blind.duration,
    });
    setShowEditModal(true);
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
            <h1>Estrutura de Blinds</h1>
            <p className="subtitle">{tournament.name}</p>
          </div>
          <div className="header-actions">
            <Button onClick={() => setShowAddModal(true)}>
              Adicionar Blind
            </Button>
            <Button variant="secondary" onClick={() => navigate('/torneios')}>
              Voltar
            </Button>
          </div>
        </div>

        {blinds.length === 0 ? (
          <Card>
            <div className="empty-state">
              <p>Nenhum blind cadastrado ainda</p>
              <Button onClick={() => setShowAddModal(true)}>
                Adicionar Primeiro Blind
              </Button>
            </div>
          </Card>
        ) : (
          <Card>
            <div className="blinds-table-container">
              <table className="blinds-table">
                <thead>
                  <tr>
                    <th>Nível</th>
                    <th>Small Blind</th>
                    <th>Big Blind</th>
                    <th>Ante</th>
                    <th>Duração (min)</th>
                    <th>Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {blinds.map((blind) => (
                    <tr key={blind.id} className="blind-row">
                      <td className="level-cell">
                        <strong>Nível {blind.level}</strong>
                      </td>
                      <td>{blind.small_blind.toLocaleString()}</td>
                      <td>{blind.big_blind.toLocaleString()}</td>
                      <td>{blind.ante ? blind.ante.toLocaleString() : '-'}</td>
                      <td>{blind.duration}</td>
                      <td>
                        <div className="action-buttons">
                          <button
                            className="btn-small btn-edit"
                            onClick={() => openEditModal(blind)}
                            title="Editar"
                          >
                            ✏️
                          </button>
                          <button
                            className="btn-small btn-delete"
                            onClick={() => handleDeleteBlind(blind.id)}
                            title="Excluir"
                          >
                            🗑️
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {/* Add Blind Modal */}
        {showAddModal && (
          <div className="modal-overlay" onClick={() => setShowAddModal(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>Adicionar Blind</h2>
                <button className="close-btn" onClick={() => setShowAddModal(false)}>
                  ✕
                </button>
              </div>
              <form onSubmit={handleAddBlind}>
                <div className="form-group">
                  <label htmlFor="level">Nível *</label>
                  <input
                    id="level"
                    name="level"
                    type="number"
                    min="1"
                    value={formData.level}
                    onChange={handleChange}
                    required
                    placeholder="Ex: 1"
                  />
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label htmlFor="small_blind">Small Blind *</label>
                    <input
                      id="small_blind"
                      name="small_blind"
                      type="number"
                      min="1"
                      value={formData.small_blind}
                      onChange={handleChange}
                      required
                      placeholder="Ex: 25"
                    />
                  </div>

                  <div className="form-group">
                    <label htmlFor="big_blind">Big Blind *</label>
                    <input
                      id="big_blind"
                      name="big_blind"
                      type="number"
                      min="1"
                      value={formData.big_blind}
                      onChange={handleChange}
                      required
                      placeholder="Ex: 50"
                    />
                  </div>
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label htmlFor="ante">Ante</label>
                    <input
                      id="ante"
                      name="ante"
                      type="number"
                      min="0"
                      value={formData.ante}
                      onChange={handleChange}
                      placeholder="0"
                    />
                  </div>

                  <div className="form-group">
                    <label htmlFor="duration">Duração (minutos) *</label>
                    <input
                      id="duration"
                      name="duration"
                      type="number"
                      min="1"
                      value={formData.duration}
                      onChange={handleChange}
                      required
                      placeholder="15"
                    />
                  </div>
                </div>

                <div className="modal-actions">
                  <Button type="button" variant="secondary" onClick={() => setShowAddModal(false)}>
                    Cancelar
                  </Button>
                  <Button type="submit">Adicionar</Button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Edit Blind Modal */}
        {showEditModal && (
          <div className="modal-overlay" onClick={() => setShowEditModal(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>Editar Blind</h2>
                <button className="close-btn" onClick={() => setShowEditModal(false)}>
                  ✕
                </button>
              </div>
              <form onSubmit={handleEditBlind}>
                <div className="form-group">
                  <label htmlFor="edit_level">Nível *</label>
                  <input
                    id="edit_level"
                    name="level"
                    type="number"
                    min="1"
                    value={formData.level}
                    onChange={handleChange}
                    required
                  />
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label htmlFor="edit_small_blind">Small Blind *</label>
                    <input
                      id="edit_small_blind"
                      name="small_blind"
                      type="number"
                      min="1"
                      value={formData.small_blind}
                      onChange={handleChange}
                      required
                    />
                  </div>

                  <div className="form-group">
                    <label htmlFor="edit_big_blind">Big Blind *</label>
                    <input
                      id="edit_big_blind"
                      name="big_blind"
                      type="number"
                      min="1"
                      value={formData.big_blind}
                      onChange={handleChange}
                      required
                    />
                  </div>
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label htmlFor="edit_ante">Ante</label>
                    <input
                      id="edit_ante"
                      name="ante"
                      type="number"
                      min="0"
                      value={formData.ante}
                      onChange={handleChange}
                    />
                  </div>

                  <div className="form-group">
                    <label htmlFor="edit_duration">Duração (minutos) *</label>
                    <input
                      id="edit_duration"
                      name="duration"
                      type="number"
                      min="1"
                      value={formData.duration}
                      onChange={handleChange}
                      required
                    />
                  </div>
                </div>

                <div className="modal-actions">
                  <Button type="button" variant="secondary" onClick={() => setShowEditModal(false)}>
                    Cancelar
                  </Button>
                  <Button type="submit">Salvar</Button>
                </div>
              </form>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default BlindManagement;
