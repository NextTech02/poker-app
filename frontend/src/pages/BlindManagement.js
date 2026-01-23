import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import Button from '../components/Button';
import api from '../config/api';
import './BlindManagement.css';

const BlindManagement = () => {
  const { dayId } = useParams();
  const navigate = useNavigate();
  const [tournamentDay, setTournamentDay] = useState(null);
  const [tournament, setTournament] = useState(null);
  const [blinds, setBlinds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingBlind, setEditingBlind] = useState(null);
  const [isBreakMode, setIsBreakMode] = useState(false);
  const [formData, setFormData] = useState({
    level: '',
    small_blind: '',
    big_blind: '',
    ante: 0,
    duration: 15,
    is_break: false,
  });

  const loadData = useCallback(async () => {
    try {
      // Load tournament day and its blinds
      const [dayRes, blindsRes] = await Promise.all([
        api.get(`/tournament-days/${dayId}`),
        api.get(`/tournament-days/${dayId}/blinds`)
      ]);

      setTournamentDay(dayRes.data);
      setBlinds(blindsRes.data.sort((a, b) => a.level - b.level));

      // Load tournament info for display
      if (dayRes.data.tournament_id) {
        const tournamentRes = await api.get(`/tournaments/${dayRes.data.tournament_id}`);
        setTournament(tournamentRes.data);
      }
    } catch (error) {
      console.error('Erro ao carregar dados:', error);
      alert('Erro ao carregar dados do dia do torneio');
    } finally {
      setLoading(false);
    }
  }, [dayId]);

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayId]);

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData({
      ...formData,
      [name]: type === 'checkbox' ? checked : value,
    });
  };

  const handleAddBlind = async (e) => {
    e.preventDefault();
    try {
      const data = {
        level: parseInt(formData.level),
        duration: parseInt(formData.duration),
        is_break: formData.is_break,
      };

      // Only include blind values if it's not a break
      if (!formData.is_break) {
        data.small_blind = parseInt(formData.small_blind);
        data.big_blind = parseInt(formData.big_blind);
        data.ante = parseInt(formData.ante) || 0;
      } else {
        data.small_blind = 0;
        data.big_blind = 0;
        data.ante = 0;
      }

      await api.post(`/tournament-days/${dayId}/blinds`, data);
      setShowAddModal(false);
      setIsBreakMode(false);
      setFormData({
        level: '',
        small_blind: '',
        big_blind: '',
        ante: 0,
        duration: 15,
        is_break: false,
      });
      loadData();
    } catch (error) {
      console.error('Erro ao adicionar blind:', error);
      const errorMessage = error.response?.data?.detail || 'Erro ao adicionar blind';
      alert(errorMessage);
    }
  };

  const handleEditBlind = async (e) => {
    e.preventDefault();
    try {
      const data = {
        level: parseInt(formData.level),
        duration: parseInt(formData.duration),
        is_break: formData.is_break,
      };

      // Only include blind values if it's not a break
      if (!formData.is_break) {
        data.small_blind = parseInt(formData.small_blind);
        data.big_blind = parseInt(formData.big_blind);
        data.ante = parseInt(formData.ante) || 0;
      } else {
        data.small_blind = 0;
        data.big_blind = 0;
        data.ante = 0;
      }

      await api.patch(`/tournament-days/${dayId}/blinds/${editingBlind.id}`, data);
      setShowEditModal(false);
      setEditingBlind(null);
      setFormData({
        level: '',
        small_blind: '',
        big_blind: '',
        ante: 0,
        duration: 15,
        is_break: false,
      });
      loadData();
    } catch (error) {
      console.error('Erro ao atualizar blind:', error);
      const errorMessage = error.response?.data?.detail || 'Erro ao atualizar blind';
      alert(errorMessage);
    }
  };

  const handleDeleteBlind = async (blindId) => {
    if (window.confirm('Tem certeza que deseja excluir este item?')) {
      try {
        await api.delete(`/tournament-days/${dayId}/blinds/${blindId}`);
        loadData();
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
      small_blind: blind.small_blind || '',
      big_blind: blind.big_blind || '',
      ante: blind.ante || 0,
      duration: blind.duration,
      is_break: blind.is_break || false,
    });
    setShowEditModal(true);
  };

  const openAddModal = (asBreak = false) => {
    // Auto-suggest next level
    const nextLevel = blinds.length > 0 ? Math.max(...blinds.map(b => b.level)) + 1 : 1;
    // Auto-suggest blinds based on last non-break level
    const lastBlind = blinds.filter(b => !b.is_break).slice(-1)[0];

    setIsBreakMode(asBreak);
    setFormData({
      level: nextLevel,
      small_blind: asBreak ? 0 : (lastBlind ? lastBlind.small_blind * 2 : ''),
      big_blind: asBreak ? 0 : (lastBlind ? lastBlind.big_blind * 2 : ''),
      ante: asBreak ? 0 : (lastBlind ? (lastBlind.ante > 0 ? lastBlind.ante * 2 : lastBlind.big_blind) : 0),
      duration: asBreak ? 10 : (lastBlind ? lastBlind.duration : 15),
      is_break: asBreak,
    });
    setShowAddModal(true);
  };

  const getDisplayTitle = () => {
    if (tournament && tournamentDay) {
      return `${tournament.name} - ${tournamentDay.day_name}`;
    }
    if (tournamentDay) {
      return tournamentDay.day_name;
    }
    return 'Estrutura de Blinds';
  };

  // Calculate summary stats
  const blindLevels = blinds.filter(b => !b.is_break);
  const breakLevels = blinds.filter(b => b.is_break);
  const totalDuration = blinds.reduce((acc, b) => acc + b.duration, 0);
  const totalBreakTime = breakLevels.reduce((acc, b) => acc + b.duration, 0);

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

  if (!tournamentDay) {
    return (
      <div className="app-container">
        <Sidebar />
        <main className="main-content">
          <Card>
            <p>Dia do torneio nao encontrado</p>
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
            <p className="subtitle">{getDisplayTitle()}</p>
          </div>
          <div className="header-actions">
            <Button onClick={() => openAddModal(false)}>
              Adicionar Blind
            </Button>
            <Button variant="warning" onClick={() => openAddModal(true)}>
              Adicionar Break
            </Button>
            <Button variant="secondary" onClick={() => navigate(-1)}>
              Voltar
            </Button>
          </div>
        </div>

        {blinds.length === 0 ? (
          <Card>
            <div className="empty-state">
              <p>Nenhum blind cadastrado ainda</p>
              <p className="empty-hint">Configure a estrutura de blinds para este dia do torneio</p>
              <div className="empty-actions">
                <Button onClick={() => openAddModal(false)}>
                  Adicionar Primeiro Blind
                </Button>
              </div>
            </div>
          </Card>
        ) : (
          <Card>
            <div className="blinds-table-container">
              <table className="blinds-table">
                <thead>
                  <tr>
                    <th>Nivel</th>
                    <th>Small Blind</th>
                    <th>Big Blind</th>
                    <th>Ante</th>
                    <th>Duracao (min)</th>
                    <th>Acoes</th>
                  </tr>
                </thead>
                <tbody>
                  {blinds.map((blind) => (
                    <tr key={blind.id} className={`blind-row ${blind.is_break ? 'break-row' : ''}`}>
                      <td className="level-cell">
                        {blind.is_break ? (
                          <span className="break-badge">BREAK</span>
                        ) : (
                          <strong>Nivel {blind.level}</strong>
                        )}
                      </td>
                      <td>{blind.is_break ? '-' : blind.small_blind.toLocaleString()}</td>
                      <td>{blind.is_break ? '-' : blind.big_blind.toLocaleString()}</td>
                      <td>{blind.is_break ? '-' : (blind.ante ? blind.ante.toLocaleString() : '-')}</td>
                      <td>{blind.duration} min</td>
                      <td>
                        <div className="action-buttons">
                          <button
                            className="btn-small btn-edit"
                            onClick={() => openEditModal(blind)}
                            title="Editar"
                          >
                            Editar
                          </button>
                          <button
                            className="btn-small btn-delete"
                            onClick={() => handleDeleteBlind(blind.id)}
                            title="Excluir"
                          >
                            Excluir
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Summary */}
            <div className="blinds-summary">
              <span>Niveis: {blindLevels.length}</span>
              <span>Breaks: {breakLevels.length}</span>
              <span>Duracao total: {totalDuration} min ({Math.floor(totalDuration / 60)}h {totalDuration % 60}min)</span>
              <span>Tempo de break: {totalBreakTime} min</span>
            </div>
          </Card>
        )}

        {/* Add Blind/Break Modal */}
        {showAddModal && (
          <div className="modal-overlay" onClick={() => setShowAddModal(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>{formData.is_break ? 'Adicionar Break' : 'Adicionar Blind'}</h2>
                <button className="close-btn" onClick={() => setShowAddModal(false)} aria-label="Fechar">
                  <span className="close-icon"></span>
                </button>
              </div>
              <form onSubmit={handleAddBlind}>
                <div className="form-group">
                  <label htmlFor="level">Posicao na Estrutura *</label>
                  <select
                    id="level"
                    name="level"
                    value={formData.level}
                    onChange={handleChange}
                    required
                    className="level-select"
                  >
                    {/* Generate position options */}
                    {(() => {
                      const maxLevel = blinds.length > 0 ? Math.max(...blinds.map(b => b.level)) : 0;
                      const existingLevels = new Set(blinds.map(b => b.level));
                      const options = [];

                      // Generate options for all available levels (1 to maxLevel + 1)
                      for (let i = 1; i <= maxLevel + 1; i++) {
                        // Skip if level already exists
                        if (existingLevels.has(i)) continue;

                        const prevBlind = blinds.filter(b => b.level < i).sort((a, b) => b.level - a.level)[0];
                        const nextBlind = blinds.filter(b => b.level > i).sort((a, b) => a.level - b.level)[0];

                        let label = `Nivel ${i}`;
                        if (prevBlind && nextBlind) {
                          const prevLabel = prevBlind.is_break ? 'Break' : `${prevBlind.small_blind}/${prevBlind.big_blind}`;
                          const nextLabel = nextBlind.is_break ? 'Break' : `${nextBlind.small_blind}/${nextBlind.big_blind}`;
                          label += ` (entre ${prevLabel} e ${nextLabel})`;
                        } else if (prevBlind) {
                          const prevLabel = prevBlind.is_break ? 'Break' : `${prevBlind.small_blind}/${prevBlind.big_blind}`;
                          label += ` (apos ${prevLabel})`;
                        } else if (nextBlind) {
                          const nextLabel = nextBlind.is_break ? 'Break' : `${nextBlind.small_blind}/${nextBlind.big_blind}`;
                          label += ` (antes de ${nextLabel})`;
                        } else {
                          label += ' (primeiro nivel)';
                        }
                        options.push(<option key={i} value={i}>{label}</option>);
                      }

                      return options;
                    })()}
                  </select>
                </div>

                <div className="form-group">
                  <label htmlFor="duration">Duracao (minutos) *</label>
                  <input
                    id="duration"
                    name="duration"
                    type="number"
                    min="1"
                    value={formData.duration}
                    onChange={handleChange}
                    required
                    placeholder={formData.is_break ? "10" : "15"}
                  />
                </div>

                {!formData.is_break && (
                  <>
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
                  </>
                )}

                {formData.is_break && (
                  <div className="break-info">
                    <p>Os jogadores terao {formData.duration || '?'} minutos de intervalo neste ponto do torneio.</p>
                  </div>
                )}

                <div className="modal-actions">
                  <Button type="button" variant="secondary" onClick={() => setShowAddModal(false)}>
                    Cancelar
                  </Button>
                  <Button type="submit">{formData.is_break ? 'Adicionar Break' : 'Adicionar Blind'}</Button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Edit Blind/Break Modal */}
        {showEditModal && (
          <div className="modal-overlay" onClick={() => setShowEditModal(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>{formData.is_break ? 'Editar Break' : 'Editar Blind'}</h2>
                <button className="close-btn" onClick={() => setShowEditModal(false)} aria-label="Fechar">
                  <span className="close-icon"></span>
                </button>
              </div>
              <form onSubmit={handleEditBlind}>
                <div className="form-group type-toggle">
                  <label>
                    <input
                      type="checkbox"
                      name="is_break"
                      checked={formData.is_break}
                      onChange={handleChange}
                    />
                    <span className="toggle-label">Este nivel e um Break/Intervalo</span>
                  </label>
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label htmlFor="edit_level">Nivel *</label>
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

                  <div className="form-group">
                    <label htmlFor="edit_duration">Duracao (minutos) *</label>
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

                {!formData.is_break && (
                  <>
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
                  </>
                )}

                {formData.is_break && (
                  <div className="break-info">
                    <p>Os jogadores terao {formData.duration || '?'} minutos de intervalo neste ponto do torneio.</p>
                  </div>
                )}

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
