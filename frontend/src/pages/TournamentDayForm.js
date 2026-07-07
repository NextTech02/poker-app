import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import Button from '../components/Button';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import './TournamentDayForm.css';

const TournamentDayForm = () => {
  const { t } = useTranslation();
  const { tournamentId, dayId } = useParams(); // dayId comes from URL param when editing
  const navigate = useNavigate();

  const [tournament, setTournament] = useState(null);
  const [days, setDays] = useState([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const { toast } = useToast();

  const [formData, setFormData] = useState({
    day_name: '',
    day_number: 1,
    buy_in: 100,
    rebuy_amount: 100,
    addon_amount: 100,
    max_players: 100,
    // Rake não é mais configurado aqui — vem dos "Tipos de Buy" (fonte única).
    // 0 por padrão; sem tipo de buy selecionado no Caixa, o rake é 0.
    rake_percentage: 0,
    starting_chips: 10000,
    rebuy_chips: 10000,
    addon_chips: 10000,
    rebuy_level_limit: '',
    allocation_type: 'automatic',
    day_type: 'regular',
    qualifies_to_day_id: '',
    currency: 'BRL',
  });

  const isEditing = !!dayId;

  useEffect(() => {
    loadData();
  }, [tournamentId, dayId]);

  const loadData = async () => {
    try {
      setLoading(true);

      // Load tournament info
      const tournamentRes = await api.get(`/tournaments/${tournamentId}`);
      setTournament(tournamentRes.data);

      // Load all days for this tournament (for qualifies_to dropdown)
      const daysRes = await api.get(`/tournament-days/tournament/${tournamentId}`);
      setDays(daysRes.data);

      // If editing, load the day data
      if (dayId) {
        const dayRes = await api.get(`/tournament-days/${dayId}`);
        const day = dayRes.data;
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
          rebuy_level_limit: day.rebuy_level_limit || '',
          allocation_type: day.allocation_type,
          day_type: day.day_type || 'regular',
          qualifies_to_day_id: day.qualifies_to_day_id || '',
          currency: day.currency || 'BRL',
        });
      } else {
        // Novos dias adicionados manualmente são sempre 'regular' — os dias
        // classificatórios e o final são gerados automaticamente na criação do
        // torneio classificatório.
        setFormData(prev => ({
          ...prev,
          day_number: daysRes.data.length + 1,
          day_type: 'regular',
        }));
      }
    } catch (err) {
      console.error('Error loading data:', err);
      setError(t('common.error'));
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      let dayData = {
        ...formData,
        tournament_id: tournamentId,
        rebuy_amount: formData.rebuy_amount > 0 ? formData.rebuy_amount : null,
        addon_amount: formData.addon_amount > 0 ? formData.addon_amount : null,
        rebuy_level_limit: formData.rebuy_level_limit ? parseInt(formData.rebuy_level_limit) : null,
        qualifies_to_day_id: formData.qualifies_to_day_id || null,
      };

      // For final days, set financial and entry values to defaults (they come from qualifying days)
      if (formData.day_type === 'final') {
        dayData = {
          ...dayData,
          buy_in: 0,
          rebuy_amount: null,
          addon_amount: null,
          rake_percentage: 0,
          max_players: 1000, // High limit since qualified players come automatically
          starting_chips: 0, // Players bring their chips from qualifying days
          rebuy_chips: 0,
          addon_chips: 0,
          rebuy_level_limit: null,
        };
      }

      if (isEditing) {
        await api.patch(`/tournament-days/${dayId}`, dayData);
      } else {
        const createRes = await api.post('/tournament-days', dayData);
        const newDayId = createRes?.data?.id;
        // Herança automática: um novo dia (exceto o Final) já nasce com a mesma
        // estrutura de blinds dos dias classificatórios — copiamos os blinds de
        // um dia classificatório existente que já tenha estrutura configurada.
        if (newDayId && formData.day_type !== 'final') {
          await inheritBlindsFromQualifying(newDayId);
        }
      }

      // Navigate back to tournament detail
      navigate(`/torneios/${tournamentId}`);
    } catch (err) {
      console.error('Error saving day:', err);
      const detail = err.response?.data?.detail;
      let errorMessage = t('common.error');
      if (typeof detail === 'string') {
        errorMessage = detail;
      } else if (Array.isArray(detail)) {
        errorMessage = detail.map(e => `${e.loc?.join('.') || ''}: ${e.msg || ''}`).join(', ');
      }
      setError(errorMessage);
    } finally {
      setSubmitting(false);
    }
  };

  // Copia a estrutura de blinds de um dia classificatório existente para o novo
  // dia recém-criado. Best-effort: se nenhum classificatório tiver blinds ainda,
  // simplesmente não copia nada (o dia fica vazio, como antes).
  const inheritBlindsFromQualifying = async (newDayId) => {
    try {
      const sourceDays = days.filter(d => d.day_type === 'qualifying' && d.id !== newDayId);
      let sourceBlinds = [];
      for (const d of sourceDays) {
        const res = await api.get(`/tournament-days/${d.id}/blinds`);
        if (res?.data?.length) {
          sourceBlinds = res.data;
          break;
        }
      }
      if (!sourceBlinds.length) return;

      const ordered = [...sourceBlinds].sort((a, b) => a.level - b.level);
      for (const b of ordered) {
        await api.post(`/tournament-days/${newDayId}/blinds`, {
          level: b.level,
          small_blind: b.small_blind,
          big_blind: b.big_blind,
          ante: b.ante,
          duration: b.duration,
          is_break: b.is_break,
        });
      }
      toast.success(t('tournamentDayForm.blindsInherited', 'Estrutura de blinds herdada dos dias classificatórios.'));
    } catch (err) {
      console.error('Erro ao herdar blinds:', err);
      toast.warning(t('tournamentDayForm.blindsInheritError', 'Dia criado, mas não foi possível herdar a estrutura de blinds. Configure na tela de Blinds.'));
    }
  };

  const handleCancel = () => {
    navigate(`/torneios/${tournamentId}`);
  };

  if (loading) {
    return (
      <div className="app-container">
        <Sidebar />
        <main className="main-content tournament-day-form-page">
          <div className="loading">{t('common.loading')}</div>
        </main>
      </div>
    );
  }

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content tournament-day-form-page">
        <div className="page-header">
          <div>
            <h1>{isEditing ? t('tournamentDayForm.editDay') : t('tournamentDayForm.newDay')} - {tournament?.name}</h1>
          </div>
          <Button variant="secondary" onClick={handleCancel}>
            {t('common.back')}
          </Button>
        </div>

        {error && (
          <div className="error-message">
            {error}
          </div>
        )}

        <Card className="form-card">
          <form onSubmit={handleSubmit}>
            {/* Basic Info */}
            <div className="form-section">
              <h3 className="form-section-title">{t('tournamentDayForm.basicInfo')}</h3>
              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="day_name">{t('tournamentDays.dayName')} *</label>
                  <input
                    id="day_name"
                    type="text"
                    value={formData.day_name}
                    onChange={(e) => setFormData({ ...formData, day_name: e.target.value })}
                    placeholder={t('tournamentDayForm.dayNamePlaceholder')}
                    required
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="day_type">{t('tournamentDays.dayType')}</label>
                  <select
                    id="day_type"
                    value={formData.day_type}
                    onChange={(e) => setFormData({ ...formData, day_type: e.target.value, qualifies_to_day_id: '' })}
                  >
                    <option value="regular">{t('tournamentDays.regular')}</option>
                    {/* Classificatório e Final só aparecem ao EDITAR um dia que já
                        é desse tipo — na criação manual só existe "Regular", pois
                        classificatórios/final são gerados na criação do torneio. */}
                    {isEditing && <option value="qualifying">{t('tournamentDays.qualifying')}</option>}
                    {isEditing && <option value="final">{t('tournamentDays.final')}</option>}
                  </select>
                  <small className="form-hint">
                    {formData.day_type === 'qualifying' && t('tournamentDayForm.qualifyingHint')}
                    {formData.day_type === 'final' && t('tournamentDayForm.finalHint')}
                    {formData.day_type === 'regular' && t('tournamentDayForm.regularHint')}
                  </small>
                </div>
                {formData.day_type === 'qualifying' && (
                  <div className="form-group">
                    <label htmlFor="qualifies_to_day_id">{t('tournamentDays.qualifiesTo')} *</label>
                    <select
                      id="qualifies_to_day_id"
                      value={formData.qualifies_to_day_id}
                      onChange={(e) => setFormData({ ...formData, qualifies_to_day_id: e.target.value })}
                      required={formData.day_type === 'qualifying'}
                    >
                      <option value="">{t('tournamentDayForm.selectFinalDay')}</option>
                      {days
                        .filter(d => d.id !== dayId && (d.day_type === 'final' || d.day_type === 'regular'))
                        .map(d => (
                          <option key={d.id} value={d.id}>{d.day_name}</option>
                        ))
                      }
                    </select>
                    <small className="form-hint">{t('tournamentDayForm.qualifiesToHint')}</small>
                  </div>
                )}
              </div>
            </div>

            {/* Financial - only for non-final days */}
            {formData.day_type !== 'final' && (
              <div className="form-section">
                <h3 className="form-section-title">{t('tournamentDayForm.values')}</h3>
                <div className="form-row">
                  <div className="form-group">
                    <label htmlFor="buy_in">{t('tournaments.buyIn')} (R$) *</label>
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
                    <label htmlFor="rebuy_amount">{t('tournaments.rebuy')} (R$)</label>
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
                    <label htmlFor="addon_amount">{t('tournaments.addon')} (R$)</label>
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
                    <label htmlFor="currency">Moeda</label>
                    <select
                      id="currency"
                      value={formData.currency}
                      onChange={(e) => setFormData({ ...formData, currency: e.target.value })}
                    >
                      <option value="BRL">R$ — Real Brasileiro</option>
                      <option value="USD">$ — Dólar Americano</option>
                      <option value="EUR">€ — Euro</option>
                      <option value="GBP">£ — Libra Esterlina</option>
                      <option value="ARS">$ — Peso Argentino</option>
                      <option value="COP">$ — Peso Colombiano</option>
                    </select>
                  </div>
                </div>
              </div>
            )}

            {/* Players and Chips - only for non-final days */}
            {formData.day_type !== 'final' && (
              <div className="form-section">
                <h3 className="form-section-title">{t('tournamentDayForm.playersAndChips')}</h3>
                <div className="form-row">
                  <div className="form-group">
                    <label htmlFor="max_players">{t('tournaments.maxPlayers')} *</label>
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
                    <label htmlFor="starting_chips">{t('tournaments.startingChips')} *</label>
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
                    <label htmlFor="rebuy_chips">{t('tournamentDayForm.rebuyChips')}</label>
                    <input
                      id="rebuy_chips"
                      type="number"
                      min="0"
                      value={formData.rebuy_chips}
                      onChange={(e) => setFormData({ ...formData, rebuy_chips: parseInt(e.target.value) })}
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="addon_chips">{t('tournamentDayForm.addonChips')}</label>
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
            )}

            {/* Rebuy Limit - only for non-final days */}
            {formData.day_type !== 'final' && (
              <div className="form-section">
                <h3 className="form-section-title">{t('tournamentDayForm.rebuyConfig')}</h3>
                <div className="form-row">
                  <div className="form-group">
                    <label htmlFor="rebuy_level_limit">{t('tournamentDayForm.rebuyLevelLimit')}</label>
                    <input
                      id="rebuy_level_limit"
                      type="number"
                      min="1"
                      value={formData.rebuy_level_limit}
                      onChange={(e) => setFormData({ ...formData, rebuy_level_limit: e.target.value })}
                      placeholder={t('tournamentDayForm.leaveEmptyUnlimited')}
                    />
                    <small className="form-hint">{t('tournamentDayForm.rebuyLevelHint')}</small>
                  </div>
                </div>
              </div>
            )}


            <div className="form-actions">
              <Button type="button" variant="secondary" onClick={handleCancel}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? t('tournamentDayForm.saving') : (isEditing ? t('tournamentDayForm.saveChanges') : t('tournamentDayForm.createDay'))}
              </Button>
            </div>
          </form>
        </Card>
      </main>
    </div>
  );
};

export default TournamentDayForm;
