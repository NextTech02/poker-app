import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import Icon from '../components/Icon';
import EmptyState from '../components/EmptyState';
import { SkeletonTournamentCard } from '../components/SkeletonLoader';
import api from '../config/api';
import { getSelectedStage } from '../utils/stageUtils';
import { cachedGet, invalidateCache } from '../utils/apiCache';
import { useToast } from '../contexts/ToastContext';
import { useStage } from '../contexts/StageContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { currencySymbol } from '../utils/currencyUtils';
import { usePolling } from '../hooks/usePolling';
import { useEscapeKey } from '../hooks/useEscapeKey';
import './Torneios.css';

const Torneios = () => {
  const { t } = useTranslation();
  const { toast, confirm } = useToast();
  const { selectedStage } = useStage();
  const { currency, formatCurrency } = useCurrency();
  const hasStage = !!selectedStage?.id;

  const [tournaments, setTournaments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingTournament, setEditingTournament] = useState(null);
  const [formData, setFormData] = useState({ name: '', has_qualifying: false, sponsor_id: '', qualifying_days: 2, qualifying_buy_in: '', qualifying_rebuy: '', qualifying_addon: '', qualifying_currency: 'BRL', qualifying_max_players: 100, qualifying_starting_chips: 10000, qualifying_rebuy_chips: 10000, qualifying_addon_chips: 10000, qualifying_rebuy_level_limit: '', blind_template_id: '' });
  const [sponsors, setSponsors] = useState([]);
  const [blindTemplates, setBlindTemplates] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  useEffect(() => {
    loadTournaments();
    loadSponsors();
    loadBlindTemplates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Polling que pausa quando a aba está oculta (reduz carga em produção).
  usePolling(() => loadTournaments(), 5000);

  const loadSponsors = async () => {
    try {
      const data = await cachedGet(api, '/sponsors?status=active', 60000);
      setSponsors(data || []);
    } catch (err) {
      console.error('Erro ao carregar patrocinadores:', err);
    }
  };

  const loadBlindTemplates = async () => {
    try {
      const data = await cachedGet(api, '/blind-templates', 60000);
      setBlindTemplates(data || []);
    } catch (err) {
      console.error('Erro ao carregar templates de blind:', err);
    }
  };

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

    // Bloqueio: um torneio precisa estar vinculado a uma etapa. O vínculo é
    // enviado via header X-Stage-ID (a partir da etapa selecionada). Sem etapa
    // selecionada, nem chega a chamar a API.
    const selectedStage = getSelectedStage();
    if (!selectedStage?.id) {
      setFormError(t('tournaments.selectStageFirst'));
      return;
    }

    setSubmitting(true);
    try {
      const res = await api.post('/tournaments', {
        name: formData.name,
        has_qualifying: formData.has_qualifying,
        sponsor_id: formData.sponsor_id || null,
      });
      const newTournamentId = res?.data?.id;

      // Qualifying tournaments: auto-generate the whole structure — one final day
      // plus N qualifying days, each already linked to the final via
      // qualifies_to_day_id — so the operator doesn't create them day by day.
      if (formData.has_qualifying && newTournamentId) {
        const qCount = Math.max(1, parseInt(formData.qualifying_days, 10) || 1);
        const qBuyIn = parseFloat(formData.qualifying_buy_in) || 0;
        try {
          const finalRes = await api.post('/tournament-days', {
            tournament_id: newTournamentId,
            day_name: 'Dia Final',
            day_number: qCount + 1,
            day_type: 'final',
            buy_in: 0,
            max_players: 1000,
            starting_chips: 0,
            rake_percentage: 0,
          });
          const finalDayId = finalRes?.data?.id || null;
          const qualifyingDayIds = [];
          for (let i = 1; i <= qCount; i++) {
            const dayRes = await api.post('/tournament-days', {
              tournament_id: newTournamentId,
              day_name: `Dia ${i}`,
              day_number: i,
              day_type: 'qualifying',
              qualifies_to_day_id: finalDayId,
              buy_in: qBuyIn,
              rebuy_amount: parseFloat(formData.qualifying_rebuy) || null,
              addon_amount: parseFloat(formData.qualifying_addon) || null,
              // Rake vem dos "Tipos de Buy" (fonte única) — 0 aqui.
              rake_percentage: 0,
              // Moeda segue o setting GLOBAL (Financeiro) — sem seleção por torneio.
              currency,
              max_players: parseInt(formData.qualifying_max_players, 10) || 100,
              starting_chips: parseInt(formData.qualifying_starting_chips, 10) || 10000,
              rebuy_chips: parseInt(formData.qualifying_rebuy_chips, 10) || 10000,
              addon_chips: parseInt(formData.qualifying_addon_chips, 10) || 10000,
              rebuy_level_limit: formData.qualifying_rebuy_level_limit
                ? parseInt(formData.qualifying_rebuy_level_limit, 10)
                : null,
            });
            if (dayRes?.data?.id) qualifyingDayIds.push(dayRes.data.id);
          }

          // Aplica o template de blinds escolhido a TODOS os dias classificatórios
          // de uma só vez (o Dia Final fica em branco para ser configurado à parte).
          if (formData.blind_template_id && qualifyingDayIds.length > 0) {
            try {
              await Promise.all(
                qualifyingDayIds.map((dayId) =>
                  api.post('/blind-templates/apply', {
                    template_id: formData.blind_template_id,
                    tournament_day_id: dayId,
                    clear_existing: true,
                  })
                )
              );
            } catch (blindErr) {
              toast.warning(t('tournaments.qualifyingBlindsPartial', 'Dias criados, mas não foi possível aplicar a estrutura de blinds. Aplique manualmente na tela de Blinds.'));
            }
          }
        } catch (genErr) {
          // Tournament created OK; only the day generation failed.
          toast.warning(t('tournaments.qualifyingDaysPartial', 'Torneio criado, mas houve erro ao gerar os dias classificatórios. Adicione-os manualmente.'));
        }
      }

      toast.success(t('tournaments.createdSuccess'));
      invalidateCache('/tournaments'); // B3: invalida após mutação
      setShowModal(false);
      setFormData({ name: '', has_qualifying: false, sponsor_id: '', qualifying_days: 2, qualifying_buy_in: '', qualifying_rebuy: '', qualifying_addon: '', qualifying_currency: 'BRL', qualifying_max_players: 100, qualifying_starting_chips: 10000, qualifying_rebuy_chips: 10000, qualifying_addon_chips: 10000, qualifying_rebuy_level_limit: '', blind_template_id: '' });
      loadTournaments();
    } catch (err) {
      const detail = err.userMessage || err.response?.data?.detail;
      const msg = typeof detail === 'string'
        ? detail
        : Array.isArray(detail)
          ? detail.map(d => d.msg).join(' | ')
          : t('tournaments.createError');
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
        sponsor_id: formData.sponsor_id || null,
      });
      toast.success(t('tournaments.updatedSuccess'));
      invalidateCache('/tournaments'); // B3
      setShowEditModal(false);
      setEditingTournament(null);
      setFormData({ name: '', has_qualifying: false, sponsor_id: '' });
      loadTournaments();
    } catch (err) {
      const msg = err.userMessage || t('tournaments.updateError');
      setFormError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleChange = (e) =>
    setFormData({ ...formData, [e.target.name]: e.target.value });

  const openEditModal = (tournament) => {
    setEditingTournament(tournament);
    setFormData({ name: tournament.name, has_qualifying: tournament.has_qualifying || false, sponsor_id: tournament.sponsor_id || '' });
    setFormError('');
    setShowEditModal(true);
  };

  // Texto da recusa: repete os NÚMEROS, porque é o tamanho do que está em jogo
  // que faz o operador entender por que o sistema não deixa apagar.
  const textoDoBloqueio = (impacto) =>
    t(
      'tournaments.deleteBlocked',
      'Este torneio não pode ser excluído: tem {{entries}} entrada(s) vendida(s) somando {{amount}}, {{players}} jogador(es) pago(s) e {{prizes}} pagamento(s) de premiação. Excluir apagaria a venda, o dinheiro recebido e o registro de quem pagou — e o caixa da etapa NÃO seria estornado. Cancele as vendas no Caixa (o estorno devolve o dinheiro e acerta o caixa) antes de excluir.',
      {
        entries: impacto.entries || 0,
        amount: formatCurrency(impacto.entries_amount || 0),
        players: impacto.paying_players || 0,
        prizes: impacto.prizes || 0,
      }
    );

  // Confirmação com números reais. Sem eles, "tem certeza?" não diz se o
  // torneio está vazio ou se leva junto o histórico de uma noite inteira.
  const textoDaConfirmacao = (nome, impacto) => {
    if (!impacto) return t('tournaments.confirmDelete');
    if (!impacto.days && !impacto.players && !impacto.cancelled_entries) {
      return t(
        'tournaments.confirmDeleteEmpty',
        'Excluir o torneio "{{name}}"? Ele não tem nenhum dia, inscrição ou venda registrada.',
        { name: nome }
      );
    }
    return t(
      'tournaments.confirmDeleteImpact',
      'Excluir o torneio "{{name}}"? Serão apagados em cascata: {{days}} dia(s), {{players}} inscrição(ões) e {{cancelled}} venda(s) já cancelada(s). Não há como desfazer.',
      {
        name: nome,
        days: impacto.days || 0,
        players: impacto.players || 0,
        cancelled: impacto.cancelled_entries || 0,
      }
    );
  };

  const handleDelete = async (id, nome) => {
    // Mede o estrago ANTES de perguntar. Apagar um torneio é ON DELETE CASCADE
    // em tudo: vendas, inscrições, dias, premiação e assentos somem junto — e o
    // caixa da etapa não é estornado, então o saldo passa a apontar dinheiro
    // sem origem e a etapa deixa de fechar.
    let impacto = null;
    try {
      const res = await api.get(`/tournaments/${id}/delete-impact`);
      impacto = res?.data || null;
    } catch {
      // Backend ainda sem o endpoint (o deploy não é atômico) ou rede caída:
      // seguimos com a confirmação genérica. Quem RECUSA de verdade é o
      // servidor — a tela só antecipa a informação.
      impacto = null;
    }

    if (impacto?.blocked) {
      toast.error(textoDoBloqueio(impacto), {
        title: t('tournaments.deleteBlockedTitle', 'Torneio com movimento financeiro'),
        duration: 14000,
      });
      return;
    }

    const ok = await confirm(textoDaConfirmacao(nome, impacto), {
      variant: 'danger', confirmText: t('common.delete'),
    });
    if (!ok) return;
    try {
      await api.delete(`/tournaments/${id}`);
      invalidateCache('/tournaments'); // B3
      loadTournaments();
    } catch (err) {
      // 409 = o servidor recusou por movimento financeiro. Pode acontecer mesmo
      // depois de um impacto liberado: outro operador vendeu no meio do caminho.
      if (err?.response?.status === 409) {
        const impactoDaRecusa = err.response?.data?.detail?.impact;
        toast.error(
          impactoDaRecusa ? textoDoBloqueio(impactoDaRecusa) : err.userMessage,
          { title: t('tournaments.deleteBlockedTitle', 'Torneio com movimento financeiro'), duration: 14000 }
        );
        return;
      }
      toast.error(t('tournaments.deleteError'));
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
    setFormData({ name: '', has_qualifying: false, sponsor_id: '', qualifying_days: 2, qualifying_buy_in: '', qualifying_rebuy: '', qualifying_addon: '', qualifying_currency: 'BRL', qualifying_max_players: 100, qualifying_starting_chips: 10000, qualifying_rebuy_chips: 10000, qualifying_addon_chips: 10000, qualifying_rebuy_level_limit: '', blind_template_id: '' });
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
              <Icon name="trophy" />
            </div>
            <div>
              <h1 className="tr-title">{t('tournaments.title')}</h1>
              <p className="tr-subtitle">{t('tournaments.subtitle')}</p>
            </div>
          </div>
          <button
            type="button"
            className="tr-btn-new"
            onClick={openNewModal}
            disabled={!hasStage}
            title={!hasStage ? t('tournaments.selectStageFirst', 'Selecione uma etapa antes de criar um torneio.') : undefined}
          >
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
                // O card inteiro continua clicável pelo link "Ver detalhes" esticado sobre ele
                // (ver .tr-card-cta::after no CSS); assim o teclado alcança a navegação pelo
                // próprio link, em vez de uma <div> com onClick que o Tab nunca visita.
                return (
                  <div key={tournament.id} className="tr-card">
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

                    <div className="tr-card-footer">
                      <button
                        type="button"
                        className="tr-btn-edit"
                        onClick={() => openEditModal(tournament)}
                      >
                        <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13">
                          <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
                        </svg>
                        {t('common.edit', 'Editar')}
                      </button>
                      <button
                        type="button"
                        className="tr-btn-delete"
                        onClick={() => handleDelete(tournament.id, tournament.name)}
                      >
                        <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13">
                          <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
                        </svg>
                        {t('common.delete', 'Excluir')}
                      </button>
                      <Link
                        to={`/relatorios/torneio/${tournament.id}`}
                        className="tr-btn-edit"
                      >
                        <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13">
                          <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z"/>
                        </svg>
                        {t('tournaments.report')}
                      </Link>
                      <Link
                        to={`/torneios/${tournament.id}`}
                        className="tr-card-cta"
                        aria-label={`${t('tournaments.viewDetails', 'Ver detalhes')} — ${tournament.name}`}
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
            sponsors={sponsors}
            blindTemplates={blindTemplates}
            currency={currency}
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
            sponsors={sponsors}
            currency={currency}
            t={t}
            isEditing
          />
        )}

      </main>
    </div>
  );
};

/* ── Shared Modal — A7: inline error + loading state ── */
const TournamentModal = ({ title, formData, onChange, onToggleQualifying, onSubmit, onClose, submitLabel, submitting, formError, sponsors = [], blindTemplates = [], currency, t, isEditing }) => {
  // O backdrop fecha no clique (mouse); no teclado o equivalente é o Esc.
  useEscapeKey(!submitting, onClose);

  return (
  <div
    className="tr-modal-overlay"
    role="presentation"
    onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
  >
    <div className="tr-modal" role="dialog" aria-modal="true" aria-label={title}>
      <div className="tr-modal-header">
        <div className="tr-modal-title-group">
          <div className="tr-modal-icon">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94.63 1.5 1.98 2.63 3.61 2.96V17H7v2h10v-2h-4v-1.1c1.63-.33 2.98-1.46 3.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z"/>
            </svg>
          </div>
          <h2>{title}</h2>
        </div>
        <button type="button" className="tr-modal-close" onClick={onClose} disabled={submitting} aria-label={t('common.close', 'Fechar')}>
          <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
          </svg>
        </button>
      </div>

      <form onSubmit={onSubmit} className="tr-modal-form">
        <div className="tr-field">
          <label htmlFor="tr-name">
            {t('tournaments.tournamentName')} <span className="tr-required">*</span>
          </label>
          <input
            id="tr-name"
            name="name"
            type="text"
            value={formData.name}
            onChange={onChange}
            required
            placeholder={t('tournaments.namePlaceholder')}
            autoFocus
            disabled={submitting}
          />
          {!isEditing && <small>{t('tournaments.nameHint')}</small>}
        </div>

        <div className="tr-field">
          <label htmlFor="tr-sponsor">{t('tournaments.sponsor')}</label>
          <select
            id="tr-sponsor"
            name="sponsor_id"
            value={formData.sponsor_id || ''}
            onChange={onChange}
            disabled={submitting}
          >
            <option value="">{t('tournaments.noSponsor')}</option>
            {sponsors.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={!!formData.has_qualifying}
          disabled={submitting}
          className={`tr-toggle-card ${formData.has_qualifying ? 'active' : ''}`}
          onClick={onToggleQualifying}
        >
          <div className="tr-toggle-text">
            <span className="tr-toggle-title">{t ? t('tournaments.qualifyingToggle') : 'Com Dias Classificatórios'}</span>
            <span className="tr-toggle-hint">{t ? t('tournaments.qualifyingToggleHint') : 'Torneio multi-day com classificatória + final'}</span>
          </div>
          <div className={`tr-toggle-switch ${formData.has_qualifying ? 'on' : ''}`}>
            <div className="tr-toggle-knob" />
          </div>
        </button>

        {!isEditing && formData.has_qualifying && (
          <>
            <div className="tr-field">
              <label htmlFor="tr-qdays">{t('tournaments.qualifyingDaysCount', 'Dias classificatórios')}</label>
              <input
                id="tr-qdays"
                name="qualifying_days"
                type="number"
                min="1"
                max="20"
                step="1"
                value={formData.qualifying_days}
                onChange={onChange}
                disabled={submitting}
              />
              <small>{t('tournaments.qualifyingDaysHint', 'Criaremos esses dias classificatórios + 1 dia final, já vinculados. Edite a configuração de cada um depois.')}</small>
            </div>
            <div className="tr-field">
              <label htmlFor="tr-qbuyin">{t('tournaments.qualifyingBuyIn', 'Buy-in por dia classificatório')} ({currencySymbol(currency)})</label>
              <input
                id="tr-qbuyin"
                name="qualifying_buy_in"
                type="number"
                min="0"
                step="0.01"
                value={formData.qualifying_buy_in}
                onChange={onChange}
                disabled={submitting}
                placeholder="0,00"
              />
            </div>

            <div className="tr-qual-section-label">{t('tournaments.qualifyingValuesLabel', 'Valores aplicados a todos os dias classificatórios')}</div>
            <div className="tr-qual-grid">
              <div className="tr-field">
                <label htmlFor="tr-qrebuy">{t('tournaments.rebuy', 'Rebuy')} ({currencySymbol(currency)})</label>
                <input id="tr-qrebuy" name="qualifying_rebuy" type="number" min="0" step="0.01"
                  value={formData.qualifying_rebuy} onChange={onChange} disabled={submitting} placeholder="0,00" />
              </div>
              <div className="tr-field">
                <label htmlFor="tr-qaddon">{t('tournaments.addon', 'Add-on')} ({currencySymbol(currency)})</label>
                <input id="tr-qaddon" name="qualifying_addon" type="number" min="0" step="0.01"
                  value={formData.qualifying_addon} onChange={onChange} disabled={submitting} placeholder="0,00" />
              </div>
              <div className="tr-field">
                <label htmlFor="tr-qmax">{t('tournaments.maxPlayers', 'Máximo de jogadores')}</label>
                <input id="tr-qmax" name="qualifying_max_players" type="number" min="1"
                  value={formData.qualifying_max_players} onChange={onChange} disabled={submitting} />
              </div>
              <div className="tr-field">
                <label htmlFor="tr-qchips">{t('tournaments.startingChips', 'Fichas iniciais')}</label>
                <input id="tr-qchips" name="qualifying_starting_chips" type="number" min="1"
                  value={formData.qualifying_starting_chips} onChange={onChange} disabled={submitting} />
              </div>
              <div className="tr-field">
                <label htmlFor="tr-qrchips">{t('tournamentDayForm.rebuyChips', 'Fichas do rebuy')}</label>
                <input id="tr-qrchips" name="qualifying_rebuy_chips" type="number" min="0"
                  value={formData.qualifying_rebuy_chips} onChange={onChange} disabled={submitting} />
              </div>
              <div className="tr-field">
                <label htmlFor="tr-qachips">{t('tournamentDayForm.addonChips', 'Fichas do add-on')}</label>
                <input id="tr-qachips" name="qualifying_addon_chips" type="number" min="0"
                  value={formData.qualifying_addon_chips} onChange={onChange} disabled={submitting} />
              </div>
              <div className="tr-field">
                <label htmlFor="tr-qrlimit">{t('tournamentDayForm.rebuyLevelLimit', 'Nível limite de rebuy')}</label>
                <input id="tr-qrlimit" name="qualifying_rebuy_level_limit" type="number" min="1"
                  value={formData.qualifying_rebuy_level_limit} onChange={onChange} disabled={submitting}
                  placeholder={t('tournamentDayForm.leaveEmptyUnlimited', 'Deixe vazio para ilimitado')} />
              </div>
            </div>

            <div className="tr-field">
              <label htmlFor="tr-blind-template">{t('tournaments.qualifyingBlindTemplate', 'Estrutura de blinds')}</label>
              <select
                id="tr-blind-template"
                name="blind_template_id"
                value={formData.blind_template_id || ''}
                onChange={onChange}
                disabled={submitting}
              >
                <option value="">{t('tournaments.qualifyingBlindTemplateNone', 'Nenhuma (configurar depois)')}</option>
                {blindTemplates.map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
                ))}
              </select>
              <small>{t('tournaments.qualifyingBlindTemplateHint', 'A estrutura escolhida será aplicada a todos os dias classificatórios. O Dia Final fica em branco para configurar à parte.')}</small>
            </div>
          </>
        )}

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
            {t('common.cancel')}
          </button>
          {/* A7: Botão com spinner durante submit */}
          <button type="submit" className="tr-btn-submit" disabled={submitting}>
            {submitting ? (
              <>
                <svg className="tr-spinner" viewBox="0 0 24 24" fill="none" width="16" height="16">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="30 70" />
                </svg>
                {t('common.saving')}
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
};

export default Torneios;
