import React, { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import EmptyState from '../components/EmptyState';
import { SkeletonTournamentCard } from '../components/SkeletonLoader';
import api from '../config/api';
import { cachedGet, invalidateCache } from '../utils/apiCache';
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
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  useEffect(() => {
    loadTournaments();
    const interval = setInterval(loadTournaments, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadTournaments = async () => {
    try {
      // B3: cache de 30s — navegar para cá e voltar não re-fetcha
      const data = await cachedGet(api, '/tournaments', 30000);
      setTournaments(data);
    } catch (err) {
      console.error('Erro ao carregar torneios:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setFormError('');
    setSubmitting(true);
    try {
      await api.post('/tournaments', { name: formData.name, has_qualifying: formData.has_qualifying });
      toast.success('Torneio criado com sucesso!');
      invalidateCache('/tournaments'); // B3: invalida após mutação
      setShowModal(false);
      setFormData({ name: '', has_qualifying: false });
      loadTournaments();
    } catch (err) {
      const detail = err.userMessage || err.response?.data?.detail;
      const msg = typeof detail === 'string'
        ? detail
        : Array.isArray(detail)
          ? detail.map(d => d.msg).join(' | ')
          : 'Erro ao criar torneio.';
      setFormError(msg); // A7: erro inline dentro do modal
    } finally {
      setSubmitting(false);
    }
  };

  const handleEditSubmit = async (e) => {
    e.preventDefault();
    setFormError('');
    setSubmitting(true);
    try {
      await api.patch(`/tournaments/${editingTournament.id}`, {
        name: formData.name,
        has_qualifying: formData.has_qualifying,
      });
      toast.success('Torneio atualizado com sucesso!');
      invalidateCache('/tournaments'); // B3
      setShowEditModal(false);
      setEditingTournament(null);
      setFormData({ name: '', has_qualifying: false });
      loadTournaments();
    } catch (err) {
      const msg = err.userMessage || 'Erro ao atualizar torneio';
      setFormError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleChange = (e) =>
    setFormData({ ...formData, [e.target.name]: e.target.value });

  const openEditModal = (tournament) => {
    setEditingTournament(tournament);
    setFormData({ name: tournament.name, has_qualifying: tournament.has_qualifying || false });
    setFormError('');
    setShowEditModal(true);
  };

  const handleDelete = async (id) => {
    const ok = await confirm('Tem certeza que deseja excluir este torneio?', {
      variant: 'danger', confirmText: 'Excluir',
    });
    if (!ok) return;
    try {
      await api.delete(`/tournaments/${id}`);
      invalidateCache('/tournaments'); // B3
      loadTournaments();
    } catch {
      toast.error('Erro ao excluir torneio');
    }
  };

  // A5 + A2.2: Status badge com normalização de casing e fallback para pending
  const getStatusBadge = (status) => {
    const normalized = (status || 'pending').toLowerCase();
    const map = {
      active:    { label: t('tournaments.statusActive',    'Ativo'),    cls: 'tr-status--active'    },
      pending:   { label: t('tournaments.statusPending',   'Pendente'), cls: 'tr-status--pending'   },
      completed: { label: t('tournaments.statusCompleted', 'Concluído'),cls: 'tr-status--done'      },
      cancelled: { label: t('tournaments.statusCancelled', 'Cancelado'),cls: 'tr-status--cancelled' },
    };
    const s = map[normalized] || map.pending; // fallback para pending se valor desconhecido
    return <span className={`tr-status-badge ${s.cls}`}>{s.label}</span>;
  };

  const openNewModal = () => {
    setFormData({ name: '', has_qualifying: false });
    setFormError('');
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
              <h1 className="tr-title">{t('tournaments.title')}</h1>
              <p className="tr-subtitle">{t('tournaments.subtitle')}</p>
            </div>
          </div>
          <button className="tr-btn-new" onClick={openNewModal}>
            <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
              <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
            </svg>
            {t('tournaments.newTournament')}
          </button>
        </div>

        {/* ── Body ── */}
        {loading ? (
          /* B1: Skeleton screens em vez de texto "Carregando..." */
          <div className="tr-grid">
            <SkeletonTournamentCard />
            <SkeletonTournamentCard />
            <SkeletonTournamentCard />
          </div>
        ) : tournaments.length === 0 ? (
          /* A2: EmptyState unificado */
          <EmptyState
            icon={
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94.63 1.5 1.98 2.63 3.61 2.96V17H7v2h10v-2h-4v-1.1c1.63-.33 2.98-1.46 3.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z"/>
              </svg>
            }
            title={t('tournaments.noTournaments')}
            subtitle={t('tournaments.noTournamentsHint')}
            ctaLabel={t('tournaments.createFirst')}
            onCta={openNewModal}
          />
        ) : (
          <>
            <div className="tr-count-bar">
              <span>
                <strong>{tournaments.length}</strong>{' '}
                {tournaments.length === 1 ? t('tournaments.count', 'torneio') : t('tournaments.countPlural', 'torneios')}
              </span>
            </div>
            <div className="tr-grid">
              {tournaments.map((tournament) => {
                const entries = tournament.total_entries || 0;
                return (
                  <div key={tournament.id} className="tr-card" onClick={() => navigate(`/torneios/${tournament.id}`)}>
                    <div className="tr-card-accent" />

                    <div className="tr-card-body">
                      <div className="tr-card-icon">
                        <svg viewBox="0 0 24 24" fill="currentColor">
                          <path d="M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94.63 1.5 1.98 2.63 3.61 2.96V17H7v2h10v-2h-4v-1.1c1.63-.33 2.98-1.46 3.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z"/>
                        </svg>
                      </div>
                      <div className="tr-card-info">
                        <div className="tr-card-name">{tournament.name}</div>
                        <div className="tr-card-badges">
                          {getStatusBadge(tournament.status)}
                          {tournament.has_qualifying && (
                            <span className="tr-badge-qualifying">{t('tournaments.hasQualifying', 'Com Classificatórias')}</span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="tr-card-stats">
                      <div className="tr-stat">
                        <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
                          <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
                        </svg>
                        <span>
                          <strong>{entries}</strong>{' '}
                          {entries === 1 ? t('tournaments.entries', 'entrada') : t('tournaments.entriesPlural', 'entradas')}
                        </span>
                      </div>
                    </div>

                    <div className="tr-card-footer" onClick={(e) => e.stopPropagation()}>
                      <button
                        className="tr-btn-edit"
                        onClick={(e) => { e.stopPropagation(); openEditModal(tournament); }}
                      >
                        <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13">
                          <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
                        </svg>
                        {t('common.edit', 'Editar')}
                      </button>
                      <button
                        className="tr-btn-delete"
                        onClick={(e) => { e.stopPropagation(); handleDelete(tournament.id); }}
                      >
                        <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13">
                          <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
                        </svg>
                        {t('common.delete', 'Excluir')}
                      </button>
                      <Link
                        to={`/torneios/${tournament.id}`}
                        className="tr-card-cta"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {t('tournaments.viewDetails', 'Ver detalhes')}
                        <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
                          <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z"/>
                        </svg>
                      </Link>
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
            title={t('tournaments.newTournament')}
            formData={formData}
            onChange={handleChange}
            onToggleQualifying={() => setFormData({ ...formData, has_qualifying: !formData.has_qualifying })}
            onSubmit={handleSubmit}
            onClose={() => { setShowModal(false); setFormError(''); }}
            submitLabel={t('tournaments.createFirst')}
            submitting={submitting}
            formError={formError}
            t={t}
          />
        )}

        {/* ── Edit Modal ── */}
        {showEditModal && (
          <TournamentModal
            title={t('tournaments.editTitle')}
            formData={formData}
            onChange={handleChange}
            onToggleQualifying={() => setFormData({ ...formData, has_qualifying: !formData.has_qualifying })}
            onSubmit={handleEditSubmit}
            onClose={() => { setShowEditModal(false); setFormError(''); }}
            submitLabel={t('tournaments.saveChanges')}
            submitting={submitting}
            formError={formError}
            t={t}
            isEditing
          />
        )}

      </main>
    </div>
  );
};

/* ── Shared Modal — A7: inline error + loading state ── */
const TournamentModal = ({ title, formData, onChange, onToggleQualifying, onSubmit, onClose, submitLabel, submitting, formError, t, isEditing }) => (
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
        <button className="tr-modal-close" onClick={onClose} disabled={submitting}>
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
            disabled={submitting}
          />
          {!isEditing && <small>Após criar o torneio, você poderá adicionar dias e configurações.</small>}
        </div>

        <div
          className={`tr-toggle-card ${formData.has_qualifying ? 'active' : ''}`}
          onClick={submitting ? undefined : onToggleQualifying}
        >
          <div className="tr-toggle-text">
            <span className="tr-toggle-title">{t ? t('tournaments.qualifyingToggle') : 'Com Dias Classificatórios'}</span>
            <span className="tr-toggle-hint">{t ? t('tournaments.qualifyingToggleHint') : 'Torneio multi-day com classificatória + final'}</span>
          </div>
          <div className={`tr-toggle-switch ${formData.has_qualifying ? 'on' : ''}`}>
            <div className="tr-toggle-knob" />
          </div>
        </div>

        {/* A7: Erro de API inline, acima dos botões */}
        {formError && (
          <div className="tr-form-error">
            <svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
            </svg>
            {formError}
          </div>
        )}

        <div className="tr-modal-footer">
          <button type="button" className="tr-btn-cancel" onClick={onClose} disabled={submitting}>
            Cancelar
          </button>
          {/* A7: Botão com spinner durante submit */}
          <button type="submit" className="tr-btn-submit" disabled={submitting}>
            {submitting ? (
              <>
                <svg className="tr-spinner" viewBox="0 0 24 24" fill="none" width="16" height="16">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="30 70" />
                </svg>
                Salvando...
              </>
            ) : (
              <>
                <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                  <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                </svg>
                {submitLabel}
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  </div>
);

export default Torneios;
