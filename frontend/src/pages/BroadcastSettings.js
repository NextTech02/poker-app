import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { labelsForLanguage } from '../utils/broadcastLabels';
import TvStage from '../components/broadcast/TvStage';
import TvScreen from '../components/broadcast/TvScreen';
import { TV_DEFAULT_SETTINGS } from '../components/broadcast/tvDefaults';
import { buildTvSettings } from '../components/broadcast/tvModel';
import { resolveBackground } from '../components/broadcast/tvBackgrounds';
import { sampleModel } from '../components/broadcast/tvSampleData';
import BackgroundGallery from '../components/broadcast/BackgroundGallery';
import { useBroadcastBackgrounds } from '../hooks/useBroadcastBackgrounds';
import './BroadcastSettings.css';

// ─────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────
// Padrões: a MESMA fonte que o telão usa (`tvDefaults`), para a prévia e a
// TV nunca divergirem. NULL no banco = este padrão.
const DEFAULT_SETTINGS = TV_DEFAULT_SETTINGS;

// ─────────────────────────────────────────────────────────────────
// Reusable form controls
// ─────────────────────────────────────────────────────────────────
const ColorField = ({ label, settingsKey, settings, onChange }) => (
  <div className="bs-color-field">
    <span className="bs-color-field-label">{label}</span>
    <div className="bs-color-control">
      <label className="bs-swatch-btn" style={{ background: settings[settingsKey] }}>
        <input
          type="color"
          value={settings[settingsKey]}
          onChange={(e) => onChange(settingsKey, e.target.value)}
          className="bs-hidden-color"
        />
      </label>
      <input
        type="text"
        value={settings[settingsKey]}
        onChange={(e) => onChange(settingsKey, e.target.value)}
        className="bs-hex-input"
        maxLength={7}
        spellCheck={false}
      />
    </div>
  </div>
);

