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
    rake_percentage: 20,
    starting_chips: 10000,
    rebuy_chips: 10000,
    addon_chips: 10000,
    rebuy_level_limit: '',
    allocation_type: 'automatic',
    day_type: 'regular',
    qualifies_to_day_id: '',
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
        });
        setBroadcastSettings({
          broadcast_bg_color: day.broadcast_bg_color || '#0a0e13',
          broadcast_bg_image_url: day.broadcast_bg_image_url || '',
          broadcast_display_name: day.broadcast_display_name || '',
          broadcast_font_size: day.broadcast_font_size || 100,
          broadcast_show_logo: day.broadcast_show_logo !== false,
          broadcast_show_title: day.broadcast_show_title !== false,
          broadcast_show_prizepool: day.broadcast_show_prizepool !== false,
          broadcast_show_level: day.broadcast_show_level !== false,
          broadcast_show_players: day.broadcast_show_players !== false,
          broadcast_show_interval: day.broadcast_show_interval !== false,
          broadcast_show_timer: day.broadcast_show_timer !== false,
          broadcast_show_blinds: day.broadcast_show_blinds !== false,
          broadcast_show_ante: day.broadcast_show_ante !== false,
          broadcast_show_next_blind: day.broadcast_show_next_blind !== false,
          broadcast_show_prizes: day.broadcast_show_prizes !== false,
        });
      } else {
        // For new day, set day_number to next available and default day_type based on tournament
        const hasQualifying = tournamentRes.data.has_qualifying;
        setFormData(prev => ({
          ...prev,
          day_number: daysRes.data.length + 1,
          day_type: hasQualifying ? 'qualifying' : 'regular',
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
        ...broadcastSettings,
        broadcast_bg_image_url: broadcastSettings.broadcast_bg_image_url || null,
        broadcast_display_name: broadcastSettings.broadcast_display_name || null,
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
        await api.post('/tournament-days', dayData);
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
                    <option value="qualifying">{t('tournamentDays.qualifying')}</option>
                    <option value="final">{t('tournamentDays.final')}</option>
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
                    <label htmlFor="rake_percentage">{t('cashRegister.rake')} (%)</label>
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


            {/* Broadcast Settings */}
            <div className="form-section">
              <h3 className="form-section-title">Configuracoes de Broadcast</h3>

              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="broadcast_bg_color">Cor de Fundo</label>
                  <div className="color-input-wrapper">
                    <input
                      id="broadcast_bg_color"
                      type="color"
                      value={broadcastSettings.broadcast_bg_color}
                      onChange={(e) => setBroadcastSettings({ ...broadcastSettings, broadcast_bg_color: e.target.value })}
                      className="color-input"
                    />
                    <input
                      type="text"
                      value={broadcastSettings.broadcast_bg_color}
                      onChange={(e) => setBroadcastSettings({ ...broadcastSettings, broadcast_bg_color: e.target.value })}
                      className="color-text-input"
                      placeholder="#0a0e13"
                    />
                  </div>
                </div>
                <div className="form-group">
                  <label htmlFor="broadcast_display_name">Nome de Exibicao</label>
                  <input
                    id="broadcast_display_name"
                    type="text"
                    value={broadcastSettings.broadcast_display_name}
                    onChange={(e) => setBroadcastSettings({ ...broadcastSettings, broadcast_display_name: e.target.value })}
                    placeholder="Nome customizado (opcional)"
                  />
                </div>
              </div>

              <div className="form-group">
                <label>Tamanho da Fonte: {broadcastSettings.broadcast_font_size}%</label>
                <div className="font-size-slider-wrapper">
                  <span className="slider-label">50%</span>
                  <input
                    type="range"
                    min="50"
                    max="200"
                    step="10"
                    value={broadcastSettings.broadcast_font_size}
                    onChange={(e) => setBroadcastSettings({ ...broadcastSettings, broadcast_font_size: parseInt(e.target.value) })}
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
                        onClick={() => setBroadcastSettings({ ...broadcastSettings, broadcast_bg_image_url: '' })}
                        title="Remover imagem"
                      >
                        x
                      </button>
                    </div>
                  ) : (
                    <label className="image-upload-area">
                      <input
                        type="file"
                        accept="image/*"
                        onChange={(e) => {
                          const file = e.target.files[0];
                          if (file) {
                            if (file.size > 2 * 1024 * 1024) {
                              toast.warning('Imagem muito grande. Maximo: 2MB');
                              return;
                            }
                            const reader = new FileReader();
                            reader.onloadend = () => {
                              setBroadcastSettings({ ...broadcastSettings, broadcast_bg_image_url: reader.result });
                            };
                            reader.readAsDataURL(file);
                          }
                        }}
                        className="hidden-input"
                      />
                      <div className="upload-placeholder">
                        <span className="upload-icon">+</span>
                        <span className="upload-text">Clique para anexar imagem</span>
                        <span className="upload-hint">PNG, JPG ate 2MB</span>
                      </div>
                    </label>
                  )}
                </div>
                <div className="image-url-alternative">
                  <span className="or-divider">ou cole uma URL</span>
                  <input
                    type="text"
                    value={broadcastSettings.broadcast_bg_image_url?.startsWith('data:') ? '' : broadcastSettings.broadcast_bg_image_url}
                    onChange={(e) => setBroadcastSettings({ ...broadcastSettings, broadcast_bg_image_url: e.target.value })}
                    placeholder="https://exemplo.com/imagem.jpg"
                    disabled={broadcastSettings.broadcast_bg_image_url?.startsWith('data:')}
                  />
                </div>
              </div>

              <div className="form-group">
                <label className="section-label">Elementos Visiveis no Broadcast</label>
                <div className="visibility-grid">
                  {[
                    { key: 'broadcast_show_logo', label: 'Logo' },
                    { key: 'broadcast_show_title', label: 'Titulo' },
                    { key: 'broadcast_show_prizepool', label: 'Prizepool' },
                    { key: 'broadcast_show_level', label: 'Nivel' },
                    { key: 'broadcast_show_players', label: 'Jogadores' },
                    { key: 'broadcast_show_interval', label: 'Intervalo' },
                    { key: 'broadcast_show_timer', label: 'Timer' },
                    { key: 'broadcast_show_blinds', label: 'Blinds' },
                    { key: 'broadcast_show_ante', label: 'Ante' },
                    { key: 'broadcast_show_next_blind', label: 'Prox. Blind' },
                    { key: 'broadcast_show_prizes', label: 'Premiacoes' },
                  ].map(({ key, label }) => (
                    <label key={key} className={`visibility-card ${broadcastSettings[key] ? 'active' : ''}`}>
                      <input
                        type="checkbox"
                        checked={broadcastSettings[key]}
                        onChange={(e) => setBroadcastSettings({ ...broadcastSettings, [key]: e.target.checked })}
                      />
                      <span className="visibility-label">{label}</span>
                      <span className="visibility-toggle"></span>
                    </label>
                  ))}
                </div>
              </div>
            </div>

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
