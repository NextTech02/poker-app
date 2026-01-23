import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import Button from '../components/Button';
import api from '../config/api';
import './Torneios.css';

const Torneios = () => {
  const navigate = useNavigate();
  const [tournaments, setTournaments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingTournament, setEditingTournament] = useState(null);
  const [formData, setFormData] = useState({
    name: '',
  });
  const [broadcastSettings, setBroadcastSettings] = useState({
    broadcast_bg_color: '#0a0e13',
    broadcast_bg_image_url: '',
    broadcast_display_name: '',
    broadcast_font_size: 100,
    broadcast_show_logo: true,
    broadcast_show_title: true,
    broadcast_show_prizepool: true,
    broadcast_show_level: true,
    broadcast_show_players: true,
    broadcast_show_interval: true,
    broadcast_show_timer: true,
    broadcast_show_blinds: true,
    broadcast_show_ante: true,
    broadcast_show_next_blind: true,
    broadcast_show_prizes: true,
  });

  useEffect(() => {
    loadTournaments();

    // Setup polling (every 5 seconds)
    const pollingInterval = setInterval(() => {
      loadTournaments();
    }, 5000);

    return () => {
      clearInterval(pollingInterval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadTournaments = async () => {
    try {
      // Get tournament summaries with aggregated data from all days
      const response = await api.get('/tournaments');
      setTournaments(response.data);
    } catch (error) {
      console.error('Erro ao carregar torneios:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const tournamentData = {
        name: formData.name,
        // stage_id will be automatically set from X-Stage-ID header if a stage is selected
      };

      await api.post('/tournaments', tournamentData);

      setShowModal(false);
      setFormData({ name: '' });
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

  const handleEditSubmit = async (e) => {
    e.preventDefault();
    try {
      await api.patch(`/tournaments/${editingTournament.id}`, {
        name: formData.name,
        ...broadcastSettings,
        broadcast_bg_image_url: broadcastSettings.broadcast_bg_image_url || null,
        broadcast_display_name: broadcastSettings.broadcast_display_name || null,
      });

      setShowEditModal(false);
      setEditingTournament(null);
      setFormData({ name: '' });
      setBroadcastSettings({
        broadcast_bg_color: '#0a0e13',
        broadcast_bg_image_url: '',
        broadcast_display_name: '',
        broadcast_font_size: 100,
        broadcast_show_logo: true,
        broadcast_show_title: true,
        broadcast_show_prizepool: true,
        broadcast_show_level: true,
        broadcast_show_players: true,
        broadcast_show_interval: true,
        broadcast_show_timer: true,
        broadcast_show_blinds: true,
        broadcast_show_ante: true,
        broadcast_show_next_blind: true,
        broadcast_show_prizes: true,
      });
      loadTournaments();
    } catch (error) {
      console.error('Erro ao atualizar torneio:', error);
      alert('Erro ao atualizar torneio');
    }
  };

  const handleChange = (e) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value,
    });
  };

  const handleBroadcastChange = (e) => {
    const { name, value, type, checked } = e.target;
    setBroadcastSettings({
      ...broadcastSettings,
      [name]: type === 'checkbox' ? checked : value,
    });
  };

  const handleImageUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      // Validate file size (max 2MB for base64 storage)
      if (file.size > 2 * 1024 * 1024) {
        alert('Imagem muito grande. Máximo: 2MB');
        return;
      }

      const reader = new FileReader();
      reader.onloadend = () => {
        setBroadcastSettings({
          ...broadcastSettings,
          broadcast_bg_image_url: reader.result,
        });
      };
      reader.readAsDataURL(file);
    }
  };

  const removeBackgroundImage = () => {
    setBroadcastSettings({
      ...broadcastSettings,
      broadcast_bg_image_url: '',
    });
  };

  const openEditModal = (tournament) => {
    setEditingTournament(tournament);
    setFormData({
      name: tournament.name,
    });
    setBroadcastSettings({
      broadcast_bg_color: tournament.broadcast_bg_color || '#0a0e13',
      broadcast_bg_image_url: tournament.broadcast_bg_image_url || '',
      broadcast_display_name: tournament.broadcast_display_name || '',
      broadcast_font_size: tournament.broadcast_font_size || 100,
      broadcast_show_logo: tournament.broadcast_show_logo !== false,
      broadcast_show_title: tournament.broadcast_show_title !== false,
      broadcast_show_prizepool: tournament.broadcast_show_prizepool !== false,
      broadcast_show_level: tournament.broadcast_show_level !== false,
      broadcast_show_players: tournament.broadcast_show_players !== false,
      broadcast_show_interval: tournament.broadcast_show_interval !== false,
      broadcast_show_timer: tournament.broadcast_show_timer !== false,
      broadcast_show_blinds: tournament.broadcast_show_blinds !== false,
      broadcast_show_ante: tournament.broadcast_show_ante !== false,
      broadcast_show_next_blind: tournament.broadcast_show_next_blind !== false,
      broadcast_show_prizes: tournament.broadcast_show_prizes !== false,
    });
    setShowEditModal(true);
  };

  const handleDeleteTournament = async (tournamentId) => {
    if (!window.confirm('Tem certeza que deseja excluir este torneio?')) {
      return;
    }

    try {
      await api.delete(`/tournaments/${tournamentId}`);
      loadTournaments();
    } catch (error) {
      console.error('Erro ao excluir torneio:', error);
      alert('Erro ao excluir torneio');
    }
  };

  const getTournamentEntries = (tournament) => {
    // For now, return 0 as we need to aggregate from tournament_days
    // This will be properly calculated by the backend
    return tournament.total_entries || 0;
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

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div>
            <h1>Torneios</h1>
            <p className="subtitle">Gerencie os torneios da etapa</p>
          </div>
          <Button onClick={() => setShowModal(true)}>
            Criar Novo Torneio
          </Button>
        </div>

        {tournaments.length === 0 ? (
          <Card>
            <div className="empty-state">
              <p>Nenhum torneio criado ainda</p>
              <Button onClick={() => setShowModal(true)}>
                Criar Primeiro Torneio
              </Button>
            </div>
          </Card>
        ) : (
          <Card>
            <div className="tournaments-table-container">
              <table className="tournaments-table">
                <thead>
                  <tr>
                    <th>Nome</th>
                    <th className="text-center">Entradas</th>
                    <th className="text-center">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {tournaments.map((tournament) => (
                    <tr
                      key={tournament.id}
                      onClick={() => navigate(`/torneios/${tournament.id}`)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td>
                        <strong>{tournament.name}</strong>
                      </td>
                      <td className="text-center">
                        {getTournamentEntries(tournament)}
                      </td>
                      <td className="text-center">
                        <div className="action-buttons" onClick={(e) => e.stopPropagation()}>
                          <Button
                            size="small"
                            variant="secondary"
                            onClick={() => openEditModal(tournament)}
                          >
                            Editar
                          </Button>
                          <Button
                            size="small"
                            variant="danger"
                            onClick={() => handleDeleteTournament(tournament.id)}
                          >
                            Excluir
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {/* Create Modal */}
        {showModal && (
          <div className="modal-overlay" onClick={() => setShowModal(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>Criar Novo Torneio</h2>
                <button className="close-btn" onClick={() => setShowModal(false)} aria-label="Fechar">
                  <span className="close-icon"></span>
                </button>
              </div>
              <form onSubmit={handleSubmit}>
                <div className="form-group">
                  <label htmlFor="name">Nome do Torneio *</label>
                  <input
                    id="name"
                    name="name"
                    type="text"
                    value={formData.name}
                    onChange={handleChange}
                    placeholder="Ex: Torneio de Sexta, Torneio de Sábado"
                    required
                  />
                  <small>Depois de criar o torneio, você poderá adicionar os dias e configurações.</small>
                </div>

                <div className="modal-actions">
                  <Button type="button" variant="secondary" onClick={() => setShowModal(false)}>
                    Cancelar
                  </Button>
                  <Button type="submit">
                    Criar Torneio
                  </Button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Edit Modal */}
        {showEditModal && (
          <div className="modal-overlay" onClick={() => setShowEditModal(false)}>
            <div className="modal modal-large" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>Editar Torneio</h2>
                <button className="close-btn" onClick={() => setShowEditModal(false)} aria-label="Fechar">
                  <span className="close-icon"></span>
                </button>
              </div>
              <form onSubmit={handleEditSubmit}>
                <div className="form-group">
                  <label htmlFor="edit-name">Nome do Torneio *</label>
                  <input
                    id="edit-name"
                    name="name"
                    type="text"
                    value={formData.name}
                    onChange={handleChange}
                    required
                  />
                </div>

                <div className="form-section">
                  <h3 className="section-title">Configurações de Visualização (Broadcast)</h3>

                  <div className="form-row">
                    <div className="form-group">
                      <label htmlFor="broadcast_bg_color">Cor de Fundo</label>
                      <div className="color-input-wrapper">
                        <input
                          id="broadcast_bg_color"
                          name="broadcast_bg_color"
                          type="color"
                          value={broadcastSettings.broadcast_bg_color}
                          onChange={handleBroadcastChange}
                          className="color-input"
                        />
                        <input
                          type="text"
                          value={broadcastSettings.broadcast_bg_color}
                          onChange={handleBroadcastChange}
                          name="broadcast_bg_color"
                          className="color-text-input"
                          placeholder="#0a0e13"
                        />
                      </div>
                    </div>
                    <div className="form-group">
                      <label htmlFor="broadcast_display_name">Nome de Exibição</label>
                      <input
                        id="broadcast_display_name"
                        name="broadcast_display_name"
                        type="text"
                        value={broadcastSettings.broadcast_display_name}
                        onChange={handleBroadcastChange}
                        placeholder="Nome customizado (opcional)"
                      />
                    </div>
                  </div>

                  <div className="form-group">
                    <label htmlFor="broadcast_font_size">Tamanho da Fonte: {broadcastSettings.broadcast_font_size}%</label>
                    <div className="font-size-slider-wrapper">
                      <span className="slider-label">50%</span>
                      <input
                        id="broadcast_font_size"
                        name="broadcast_font_size"
                        type="range"
                        min="50"
                        max="200"
                        step="10"
                        value={broadcastSettings.broadcast_font_size}
                        onChange={handleBroadcastChange}
                        className="font-size-slider"
                      />
                      <span className="slider-label">200%</span>
                    </div>
                  </div>

                  <div className="form-group">
                    <label>Imagem de Fundo</label>
                    <div className="image-upload-container">
                      {broadcastSettings.broadcast_bg_image_url ? (
                        <div className="image-preview-wrapper">
                          <img
                            src={broadcastSettings.broadcast_bg_image_url}
                            alt="Preview"
                            className="image-preview"
                          />
                          <button
                            type="button"
                            className="remove-image-btn"
                            onClick={removeBackgroundImage}
                            title="Remover imagem"
                          >
                            ×
                          </button>
                        </div>
                      ) : (
                        <label className="image-upload-area">
                          <input
                            type="file"
                            accept="image/*"
                            onChange={handleImageUpload}
                            className="hidden-input"
                          />
                          <div className="upload-placeholder">
                            <span className="upload-icon">+</span>
                            <span className="upload-text">Clique para anexar imagem</span>
                            <span className="upload-hint">PNG, JPG até 2MB</span>
                          </div>
                        </label>
                      )}
                    </div>
                    <div className="image-url-alternative">
                      <span className="or-divider">ou cole uma URL</span>
                      <input
                        id="broadcast_bg_image_url"
                        name="broadcast_bg_image_url"
                        type="text"
                        value={broadcastSettings.broadcast_bg_image_url?.startsWith('data:') ? '' : broadcastSettings.broadcast_bg_image_url}
                        onChange={handleBroadcastChange}
                        placeholder="https://exemplo.com/imagem.jpg"
                        disabled={broadcastSettings.broadcast_bg_image_url?.startsWith('data:')}
                      />
                    </div>
                  </div>

                  <div className="form-group">
                    <label className="section-label">Elementos Visíveis no Broadcast</label>
                    <div className="visibility-grid">
                      <label className={`visibility-card ${broadcastSettings.broadcast_show_logo ? 'active' : ''}`}>
                        <input
                          type="checkbox"
                          name="broadcast_show_logo"
                          checked={broadcastSettings.broadcast_show_logo}
                          onChange={handleBroadcastChange}
                        />
                        <span className="visibility-label">Logo</span>
                        <span className="visibility-toggle"></span>
                      </label>
                      <label className={`visibility-card ${broadcastSettings.broadcast_show_title ? 'active' : ''}`}>
                        <input
                          type="checkbox"
                          name="broadcast_show_title"
                          checked={broadcastSettings.broadcast_show_title}
                          onChange={handleBroadcastChange}
                        />
                        <span className="visibility-label">Título</span>
                        <span className="visibility-toggle"></span>
                      </label>
                      <label className={`visibility-card ${broadcastSettings.broadcast_show_prizepool ? 'active' : ''}`}>
                        <input
                          type="checkbox"
                          name="broadcast_show_prizepool"
                          checked={broadcastSettings.broadcast_show_prizepool}
                          onChange={handleBroadcastChange}
                        />
                        <span className="visibility-label">Prizepool</span>
                        <span className="visibility-toggle"></span>
                      </label>
                      <label className={`visibility-card ${broadcastSettings.broadcast_show_level ? 'active' : ''}`}>
                        <input
                          type="checkbox"
                          name="broadcast_show_level"
                          checked={broadcastSettings.broadcast_show_level}
                          onChange={handleBroadcastChange}
                        />
                        <span className="visibility-label">Nível</span>
                        <span className="visibility-toggle"></span>
                      </label>
                      <label className={`visibility-card ${broadcastSettings.broadcast_show_players ? 'active' : ''}`}>
                        <input
                          type="checkbox"
                          name="broadcast_show_players"
                          checked={broadcastSettings.broadcast_show_players}
                          onChange={handleBroadcastChange}
                        />
                        <span className="visibility-label">Jogadores</span>
                        <span className="visibility-toggle"></span>
                      </label>
                      <label className={`visibility-card ${broadcastSettings.broadcast_show_interval ? 'active' : ''}`}>
                        <input
                          type="checkbox"
                          name="broadcast_show_interval"
                          checked={broadcastSettings.broadcast_show_interval}
                          onChange={handleBroadcastChange}
                        />
                        <span className="visibility-label">Intervalo</span>
                        <span className="visibility-toggle"></span>
                      </label>
                      <label className={`visibility-card ${broadcastSettings.broadcast_show_timer ? 'active' : ''}`}>
                        <input
                          type="checkbox"
                          name="broadcast_show_timer"
                          checked={broadcastSettings.broadcast_show_timer}
                          onChange={handleBroadcastChange}
                        />
                        <span className="visibility-label">Timer</span>
                        <span className="visibility-toggle"></span>
                      </label>
                      <label className={`visibility-card ${broadcastSettings.broadcast_show_blinds ? 'active' : ''}`}>
                        <input
                          type="checkbox"
                          name="broadcast_show_blinds"
                          checked={broadcastSettings.broadcast_show_blinds}
                          onChange={handleBroadcastChange}
                        />
                        <span className="visibility-label">Blinds</span>
                        <span className="visibility-toggle"></span>
                      </label>
                      <label className={`visibility-card ${broadcastSettings.broadcast_show_ante ? 'active' : ''}`}>
                        <input
                          type="checkbox"
                          name="broadcast_show_ante"
                          checked={broadcastSettings.broadcast_show_ante}
                          onChange={handleBroadcastChange}
                        />
                        <span className="visibility-label">Ante</span>
                        <span className="visibility-toggle"></span>
                      </label>
                      <label className={`visibility-card ${broadcastSettings.broadcast_show_next_blind ? 'active' : ''}`}>
                        <input
                          type="checkbox"
                          name="broadcast_show_next_blind"
                          checked={broadcastSettings.broadcast_show_next_blind}
                          onChange={handleBroadcastChange}
                        />
                        <span className="visibility-label">Próx. Blind</span>
                        <span className="visibility-toggle"></span>
                      </label>
                      <label className={`visibility-card ${broadcastSettings.broadcast_show_prizes ? 'active' : ''}`}>
                        <input
                          type="checkbox"
                          name="broadcast_show_prizes"
                          checked={broadcastSettings.broadcast_show_prizes}
                          onChange={handleBroadcastChange}
                        />
                        <span className="visibility-label">Premiações</span>
                        <span className="visibility-toggle"></span>
                      </label>
                    </div>
                  </div>
                </div>

                <div className="modal-actions">
                  <Button type="button" variant="secondary" onClick={() => setShowEditModal(false)}>
                    Cancelar
                  </Button>
                  <Button type="submit">
                    Salvar Alterações
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

export default Torneios;