const SliderField = ({ label, settingsKey, min, max, settings, onChange, step = 10 }) => {
  const pct = ((settings[settingsKey] - min) / (max - min)) * 100;
  return (
    <div className="bs-slider-field">
      <div className="bs-slider-header">
        <span className="bs-slider-label">{label}</span>
        <span className="bs-slider-val">{settings[settingsKey]}%</span>
      </div>
      <div className="bs-slider-track-wrap">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={settings[settingsKey]}
          onChange={(e) => onChange(settingsKey, parseInt(e.target.value))}
          className="bs-range"
          style={{ '--pct': `${pct}%` }}
        />
      </div>
      <div className="bs-slider-limits">
        <span>{min}%</span>
        <span>{max}%</span>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────
// Live preview — o MESMO componente do telão, com dados de amostra.
// Antes era uma cópia do layout com estilos inline, que ficava para trás a
// cada mudança no telão de verdade.
// ─────────────────────────────────────────────────────────────────
const BroadcastPreview = ({ settings, tournamentName, dayName, notice, previewBreak }) => {
  const { i18n } = useTranslation();
  const { currency } = useCurrency();
  const tvSettings = buildTvSettings(settings);
  // Mesmo idioma da tela em que a pessoa está (escolha dela ou o do clube).
  const labels = labelsForLanguage(i18n?.language);
  const model = sampleModel({ tournamentName, dayName, isBreak: previewBreak });
  const background = resolveBackground(tvSettings.bgValue, tvSettings.bgColor, tvSettings.bgOverlay);

  return (
    <div className="bs-preview-stage">
      <TvStage fit="width" background={background}>
        <TvScreen
          mode={previewBreak ? 'break' : 'live'}
          model={model}
          settings={tvSettings}
          labels={labels}
          currency={currency || 'BRL'}
          fontScale={tvSettings.fontSize / 100}
        />
      </TvStage>
      <p className="bpv-notice">{notice}</p>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────
// Section card wrapper
// ─────────────────────────────────────────────────────────────────
const SectionCard = ({ icon, title, children }) => (
  <div className="bs-card">
    <div className="bs-card-header">
      {icon && <span className="bs-card-icon">{icon}</span>}
      <span className="bs-card-title">{title}</span>
    </div>
    <div className="bs-card-body">{children}</div>
  </div>
);

// ─────────────────────────────────────────────────────────────────
// Main page
// ─────────────────────────────────────────────────────────────────
const BroadcastSettings = () => {
  const { tournamentId, dayId } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { t } = useTranslation();

  const [dayName, setDayName]           = useState('');
  const [tournamentName, setTournament] = useState('');
  const [settings, setSettings]         = useState(DEFAULT_SETTINGS);
  const [loading, setLoading]           = useState(true);
  const [submitting, setSubmitting]     = useState(false);
  const [previewBreak, setPreviewBreak] = useState(false);
  const [tvCode, setTvCode]             = useState('');
  const [tvCopied, setTvCopied]         = useState(false);
  // Biblioteca de fundos do clube — uma lista só para os dois seletores
  // (fundo principal e fundo do intervalo).
  const library = useBroadcastBackgrounds();

  useEffect(() => {
    const load = async () => {
      try {
        const [dayRes, tRes] = await Promise.all([
          api.get(`/tournament-days/${dayId}`),
          api.get(`/tournaments/${tournamentId}`),
        ]);
        const d = dayRes.data;
        setDayName(d.day_name);
        setTournament(tRes.data.name);
        setSettings({
          broadcast_bg_color:              d.broadcast_bg_color              || DEFAULT_SETTINGS.broadcast_bg_color,
          broadcast_bg_image_url:          d.broadcast_bg_image_url          || '',
          broadcast_bg_overlay:            d.broadcast_bg_overlay            ?? DEFAULT_SETTINGS.broadcast_bg_overlay,
          // Divulgação na coluna da direita do telão
          broadcast_promo_url:             d.broadcast_promo_url             || '',
          broadcast_show_promo:            d.broadcast_show_promo            !== false,
          broadcast_promo_fit:             d.broadcast_promo_fit === 'cover' ? 'cover' : 'contain',
          broadcast_display_name:          d.broadcast_display_name          || '',
          broadcast_font_size:             d.broadcast_font_size             || 100,
          broadcast_prize_size:            d.broadcast_prize_size            || 100,
          broadcast_prizepool_label_color: d.broadcast_prizepool_label_color || DEFAULT_SETTINGS.broadcast_prizepool_label_color,
          broadcast_prizepool_value_color: d.broadcast_prizepool_value_color || DEFAULT_SETTINGS.broadcast_prizepool_value_color,
          broadcast_prizepool_size:        d.broadcast_prizepool_size        || 100,
          broadcast_timer_color:           d.broadcast_timer_color           || DEFAULT_SETTINGS.broadcast_timer_color,
          broadcast_title_color:           d.broadcast_title_color           || DEFAULT_SETTINGS.broadcast_title_color,
          broadcast_blinds_label_color:    d.broadcast_blinds_label_color    || DEFAULT_SETTINGS.broadcast_blinds_label_color,
          broadcast_blinds_value_color:    d.broadcast_blinds_value_color    || DEFAULT_SETTINGS.broadcast_blinds_value_color,
          broadcast_ante_label_color:      d.broadcast_ante_label_color      || DEFAULT_SETTINGS.broadcast_ante_label_color,
          broadcast_ante_value_color:      d.broadcast_ante_value_color      || DEFAULT_SETTINGS.broadcast_ante_value_color,
          broadcast_next_label_color:      d.broadcast_next_label_color      || DEFAULT_SETTINGS.broadcast_next_label_color,
          broadcast_next_value_color:      d.broadcast_next_value_color      || DEFAULT_SETTINGS.broadcast_next_value_color,
          broadcast_sidebar_label_color:   d.broadcast_sidebar_label_color   || DEFAULT_SETTINGS.broadcast_sidebar_label_color,
          broadcast_sidebar_value_color:   d.broadcast_sidebar_value_color   || DEFAULT_SETTINGS.broadcast_sidebar_value_color,
          broadcast_show_logo:       d.broadcast_show_logo       !== false,
          broadcast_club_logo_url:   d.broadcast_club_logo_url   || '',
          broadcast_show_club_logo:  d.broadcast_show_club_logo  !== false,
          broadcast_club_logo_size:  d.broadcast_club_logo_size  || 100,
          broadcast_show_title:      d.broadcast_show_title      !== false,
          broadcast_show_prizepool:  d.broadcast_show_prizepool  !== false,
          broadcast_show_level:      d.broadcast_show_level      !== false,
          broadcast_show_players:    d.broadcast_show_players    !== false,
          broadcast_show_reentries:  d.broadcast_show_reentries  !== false,
          broadcast_show_interval:   d.broadcast_show_interval   !== false,
          broadcast_show_timer:      d.broadcast_show_timer      !== false,
          broadcast_show_blinds:     d.broadcast_show_blinds     !== false,
          broadcast_show_ante:       d.broadcast_show_ante       !== false,
          broadcast_show_next_blind: d.broadcast_show_next_blind !== false,
          broadcast_show_prizes:     d.broadcast_show_prizes     !== false,
          broadcast_show_chipcount:  d.broadcast_show_chipcount  !== false,
          broadcast_show_average:    d.broadcast_show_average    !== false,
          broadcast_blind_alerts_enabled: d.broadcast_blind_alerts_enabled !== false,
          broadcast_prizes_layout:   d.broadcast_prizes_layout   || DEFAULT_SETTINGS.broadcast_prizes_layout,
          // Break screen
          broadcast_break_layout:          d.broadcast_break_layout          || DEFAULT_SETTINGS.broadcast_break_layout,
          broadcast_break_bg_color:        d.broadcast_break_bg_color        || DEFAULT_SETTINGS.broadcast_break_bg_color,
          broadcast_break_bg_image_url:    d.broadcast_break_bg_image_url    || '',
          broadcast_break_youtube_url:     d.broadcast_break_youtube_url     || '',
          broadcast_break_show_video:      d.broadcast_break_show_video      !== false,
          broadcast_break_video_muted:     d.broadcast_break_video_muted     !== false,
          broadcast_break_show_next_level: d.broadcast_break_show_next_level !== false,
          broadcast_break_show_players:    d.broadcast_break_show_players    !== false,
          broadcast_break_show_chipcount:  d.broadcast_break_show_chipcount  !== false,
          broadcast_break_show_average:    d.broadcast_break_show_average    !== false,
          broadcast_break_overlay_opacity: d.broadcast_break_overlay_opacity ?? DEFAULT_SETTINGS.broadcast_break_overlay_opacity,
          broadcast_break_font_size:       d.broadcast_break_font_size       ?? DEFAULT_SETTINGS.broadcast_break_font_size,
          broadcast_break_timer_color:     d.broadcast_break_timer_color     || DEFAULT_SETTINGS.broadcast_break_timer_color,
          broadcast_break_label_color:     d.broadcast_break_label_color     || DEFAULT_SETTINGS.broadcast_break_label_color,
          broadcast_break_value_color:     d.broadcast_break_value_color     || DEFAULT_SETTINGS.broadcast_break_value_color,
          broadcast_break_title_color:     d.broadcast_break_title_color     || DEFAULT_SETTINGS.broadcast_break_title_color,
        });
      } catch (err) {
        console.error(err);
        toast.error(t('broadcastSettings.errorLoad'));
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [dayId, tournamentId, t, toast]);

  // Código público da TV (por DIA) — carrega em separado pra não travar a tela
  useEffect(() => {
    let active = true;
    api.get(`/tournament-days/${dayId}/broadcast-code`)
      .then(res => { if (active) setTvCode(res.data?.code || ''); })
      .catch(() => {});
    return () => { active = false; };
  }, [dayId]);

  const copyTvCode = () => {
    if (!tvCode) return;
    const text = `${window.location.origin}/tv  →  ${tvCode}`;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        setTvCopied(true);
        setTimeout(() => setTvCopied(false), 1800);
      }).catch(() => {});
    }
  };

  const set = (key, value) => setSettings(prev => ({ ...prev, [key]: value }));

  const limparFundoRemovido = (url) => setSettings(prev => ({
    ...prev,
    broadcast_bg_image_url:       prev.broadcast_bg_image_url       === url ? '' : prev.broadcast_bg_image_url,
    broadcast_break_bg_image_url: prev.broadcast_break_bg_image_url === url ? '' : prev.broadcast_break_bg_image_url,
    broadcast_promo_url: prev.broadcast_promo_url === url ? '' : prev.broadcast_promo_url,
  }));

  const handleSave = async () => {
    setSubmitting(true);
    try {
      await api.patch(`/tournament-days/${dayId}`, {
        ...settings,
        broadcast_bg_image_url:       settings.broadcast_bg_image_url       || null,
        broadcast_club_logo_url:      settings.broadcast_club_logo_url      || null,
        broadcast_display_name:       settings.broadcast_display_name       || null,
        broadcast_break_youtube_url:  settings.broadcast_break_youtube_url  || null,
        broadcast_break_bg_image_url: settings.broadcast_break_bg_image_url || null,
        broadcast_promo_url:          (settings.broadcast_promo_url || '').trim() || null,
      });
      toast.success(t('broadcastSettings.saved'));
    } catch (err) {
      console.error(err);
      toast.error(t('broadcastSettings.errorSave'));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="app-container">
        <Sidebar />
        <main className="main-content bs-page">
          <div className="loading">{t('common.loading')}</div>
        </main>
      </div>
    );
  }

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content bs-page">

        {/* ── Top bar ── */}
        <div className="bs-topbar">
          <div className="bs-topbar-left">
            <div className="bs-topbar-eyebrow">{tournamentName} / {dayName}</div>
            <h1 className="bs-topbar-title">{t('broadcastSettings.pageTitle')}</h1>
          </div>
          <div className="bs-topbar-right">
            {tvCode && (
              <button
                type="button"
                className="bs-tv-code"
                onClick={copyTvCode}
                title={t('broadcastSettings.tvCodeHint', 'Na TV, acesse {{url}} e digite este código', { url: `${window.location.origin}/tv` })}
              >
                <span className="bs-tv-code-label">{t('broadcastSettings.tvCode', 'Código TV')}</span>
                <span className="bs-tv-code-value">{tvCode}</span>
                <span className="bs-tv-code-copy">{tvCopied ? t('broadcastSettings.tvCodeCopied', 'copiado!') : t('broadcastSettings.tvCodeCopy', 'copiar')}</span>
              </button>
            )}
            <button type="button" className="bs-btn-preview" onClick={() => window.open(`/broadcast/${dayId}`, '_blank')}>
              &#9654; {t('broadcastSettings.openLive')}
            </button>
            <button type="button" className="bs-btn-back" onClick={() => navigate(`/torneios/${tournamentId}`)}>
              {t('common.back')}
            </button>
          </div>
        </div>

        {/* ── Full-width preview ── */}
        <div className="bs-preview-card bs-preview-full">
          <div className="bs-preview-topbar">
            <span className="bs-preview-dot red" />
            <span className="bs-preview-dot yellow" />
            <span className="bs-preview-dot green" />
            <span className="bs-preview-title-bar">
              {previewBreak ? t('broadcastSettings.previewBreak') : t('broadcastSettings.previewLive')}
            </span>
            <button
              type="button"
              className={`bs-preview-mode-btn ${previewBreak ? 'active' : ''}`}
              onClick={() => setPreviewBreak(b => !b)}
              title={previewBreak ? t('broadcastSettings.previewSwitchBlinds') : t('broadcastSettings.previewSwitchBreak')}
            >
              {previewBreak ? t('broadcastSettings.previewBlinds') : t('broadcastSettings.previewInterval')}
            </button>
          </div>
          <BroadcastPreview
            settings={settings}
            tournamentName={tournamentName}
            dayName={dayName}
            notice={t('broadcastSettings.previewNotice')}
            previewBreak={previewBreak}
          />
        </div>

        {/* ── Settings — 2 columns ── */}
        <div className="bs-settings-grid">

          {/* Column 1: Appearance + Prizepool + Ticker */}
          <div className="bs-col">

            <SectionCard title={t('broadcastSettings.sectionAppearance')}>
              <div className="bs-field-full">
                <label className="bs-label">{t('broadcastSettings.displayName')}</label>
                <input
                  type="text"
                  value={settings.broadcast_display_name}
                  onChange={(e) => set('broadcast_display_name', e.target.value)}
                  placeholder={t('broadcastSettings.displayNamePlaceholder')}
                  className="bs-input"
                />
                <span className="bs-hint">{t('broadcastSettings.displayNameHint')}</span>
              </div>

              <div className="bs-row-2">
                <ColorField label={t('broadcastSettings.bgColor')} settingsKey="broadcast_bg_color" settings={settings} onChange={set} />
                <div className="bs-empty" />
              </div>

              <SliderField label={t('broadcastSettings.fontSize')} settingsKey="broadcast_font_size" min={50} max={200} settings={settings} onChange={set} />

              <div className="bs-field-full" style={{ marginTop: '0.25rem' }}>
                <label className="bs-label">{t('broadcastSettings.bgImage')}</label>
                <BackgroundGallery
                  idPrefix="bg"
                  value={settings.broadcast_bg_image_url}
                  onChange={(v) => set('broadcast_bg_image_url', v)}
                  bgColor={settings.broadcast_bg_color}
                  library={library}
                  showOverlay
                  overlay={settings.broadcast_bg_overlay}
                  onOverlayChange={(v) => set('broadcast_bg_overlay', v)}
                  onItemRemoved={limparFundoRemovido}
                />
              </div>

              {/* Logo do clube — canto direito do cabeçalho, acima do relógio */}
              <div className="bs-field-full" style={{ marginTop: '0.25rem' }}>
                <label className="bs-label">{t('broadcastSettings.clubLogo', 'Logo do clube')}</label>
                <span className="bs-hint">{t('broadcastSettings.clubLogoHint', 'Aparece no canto direito do telão, acima do contador. Use PNG com fundo transparente: o cabeçalho é escuro.')}</span>
                {settings.broadcast_club_logo_url ? (
                  <div className="bs-img-preview-wrap">
                    <img src={settings.broadcast_club_logo_url} alt="logo" className="bs-img-preview" />
                    <button type="button" className="bs-img-remove" onClick={() => set('broadcast_club_logo_url', '')}>×</button>
                  </div>
                ) : (
                  <label className="bs-upload-zone">
                    <input
                      type="file" accept="image/*" className="bs-hidden"
                      onChange={(e) => {
                        const file = e.target.files[0];
                        if (!file) return;
                        // Teto menor que o do fundo (2MB): a imagem viaja em base64
                        // dentro do JSON do dia, que o telão rebusca a cada 30s.
                        if (file.size > 512 * 1024) { toast.warning(t('broadcastSettings.clubLogoMaxSize', 'A logo precisa ter até 512KB. Acima disso, prefira colar a URL da imagem.')); return; }
                        const reader = new FileReader();
                        reader.onloadend = () => set('broadcast_club_logo_url', reader.result);
                        reader.readAsDataURL(file);
                      }}
                    />
                    <span className="bs-upload-plus">+</span>
                    <span className="bs-upload-main">{t('broadcastSettings.clubLogoUpload', 'Enviar a logo do clube')}</span>
                    <span className="bs-upload-sub">{t('broadcastSettings.clubLogoUploadHint', 'PNG com fundo transparente, até 512KB')}</span>
                  </label>
                )}
                <div className="bs-url-row">
                  <span className="bs-or-label">{t('broadcastSettings.clubLogoUrlLabel', 'ou cole a URL')}</span>
                  <input
                    type="text"
                    value={settings.broadcast_club_logo_url?.startsWith('data:') ? '' : settings.broadcast_club_logo_url}
                    onChange={(e) => set('broadcast_club_logo_url', e.target.value)}
                    placeholder="https://..."
                    disabled={settings.broadcast_club_logo_url?.startsWith('data:')}
                    className="bs-input"
                  />
                </div>
                <SliderField
                  label={t('broadcastSettings.clubLogoSize', 'Tamanho da logo do clube')}
                  settingsKey="broadcast_club_logo_size" min={50} max={300}
                  settings={settings} onChange={set}
                />
              </div>
            </SectionCard>

            {/* ── Divulgação: coluna da direita do telão (imagem, vídeo ou YouTube) ── */}
            <SectionCard title={t('broadcastSettings.sectionPromo', 'Divulgação (coluna da direita)')}>
              <span className="bs-hint">
                {t('broadcastSettings.promoHint', 'Imagem ou vídeo do clube na coluna da direita do telão, ao lado do relógio. Formato em pé funciona melhor (como um story, 9:16). Com a premiação na lateral, ela fica abaixo da divulgação.')}
              </span>
              <label className={`bs-toggle ${settings.broadcast_show_promo ? 'on' : 'off'}`} style={{ marginTop: '0.5rem' }}>
                <input
                  type="checkbox"
                  checked={settings.broadcast_show_promo}
                  onChange={(e) => set('broadcast_show_promo', e.target.checked)}
                />
                <span className="bs-toggle-track">
                  <span className="bs-toggle-thumb" />
                </span>
                <span className="bs-toggle-label">{t('broadcastSettings.promoShow', 'Mostrar divulgação no telão')}</span>
              </label>
              <div className="bs-field-full" style={{ marginTop: '0.5rem' }}>
                <BackgroundGallery
                  idPrefix="promo"
                  value={settings.broadcast_promo_url}
                  onChange={(v) => set('broadcast_promo_url', v)}
                  library={library}
                  showPresets={false}
                  noneLabel={t('broadcastSettings.promoNone', 'Sem divulgação')}
                  urlLabel={t('broadcastSettings.promoUrlLabel', 'ou cole a URL de uma imagem, de um vídeo (.mp4/.webm) ou do YouTube')}
                  urlPlaceholder={t('broadcastSettings.promoUrlPlaceholder', 'https://youtube.com/watch?v=… ou https://…/video.mp4')}
                  onItemRemoved={limparFundoRemovido}
                />
                <span className="bs-hint">{t('broadcastSettings.promoVideoHint', 'Vídeo e YouTube tocam em loop e sem som.')}</span>
              </div>
              <div className="bs-field-full" style={{ marginTop: '0.5rem' }}>
                <label className="bs-label" htmlFor="promo-fit">{t('broadcastSettings.promoFit', 'Ajuste da imagem/vídeo')}</label>
                <select
                  id="promo-fit"
                  className="bs-input"
                  value={settings.broadcast_promo_fit}
                  onChange={(e) => set('broadcast_promo_fit', e.target.value)}
                >
                  <option value="contain">{t('broadcastSettings.promoFitContain', 'Mostrar inteira (sem cortar)')}</option>
                  <option value="cover">{t('broadcastSettings.promoFitCover', 'Preencher a coluna (pode cortar as bordas)')}</option>
                </select>
              </div>
            </SectionCard>

            <SectionCard title={t('broadcastSettings.sectionPrizepool')}>
              <SliderField label={t('broadcastSettings.widgetSize')} settingsKey="broadcast_prizepool_size" min={50} max={300} settings={settings} onChange={set} />
              <div className="bs-row-2">
                <ColorField label={t('broadcastSettings.prizepoolLabel')} settingsKey="broadcast_prizepool_label_color" settings={settings} onChange={set} />
                <ColorField label={t('broadcastSettings.prizepoolValue')} settingsKey="broadcast_prizepool_value_color" settings={settings} onChange={set} />
              </div>
            </SectionCard>

            <SectionCard title={t('broadcastSettings.sectionTicker')}>
              <div className="bs-field-full">
                <label className="bs-label">{t('broadcastSettings.prizesLayout')}</label>
                <div className="bs-layout-selector">
                  {['bottom', 'sidebar'].map(opt => (
                    <button
                      key={opt}
                      type="button"
                      className={`bs-layout-opt ${settings.broadcast_prizes_layout === opt ? 'active' : ''}`}
                      onClick={() => set('broadcast_prizes_layout', opt)}
                    >
                      {opt === 'bottom' ? `▬ ${t('broadcastSettings.prizesLayoutBottom')}` : `▐ ${t('broadcastSettings.prizesLayoutSidebar')}`}
                    </button>
                  ))}
                </div>
              </div>
              <SliderField
                label={settings.broadcast_prizes_layout === 'sidebar' ? t('broadcastSettings.prizesSize') : t('broadcastSettings.tickerHeight')}
                settingsKey="broadcast_prize_size" min={50} max={300} settings={settings} onChange={set}
              />
            </SectionCard>

            {/* ── Break Screen Section ── */}
            <SectionCard icon={null} title={t('broadcastSettings.sectionBreak')}>
              {/* Layout selector */}
              <div className="bs-field-full">
                <label className="bs-label">{t('broadcastSettings.breakLayout')}</label>
                <div className="bs-layout-selector">
                  {['split', 'fullscreen', 'overlay'].map(opt => (
                    <button
                      key={opt}
                      type="button"
                      className={`bs-layout-opt ${settings.broadcast_break_layout === opt ? 'active' : ''}`}
                      onClick={() => set('broadcast_break_layout', opt)}
                    >
                      {opt === 'split' ? `▌▐ ${t('broadcastSettings.breakLayoutSplit')}` : opt === 'fullscreen' ? `▬ ${t('broadcastSettings.breakLayoutFullscreen')}` : `◱ ${t('broadcastSettings.breakLayoutOverlay')}`}
                    </button>
                  ))}
                </div>
              </div>

              {/* YouTube URL */}
              <div className="bs-field-full">
                <label className="bs-label">{t('broadcastSettings.breakYoutube')}</label>
                <input
                  type="text"
                  value={settings.broadcast_break_youtube_url}
                  onChange={(e) => set('broadcast_break_youtube_url', e.target.value)}
                  placeholder="https://www.youtube.com/watch?v=..."
                  className="bs-input"
                />
                <span className="bs-hint">{t('broadcastSettings.breakYoutubeHint')}</span>
              </div>

              {/* Background color */}
              <div className="bs-row-2">
                <ColorField label={t('broadcastSettings.breakBgColor')} settingsKey="broadcast_break_bg_color" settings={settings} onChange={set} />
                <div className="bs-empty" />
              </div>

              {/* Imagem de fundo do intervalo — existia no banco, mas não tinha campo na tela */}
              <div className="bs-field-full">
                <label className="bs-label">{t('broadcastSettings.breakBgImage', 'Imagem de fundo do intervalo')}</label>
                <BackgroundGallery
                  idPrefix="break-bg"
                  value={settings.broadcast_break_bg_image_url}
                  onChange={(v) => set('broadcast_break_bg_image_url', v)}
                  bgColor={settings.broadcast_break_bg_color}
                  library={library}
                  onItemRemoved={limparFundoRemovido}
                />
              </div>

              {/* Font size */}
              <SliderField label={t('broadcastSettings.breakFontSize')} settingsKey="broadcast_break_font_size" min={50} max={300} settings={settings} onChange={set} />

              {/* Overlay opacity — only shown for fullscreen/overlay */}
              {(settings.broadcast_break_layout === 'fullscreen' || settings.broadcast_break_layout === 'overlay') && (
                <SliderField label={t('broadcastSettings.breakOverlayOpacity')} settingsKey="broadcast_break_overlay_opacity" min={0} max={100} settings={settings} onChange={set} />
              )}

              {/* Visibility toggles */}
              <div className="bs-label" style={{ marginTop: '0.25rem' }}>{t('broadcastSettings.breakVisibility')}</div>
              <div className="bs-toggle-grid">
                {[
                  { key: 'broadcast_break_show_video',      labelKey: 'breakShowVideo' },
                  { key: 'broadcast_break_video_muted',     labelKey: 'breakVideoMuted' },
                  { key: 'broadcast_break_show_next_level', labelKey: 'breakShowNextLevel' },
                  { key: 'broadcast_break_show_players',    labelKey: 'breakShowPlayers' },
                  { key: 'broadcast_break_show_chipcount',  labelKey: 'breakShowChipcount' },
                  { key: 'broadcast_break_show_average',    labelKey: 'breakShowAverage' },
                ].map(({ key, labelKey }) => (
                  <label key={key} className={`bs-toggle ${settings[key] ? 'on' : 'off'}`}>
                    <input type="checkbox" checked={settings[key]} onChange={(e) => set(key, e.target.checked)} />
                    <span className="bs-toggle-track"><span className="bs-toggle-thumb" /></span>
                    <span className="bs-toggle-label">{t(`broadcastSettings.${labelKey}`)}</span>
                  </label>
                ))}
              </div>
            </SectionCard>

          </div>

          {/* Column 2: Colors + Visibility + Actions */}
          <div className="bs-col">

            <SectionCard title={t('broadcastSettings.sectionColors')}>
              <div className="bs-color-grid">
                {[
                  { labelKey: 'colorTimer',         key: 'broadcast_timer_color' },
                  { labelKey: 'colorTitle',         key: 'broadcast_title_color' },
                  { labelKey: 'colorBlindsLabel',   key: 'broadcast_blinds_label_color' },
                  { labelKey: 'colorBlindsValue',   key: 'broadcast_blinds_value_color' },
                  { labelKey: 'colorAnteLabel',     key: 'broadcast_ante_label_color' },
                  { labelKey: 'colorAnteValue',     key: 'broadcast_ante_value_color' },
                  { labelKey: 'colorNextLabel',     key: 'broadcast_next_label_color' },
                  { labelKey: 'colorNextValue',     key: 'broadcast_next_value_color' },
                  { labelKey: 'colorSidebarLabels', key: 'broadcast_sidebar_label_color' },
                  { labelKey: 'colorSidebarValues', key: 'broadcast_sidebar_value_color' },
                ].map(({ labelKey, key }) => (
                  <ColorField key={key} label={t(`broadcastSettings.${labelKey}`)} settingsKey={key} settings={settings} onChange={set} />
                ))}
              </div>
            </SectionCard>

            <SectionCard title={t('broadcastSettings.sectionVisibility')}>
              <div className="bs-toggle-grid">
                {[
                  { key: 'broadcast_show_logo',       labelKey: 'visLogo' },
                  { key: 'broadcast_show_club_logo',  labelKey: 'visClubLogo', padrao: 'Logo do clube' },
                  { key: 'broadcast_show_title',      labelKey: 'visTitle' },
                  { key: 'broadcast_show_prizepool',  labelKey: 'visPrizepool' },
                  { key: 'broadcast_show_level',      labelKey: 'visLevel' },
                  { key: 'broadcast_show_players',    labelKey: 'visPlayers' },
                  { key: 'broadcast_show_reentries',  labelKey: 'visReentries', padrao: 'Reentradas (recompras)' },
                  { key: 'broadcast_show_interval',   labelKey: 'visInterval' },
                  { key: 'broadcast_show_timer',      labelKey: 'visTimer' },
                  { key: 'broadcast_show_blinds',     labelKey: 'visBlinds' },
                  { key: 'broadcast_show_ante',       labelKey: 'visAnte' },
                  { key: 'broadcast_show_next_blind', labelKey: 'visNextBlind' },
                  { key: 'broadcast_show_prizes',     labelKey: 'visPrizes' },
                  { key: 'broadcast_show_chipcount',  labelKey: 'visChipcount' },
                  { key: 'broadcast_show_average',    labelKey: 'visAverage' },
                  { key: 'broadcast_blind_alerts_enabled', labelKey: 'blindAlertsEnabled' },
                ].map(({ key, labelKey, padrao }) => (
                  <label key={key} className={`bs-toggle ${settings[key] ? 'on' : 'off'}`}>
                    <input type="checkbox" checked={settings[key]} onChange={(e) => set(key, e.target.checked)} />
                    <span className="bs-toggle-track">
                      <span className="bs-toggle-thumb" />
                    </span>
                    <span className="bs-toggle-label">{padrao ? t(`broadcastSettings.${labelKey}`, padrao) : t(`broadcastSettings.${labelKey}`)}</span>
                  </label>
                ))}
              </div>
            </SectionCard>

            {/* ── Break Screen Colors ── */}
            <SectionCard icon={null} title={t('broadcastSettings.sectionBreakColors')}>
              <div className="bs-color-grid">
                {[
                  { labelKey: 'breakColorTimer',  key: 'broadcast_break_timer_color' },
                  { labelKey: 'breakColorTitle',  key: 'broadcast_break_title_color' },
                  { labelKey: 'breakColorLabels', key: 'broadcast_break_label_color' },
                  { labelKey: 'breakColorValues', key: 'broadcast_break_value_color' },
                ].map(({ labelKey, key }) => (
                  <ColorField key={key} label={t(`broadcastSettings.${labelKey}`)} settingsKey={key} settings={settings} onChange={set} />
                ))}
              </div>
            </SectionCard>

            <div className="bs-actions">
              <button type="button" className="bs-btn-cancel" onClick={() => navigate(`/torneios/${tournamentId}`)}>
                {t('common.cancel')}
              </button>
              <button type="button" className="bs-btn-save" onClick={handleSave} disabled={submitting}>
                {submitting ? (
                  <><span className="bs-save-spinner" /> {t('broadcastSettings.saving')}</>
                ) : (
                  <><span className="bs-save-icon">✓</span> {t('broadcastSettings.saveSettings')}</>
                )}
              </button>
            </div>

          </div>

        </div>
      </main>
    </div>
  );
};

export default BroadcastSettings;
