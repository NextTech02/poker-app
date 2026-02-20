import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import Button from '../components/Button';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import './Torneios.css';

const Torneios = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { toast, confirm } = useToast();
  const [tournaments, setTournaments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingTournament, setEditingTournament] = useState(null);
  const [formData, setFormData] = useState({
    name: '',
    has_qualifying: false,
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
        has_qualifying: formData.has_qualifying,
      };

      await api.post('/tournaments', tournamentData);

      setShowModal(false);
      setFormData({ name: '', has_qualifying: false });
      loadTournaments();
    } catch (error) {
      console.error('Erro ao criar torneio:', error);
      const detail = error.response?.data?.detail;
      let errorMessage = 'Erro ao criar torneio. Verifique os dados e tente novamente.';
      if (detail) {
        if (typeof detail === 'string') {
          errorMessage = detail;
        } else if (Array.isArray(detail)) {
          errorMessage = detail.map(e => `${e.loc?.join('.') || ''}: ${e.msg || JSON.stringify(e)}`).join('\n');
        } else {
          errorMessage = JSON.stringify(detail);
        }
      }
      toast.error(errorMessage);
    }
  };

  const handleEditSubmit = async (e) => {
    e.preventDefault();
    try {
      await api.patch(`/tournaments/${editingTournament.id}`, {
        name: formData.name,
        has_qualifying: formData.has_qualifying,
      });

      setShowEditModal(false);
      setEditingTournament(null);
      setFormData({ name: '', has_qualifying: false });
      loadTournaments();
    } catch (error) {
      console.error('Erro ao atualizar torneio:', error);
      toast.error('Erro ao atualizar torneio');
    }
  };

  const handleChange = (e) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value,
    });
  };

  const openEditModal = (tournament) => {
    setEditingTournament(tournament);
    setFormData({
      name: tournament.name,
      has_qualifying: tournament.has_qualifying || false,
    });
    setShowEditModal(true);
  };

  const handleDeleteTournament = async (tournamentId) => {
    const ok = await confirm('Tem certeza que deseja excluir este torneio?', { variant: 'danger', confirmText: 'Excluir' });
    if (!ok) return;

    try {
      await api.delete(`/tournaments/${tournamentId}`);
      loadTournaments();
    } catch (error) {
      console.error('Erro ao excluir torneio:', error);
      toast.error('Erro ao excluir torneio');
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
          <Button onClick={() => setShowModal(true)}>
            {t('tournaments.newTournament')}
          </Button>
        </div>

        {tournaments.length === 0 ? (
          <Card>
            <div className="empty-state">
              <p>{t('tournaments.noTournaments')}</p>
              <Button onClick={() => setShowModal(true)}>
                {t('tournaments.createFirst')}
              </Button>
            </div>
          </Card>
        ) : (
          <Card>
            {/* Desktop Table View */}
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
                            {t('common.edit')}
                          </Button>
                          <Button
                            size="small"
                            variant="danger"
                            onClick={() => handleDeleteTournament(tournament.id)}
                          >
                            {t('common.delete')}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile Card View */}
            <div className="tournaments-cards-mobile">
              {tournaments.map((tournament) => (
                <div
                  key={tournament.id}
                  className="tournament-card-mobile"
                  onClick={() => navigate(`/torneios/${tournament.id}`)}
                >
                  <div className="tournament-card-mobile-header">
                    <h3 className="tournament-card-mobile-name">{tournament.name}</h3>
                    <span className="tournament-card-mobile-entries">
                      <strong>{getTournamentEntries(tournament)}</strong> entradas
                    </span>
                  </div>
                  <div className="tournament-card-mobile-actions" onClick={(e) => e.stopPropagation()}>
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
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* Create Modal */}
        {showModal && (
          <div className="modal-overlay" onClick={() => setShowModal(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>{t('tournaments.newTournament')}</h2>
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

                <div className={`qualifying-toggle-card ${formData.has_qualifying ? 'active' : ''}`}
                  onClick={() => setFormData({ ...formData, has_qualifying: !formData.has_qualifying })}>
                  <div className="qualifying-toggle-content">
                    <div className="qualifying-toggle-text">
                      <span className="qualifying-toggle-title">{t('tournaments.hasQualifying')}</span>
                      <span className="qualifying-toggle-hint">{t('tournaments.hasQualifyingHint')}</span>
                    </div>
                  </div>
                  <div className={`toggle-switch ${formData.has_qualifying ? 'on' : ''}`}>
                    <div className="toggle-knob" />
                  </div>
                </div>

                <div className="modal-actions">
                  <Button type="button" variant="secondary" onClick={() => setShowModal(false)}>
                    {t('common.cancel')}
                  </Button>
                  <Button type="submit">
                    {t('tournaments.newTournament')}
                  </Button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Edit Modal */}
        {showEditModal && (
          <div className="modal-overlay" onClick={() => setShowEditModal(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>{t('tournaments.editTournament')}</h2>
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

                <div className={`qualifying-toggle-card ${formData.has_qualifying ? 'active' : ''}`}
                  onClick={() => setFormData({ ...formData, has_qualifying: !formData.has_qualifying })}>
                  <div className="qualifying-toggle-content">
                    <div className="qualifying-toggle-text">
                      <span className="qualifying-toggle-title">{t('tournaments.hasQualifying')}</span>
                      <span className="qualifying-toggle-hint">{t('tournaments.hasQualifyingHint')}</span>
                    </div>
                  </div>
                  <div className={`toggle-switch ${formData.has_qualifying ? 'on' : ''}`}>
                    <div className="toggle-knob" />
                  </div>
                </div>

                <div className="modal-actions">
                  <Button type="button" variant="secondary" onClick={() => setShowEditModal(false)}>
                    {t('common.cancel')}
                  </Button>
                  <Button type="submit">
                    {t('common.save')}
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
