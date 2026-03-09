import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
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
  const [formData, setFormData] = useState({ name: '', has_qualifying: false });

  useEffect(() => {
    loadTournaments();
    const interval = setInterval(loadTournaments, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadTournaments = async () => {
    try {
      const res = await api.get('/tournaments');
      setTournaments(res.data);
    } catch (err) {
      console.error('Erro ao carregar torneios:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      await api.post('/tournaments', { name: formData.name, has_qualifying: formData.has_qualifying });
      setShowModal(false);
      setFormData({ name: '', has_qualifying: false });
      loadTournaments();
    } catch (err) {
      const detail = err.response?.data?.detail;
      let msg = 'Erro ao criar torneio.';
      if (typeof detail === 'string') msg = detail;
      else if (Array.isArray(detail)) msg = detail.map(e => e.msg).join('\n');
      toast.error(msg);
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
    } catch {
      toast.error('Erro ao atualizar torneio');
    }
  };

  const handleChange = (e) =>
    setFormData({ ...formData, [e.target.name]: e.target.value });

  const openEditModal = (tournament) => {
    setEditingTournament(tournament);
    setFormData({ name: tournament.name, has_qualifying: tournament.has_qualifying || false });
    setShowEditModal(true);
  };

  const handleDelete = async (id) => {
    const ok = await confirm('Tem certeza que deseja excluir este torneio?', {
      variant: 'danger', confirmText: 'Excluir',
    });
    if (!ok) return;
    try {
      await api.delete(`/tournaments/${id}`);
      loadTournaments();
    } catch {
      toast.error('Erro ao excluir torneio');
    }
  };

  const openNewModal = () => {
    setFormData({ name: '', has_qualifying: false });
    setShowModal(true);
  };

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content">

        {/* ── Header ── */}
        <div className="tr-header">
          <div className="tr-header-left">
            <div className="tr-header-icon">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94.63 1.5 1.98 2.63 3.61 2.96V17H7v2h10v-2h-4v-1.1c1.63-.33 2.98-1.46 3.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z"/>
              </svg>
            </div>
            <div>
              <h1 className="tr-title">Torneios</h1>
              <p className="tr-subtitle">Gerencie e acompanhe seus torneios</p>
            </div>
          </div>
          <button className="tr-btn-new" onClick={openNewModal}>
            <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
              <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
            </svg>
            Novo Torneio
          </button>
        </div>

        {/* ── Body ── */}
        {loading ? (
          <div className="tr-loading">Carregando torneios...</div>
        ) : tournaments.length === 0 ? (
          <div className="tr-empty">
            <div className="tr-empty-icon">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94.63 1.5 1.98 2.63 3.61 2.96V17H7v2h10v-2h-4v-1.1c1.63-.33 2.98-1.46 3.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z"/>
              </svg>
            </div>
            <h3>Nenhum torneio criado</h3>
            <p>Comece criando o seu primeiro torneio</p>
            <button className="tr-btn-new" onClick={openNewModal}>
              <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
              </svg>
              Criar Torneio
            </button>
          </div>
        ) : (
          <>
            <div className="tr-count-bar">
              <span><strong>{tournaments.length}</strong> torneio{tournaments.length !== 1 ? 's' : ''}</span>
            </div>
            <div className="tr-grid">
              {tournaments.map((t) => {
                const entries = t.total_entries || 0;
                return (
                  <div key={t.id} className="tr-card" onClick={() => navigate(`/torneios/${t.id}`)}>
                    <div className="tr-card-accent" />

                    <div className="tr-card-body">
                      <div className="tr-card-icon">
                        <svg viewBox="0 0 24 24" fill="currentColor">
                          <path d="M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94.63 1.5 1.98 2.63 3.61 2.96V17H7v2h10v-2h-4v-1.1c1.63-.33 2.98-1.46 3.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z"/>
                        </svg>
                      </div>
                      <div className="tr-card-info">
                        <div className="tr-card-name">{t.name}</div>
                        {t.has_qualifying && (
                          <span className="tr-badge-qualifying">Com Classificatórias</span>
                        )}
                      </div>
                    </div>

                    <div className="tr-card-stats">
                      <div className="tr-stat">
                        <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
                          <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
                        </svg>
                        <span><strong>{entries}</strong> entrada{entries !== 1 ? 's' : ''}</span>
                      </div>
                    </div>

                    <div className="tr-card-footer" onClick={(e) => e.stopPropagation()}>
                      <button
                        className="tr-btn-edit"
                        onClick={(e) => { e.stopPropagation(); openEditModal(t); }}
                      >
                        <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13">
                          <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
                        </svg>
                        Editar
                      </button>
                      <button
                        className="tr-btn-delete"
                        onClick={(e) => { e.stopPropagation(); handleDelete(t.id); }}
                      >
                        <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13">
                          <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
                        </svg>
                        Excluir
                      </button>
                      <span className="tr-card-cta">
                        Ver detalhes
                        <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
                          <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z"/>
                        </svg>
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* ── Create Modal ── */}
        {showModal && (
          <TournamentModal
            title="Novo Torneio"
            formData={formData}
            onChange={handleChange}
            onToggleQualifying={() => setFormData({ ...formData, has_qualifying: !formData.has_qualifying })}
            onSubmit={handleSubmit}
            onClose={() => setShowModal(false)}
            submitLabel="Criar Torneio"
          />
        )}

        {/* ── Edit Modal ── */}
        {showEditModal && (
          <TournamentModal
            title="Editar Torneio"
            formData={formData}
            onChange={handleChange}
            onToggleQualifying={() => setFormData({ ...formData, has_qualifying: !formData.has_qualifying })}
            onSubmit={handleEditSubmit}
            onClose={() => setShowEditModal(false)}
            submitLabel="Salvar Alterações"
          />
        )}

      </main>
    </div>
  );
};

/* ── Shared Modal ── */
const TournamentModal = ({ title, formData, onChange, onToggleQualifying, onSubmit, onClose, submitLabel }) => (
  <div className="tr-modal-overlay" onClick={onClose}>
    <div className="tr-modal" onClick={(e) => e.stopPropagation()}>
      <div className="tr-modal-header">
        <div className="tr-modal-title-group">
          <div className="tr-modal-icon">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94.63 1.5 1.98 2.63 3.61 2.96V17H7v2h10v-2h-4v-1.1c1.63-.33 2.98-1.46 3.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z"/>
            </svg>
          </div>
          <h2>{title}</h2>
        </div>
        <button className="tr-modal-close" onClick={onClose}>
          <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
          </svg>
        </button>
      </div>

      <form onSubmit={onSubmit} className="tr-modal-form">
        <div className="tr-field">
          <label htmlFor="tr-name">
            Nome do Torneio <span className="tr-required">*</span>
          </label>
          <input
            id="tr-name"
            name="name"
            type="text"
            value={formData.name}
            onChange={onChange}
            required
            placeholder="Ex: Main Event, Torneio de Sexta..."
            autoFocus
          />
          <small>Após criar o torneio, você poderá adicionar dias e configurações.</small>
        </div>

        <div
          className={`tr-toggle-card ${formData.has_qualifying ? 'active' : ''}`}
          onClick={onToggleQualifying}
        >
          <div className="tr-toggle-text">
            <span className="tr-toggle-title">Com Dias Classificatórios</span>
            <span className="tr-toggle-hint">Torneio multi-day com classificatória + final</span>
          </div>
          <div className={`tr-toggle-switch ${formData.has_qualifying ? 'on' : ''}`}>
            <div className="tr-toggle-knob" />
          </div>
        </div>

        <div className="tr-modal-footer">
          <button type="button" className="tr-btn-cancel" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="tr-btn-submit">
            <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
              <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
            </svg>
            {submitLabel}
          </button>
        </div>
      </form>
    </div>
  </div>
);

export default Torneios;
