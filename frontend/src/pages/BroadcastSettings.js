import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import aceblindLogo from '../assets/aceblind-logo-white.png';
import './BroadcastSettings.css';

// ─────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  broadcast_bg_color: '#0a0e13',
  broadcast_bg_image_url: '',
  broadcast_display_name: '',
  broadcast_font_size: 100,
  broadcast_prize_size: 100,
  broadcast_prizepool_label_color: '#ffffff',
  broadcast_prizepool_value_color: '#ffffff',
  broadcast_prizepool_size: 100,
  broadcast_timer_color: '#5b5be8',
  broadcast_title_color: '#5b5be8',
  broadcast_blinds_label_color: '#5b5be8',
  broadcast_blinds_value_color: '#ffffff',
  broadcast_ante_label_color: '#5b5be8',
  broadcast_ante_value_color: '#5b5be8',
  broadcast_next_label_color: '#5b5be8',
  broadcast_next_value_color: '#9ca3af',
  broadcast_sidebar_label_color: '#9ca3af',
  broadcast_sidebar_value_color: '#5b5be8',
  broadcast_show_logo: true,
  broadcast_club_logo_url: '',
  broadcast_show_club_logo: true,
  broadcast_club_logo_size: 100,
  broadcast_show_title: true,
  broadcast_show_prizepool: true,
  broadcast_show_level: true,
  broadcast_show_players: true,
  // Padrao FALSE: o numero e novo, e liga-lo sozinho mudaria o telao de todos
  // os clubes sem ninguem ter pedido.
  broadcast_show_reentries: false,
  broadcast_show_interval: true,
  broadcast_show_timer: true,
  broadcast_show_blinds: true,
  broadcast_show_ante: true,
  broadcast_show_next_blind: true,
  broadcast_show_prizes: true,
  broadcast_show_chipcount: true,
  broadcast_show_average: true,
  broadcast_blind_alerts_enabled: true,
  broadcast_prizes_layout: 'bottom',
  // Break screen
  broadcast_break_layout:          'split',
  broadcast_break_bg_color:        '#0a0e13',
  broadcast_break_bg_image_url:    '',
  broadcast_break_youtube_url:     '',
  broadcast_break_show_video:      true,
  broadcast_break_video_muted:     true,
  broadcast_break_show_next_level: true,
  broadcast_break_show_players:    true,
  broadcast_break_show_chipcount:  true,
  broadcast_break_show_average:    true,
  broadcast_break_overlay_opacity: 70,
  broadcast_break_font_size:       100,
  broadcast_break_timer_color:     '#5b5be8',
  broadcast_break_label_color:     '#9ca3af',
  broadcast_break_value_color:     '#5b5be8',
  broadcast_break_title_color:     '#ffffff',
};

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

const SliderField = ({ label, settingsKey, min, max, settings, onChange }) => {
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
          step="10"
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
// Live preview
// ─────────────────────────────────────────────────────────────────
const PREVIEW_W = 1200;
const PREVIEW_H = 675;

const MOCK = {
  timer: '12:34',
  level: 5,
  sb: 500, bb: 1000, ante: 1000,
  nsb: 750, nbb: 1500, nante: 1500,
  active: 45, total: 120, entries: 165,
  prizePool: 15000,
  interval: '18:32',
  chipcount: '1.650.000',
  average: '36.667',
  // Break mock
  breakTimer: '15:00',
  breakNextLevel: 6,
  breakNextSb: 750, breakNextBb: 1500, breakNextAnte: 1500,
};

const extractYouTubeIdPreview = (url) => {
  if (!url) return null;
  const m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
};

const BroadcastPreview = ({ settings, displayName, notice, previewBreak }) => {
  const { formatCurrency } = useCurrency();
  const { t } = useTranslation();
  const wrapRef = useRef(null);
  const [scale, setScale] = useState(0.35);

  const computeScale = useCallback(() => {
    if (wrapRef.current) {
      setScale(wrapRef.current.offsetWidth / PREVIEW_W);
    }
  }, []);

  useEffect(() => {
    computeScale();
    const ro = new ResizeObserver(computeScale);
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, [computeScale]);

  const fs = settings.broadcast_font_size / 100;
  const pp = settings.broadcast_prizepool_size / 100;
  const ts = settings.broadcast_prize_size / 100;
  const barH = Math.round(48 * ts);

  const c = {
    timer:   settings.broadcast_timer_color,
    title:   settings.broadcast_title_color,
    blLabel: settings.broadcast_blinds_label_color,
    blVal:   settings.broadcast_blinds_value_color,
    aLabel:  settings.broadcast_ante_label_color,
    aVal:    settings.broadcast_ante_value_color,
    nLabel:  settings.broadcast_next_label_color,
    nVal:    settings.broadcast_next_value_color,
    sbLabel: settings.broadcast_sidebar_label_color,
    sbVal:   settings.broadcast_sidebar_value_color,
    ppLabel: settings.broadcast_prizepool_label_color,
    ppVal:   settings.broadcast_prizepool_value_color,
  };

  const containerStyle = {
    width: PREVIEW_W, height: PREVIEW_H,
    transform: `scale(${scale})`, transformOrigin: 'top left',
    position: 'absolute', top: 0, left: 0,
    display: 'flex', flexDirection: 'column',
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif",
    color: '#fff', overflow: 'hidden',
  };
  if (settings.broadcast_bg_image_url) {
    containerStyle.backgroundImage = `url(${settings.broadcast_bg_image_url})`;
    containerStyle.backgroundSize = 'cover';
    containerStyle.backgroundPosition = 'center';
  } else {
    containerStyle.background = settings.broadcast_bg_color || '#0a0e13';
  }

  const S = settings;
  const title = S.broadcast_display_name || displayName || t('broadcastSettings.previewMockTitle');

  // Break preview helpers
  const breakLayout  = S.broadcast_break_layout || 'split';
  const breakVideoId = extractYouTubeIdPreview(S.broadcast_break_youtube_url);
  const showBreakVid = S.broadcast_break_show_video && !!breakVideoId;
  const breakOpacity  = ((S.broadcast_break_overlay_opacity ?? 70) / 100).toFixed(2);
  const breakFontScale = (S.broadcast_break_font_size ?? 100) / 100;
  const breakMuteFlag = S.broadcast_break_video_muted !== false ? 1 : 0;
  const breakEmbedUrl = breakVideoId
    ? `https://www.youtube.com/embed/${breakVideoId}?autoplay=1&mute=${breakMuteFlag}&loop=1&playlist=${breakVideoId}&controls=0&modestbranding=1`
    : null;

  const breakBgStyle = showBreakVid
    ? {}
    : S.broadcast_break_bg_image_url
      ? { backgroundImage: `url(${S.broadcast_break_bg_image_url})`, backgroundSize: 'cover', backgroundPosition: 'center' }
      : { background: S.broadcast_break_bg_color || '#0a0e13' };

  const bfs = fs * breakFontScale; // combined preview scale × break font scale
  const BreakInfoPreview = () => (
    <div style={{ display: 'flex', flexDirection: breakLayout === 'fullscreen' ? 'row' : 'column', gap: breakLayout === 'fullscreen' ? 32 * bfs : 20 * bfs, ...(breakLayout === 'fullscreen' ? { justifyContent: 'center', alignItems: 'center', width: '100%' } : {}) }}>
      <div style={{ fontSize: breakLayout === 'fullscreen' ? 18 * bfs : 28 * bfs, fontWeight: 900, textTransform: 'uppercase', letterSpacing: 4, color: S.broadcast_break_title_color || '#fff' }}>
        {t('broadcastSettings.previewInterval')}
      </div>
      <div style={{ fontSize: breakLayout === 'fullscreen' ? 30 * bfs : 68 * bfs, fontWeight: 800, lineHeight: 1, color: S.broadcast_break_timer_color || '#5b5be8', fontVariantNumeric: 'tabular-nums' }}>
        {MOCK.breakTimer}
      </div>
      {S.broadcast_break_show_next_level !== false && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontSize: 9 * bfs, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, color: S.broadcast_break_label_color || '#9ca3af' }}>{t('broadcastSettings.previewNext')}</span>
          <span style={{ fontSize: breakLayout === 'fullscreen' ? 14 * bfs : 18 * bfs, fontWeight: 800, color: S.broadcast_break_value_color || '#5b5be8' }}>
            {t('broadcastSettings.previewLevel')} {MOCK.breakNextLevel}: {MOCK.breakNextSb.toLocaleString()}/{MOCK.breakNextBb.toLocaleString()} ( {MOCK.breakNextAnte.toLocaleString()} )
          </span>
        </div>
      )}
      {S.broadcast_break_show_players !== false && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontSize: 9 * bfs, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, color: S.broadcast_break_label_color || '#9ca3af' }}>{t('broadcastSettings.previewPlayers')}</span>
          <span style={{ fontSize: breakLayout === 'fullscreen' ? 14 * bfs : 18 * bfs, fontWeight: 800, color: S.broadcast_break_value_color || '#5b5be8' }}>{t('broadcastSettings.previewPlayersValue', { active: MOCK.active, total: MOCK.total })}</span>
        </div>
      )}
      {S.broadcast_break_show_chipcount !== false && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontSize: 9 * bfs, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, color: S.broadcast_break_label_color || '#9ca3af' }}>{t('broadcastSettings.previewChipCount')}</span>
          <span style={{ fontSize: breakLayout === 'fullscreen' ? 14 * bfs : 18 * bfs, fontWeight: 800, color: S.broadcast_break_value_color || '#5b5be8' }}>{MOCK.chipcount}</span>
        </div>
      )}
      {S.broadcast_break_show_average !== false && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontSize: 9 * bfs, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, color: S.broadcast_break_label_color || '#9ca3af' }}>{t('broadcastSettings.previewAverage')}</span>
          <span style={{ fontSize: breakLayout === 'fullscreen' ? 14 * bfs : 18 * bfs, fontWeight: 800, color: S.broadcast_break_value_color || '#5b5be8' }}>{MOCK.average}</span>
        </div>
      )}
    </div>
  );

  return (
    <div className="bpv-outer">
      <div ref={wrapRef} className="bpv-wrap">
        <div style={{ height: `${PREVIEW_H * scale}px`, position: 'relative' }}>
          <div style={containerStyle}>

            {/* ── Header (mirrors .broadcast-header) ── */}
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '24px 48px', flexShrink: 0,
              background: 'linear-gradient(180deg, rgba(20,25,34,0.95) 0%, rgba(10,14,19,0.8) 100%)',
              borderBottom: '3px solid #5b5be8',
              boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
            }}>
              {/* Logo — left */}
              <div style={{ display: 'flex', alignItems: 'center', minWidth: 250 }}>
                {S.broadcast_show_logo && (
                  <img src={aceblindLogo} alt="" style={{ height: 48, width: 'auto', filter: 'brightness(1.1)' }} />
                )}
              </div>
              {/* Title — center */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                {S.broadcast_show_title && (
                  <h1 style={{
                    margin: 0, fontSize: 42 * fs, fontWeight: 800,
                    textTransform: 'uppercase', letterSpacing: 3,
                    color: c.title, WebkitTextFillColor: c.title, backgroundImage: 'none',
                    textShadow: '0 4px 12px rgba(0,0,0,0.8)',
                  }}>
                    {title}
                  </h1>
                )}
              </div>
              {/* Logo do clube — right (mirrors .broadcast-club-logo) */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', minWidth: 250 }}>
                {S.broadcast_show_club_logo && S.broadcast_club_logo_url && (
                  <img
                    src={S.broadcast_club_logo_url}
                    alt=""
                    className="bs-preview-club-logo"
                    style={{ height: 48 * ((S.broadcast_club_logo_size || 100) / 100), width: 'auto', objectFit: 'contain' }}
                  />
                )}
              </div>
            </div>

            {/* ── Main: Break preview or normal ── */}
            {previewBreak ? (
              /* ── Break Screen Preview ── */
              <div style={{ flex: 1, display: 'flex', position: 'relative', overflow: 'hidden', ...breakBgStyle }}>
                {showBreakVid && (
                  <iframe src={breakEmbedUrl} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 'none', zIndex: 0 }} allow="autoplay; encrypted-media" allowFullScreen title="break-preview" />
                )}

                {breakLayout === 'split' && (
                  <>
                    <div style={{
                      width: 260, flexShrink: 0, padding: '40px 28px',
                      background: 'rgba(0,0,0,0.65)', borderRight: '2px solid #5b5be8',
                      display: 'flex', flexDirection: 'column', gap: 20, zIndex: 1,
                    }}>
                      <BreakInfoPreview />
                    </div>
                    <div style={{ flex: 1, position: 'relative', background: showBreakVid ? 'transparent' : 'rgba(255,255,255,0.03)' }}>
                      {!showBreakVid && (
                        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.2)', fontSize: 13 * fs }}>
                          {S.broadcast_break_youtube_url ? '▶ YouTube' : t('broadcastSettings.previewVideoImage')}
                        </div>
                      )}
                    </div>
                  </>
                )}

                {breakLayout === 'fullscreen' && (
                  <div style={{
                    position: 'absolute', bottom: 0, left: 0, right: 0,
                    background: `rgba(5,8,12,${breakOpacity})`, borderTop: '2px solid #5b5be8',
                    padding: '10px 40px', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1,
                  }}>
                    <BreakInfoPreview />
                  </div>
                )}

                {breakLayout === 'overlay' && (
                  <div style={{
                    position: 'absolute', left: 40, top: '50%', transform: 'translateY(-50%)',
                    background: `rgba(5,8,12,${breakOpacity})`, border: '1px solid rgba(91,91,232,0.4)',
                    borderRadius: 12, padding: '24px 22px', minWidth: 240, zIndex: 1,
                  }}>
                    <BreakInfoPreview />
                  </div>
                )}
              </div>
            ) : (
            /* ── Normal blinds preview ── */
            <div style={{ flex: 1, display: 'flex', position: 'relative', padding: '32px 48px', paddingBottom: barH + 32 }}>

              {/* Sidebar — absolute left (mirrors .broadcast-sidebar) */}
              {(S.broadcast_show_level || S.broadcast_show_players || S.broadcast_show_interval || S.broadcast_show_chipcount || S.broadcast_show_average) && (
                <div style={{ position: 'absolute', left: 48, top: 32, width: 200, display: 'flex', flexDirection: 'column', gap: 16 }}>
                  {S.broadcast_show_level && (
                    <div>
                      <div style={{ fontSize: 13 * fs, color: c.sbLabel, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1 }}>
                        {t('broadcastSettings.previewLevel')} {MOCK.level}
                      </div>
                    </div>
                  )}
                  {S.broadcast_show_players && (
                    <>
                      <div>
                        <div style={{ fontSize: 13 * fs, color: c.sbLabel, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>{t('broadcastSettings.previewPlayers')}</div>
                        <div style={{ fontSize: 32 * fs, fontWeight: 800, color: c.sbVal }}>{t('broadcastSettings.previewPlayersValue', { active: MOCK.active, total: MOCK.total })}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 13 * fs, color: c.sbLabel, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>{t('broadcastSettings.previewEntries')}</div>
                        <div style={{ fontSize: 32 * fs, fontWeight: 800, color: c.sbVal }}>{MOCK.entries}</div>
                      </div>
                      {S.broadcast_show_reentries && (
                        <div>
                          <div style={{ fontSize: 13 * fs, color: c.sbLabel, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>{t('broadcastSettings.previewReentries', 'Reentradas')}</div>
                          <div style={{ fontSize: 32 * fs, fontWeight: 800, color: c.sbVal }}>{MOCK.reentries ?? 6}</div>
                        </div>
                      )}
                    </>
                  )}
                  {S.broadcast_show_interval && (
                    <div>
                      <div style={{ fontSize: 13 * fs, color: c.sbLabel, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>{t('broadcastSettings.previewIntervalIn')}</div>
                      <div style={{ fontSize: 32 * fs, fontWeight: 800, color: c.sbVal }}>{MOCK.interval}</div>
                    </div>
                  )}
                  {S.broadcast_show_chipcount && (
                    <div>
                      <div style={{ fontSize: 13 * fs, color: c.sbLabel, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>{t('broadcastSettings.previewChipCount')}</div>
                      <div style={{ fontSize: 28 * fs, fontWeight: 800, color: c.sbVal }}>{MOCK.chipcount}</div>
                    </div>
                  )}
                  {S.broadcast_show_average && (
                    <div>
                      <div style={{ fontSize: 13 * fs, color: c.sbLabel, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>{t('broadcastSettings.previewAverage')}</div>
                      <div style={{ fontSize: 28 * fs, fontWeight: 800, color: c.sbVal }}>{MOCK.average}</div>
                    </div>
                  )}
                </div>
              )}

              {/* Center (mirrors .broadcast-center) */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', padding: 32 }}>
                {S.broadcast_show_timer && (
                  <div style={{
                    fontSize: 160 * fs, fontWeight: 800, color: c.timer,
                    textShadow: `0 4px 20px ${c.timer}80`,
                    marginBottom: 32, letterSpacing: 4, lineHeight: 1,
                  }}>
                    {MOCK.timer}
                  </div>
                )}
                {S.broadcast_show_blinds && (
                  <div style={{ marginBottom: 24, textAlign: 'center' }}>
                    <div style={{ fontSize: 16 * fs, color: c.blLabel, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>{t('broadcastSettings.previewBlinds')}</div>
                    <div style={{ fontSize: 80 * fs, fontWeight: 800, color: c.blVal, lineHeight: 1 }}>
                      {MOCK.sb.toLocaleString()}/{MOCK.bb.toLocaleString()}
                    </div>
                  </div>
                )}
                {S.broadcast_show_ante && (
                  <div style={{ marginBottom: 20, textAlign: 'center' }}>
                    <div style={{ fontSize: 14 * fs, color: c.aLabel, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>{t('broadcastSettings.previewAnte')}</div>
                    <div style={{ fontSize: 36 * fs, fontWeight: 700, color: c.aVal }}>{MOCK.ante.toLocaleString()}</div>
                  </div>
                )}
                {S.broadcast_show_next_blind && (
                  <div style={{ textAlign: 'center', marginTop: 16 }}>
                    <div style={{ fontSize: 14 * fs, color: c.nLabel, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>{t('broadcastSettings.previewNextBlinds')}</div>
                    <div style={{ fontSize: 24 * fs, fontWeight: 700, color: c.nVal }}>
                      {MOCK.nsb.toLocaleString()}/{MOCK.nbb.toLocaleString()} ( {MOCK.nante.toLocaleString()} )
                    </div>
                  </div>
                )}
              </div>
            </div>
            )} {/* end previewBreak ternary */}

            {/* ── Prizepool corner (mirrors .broadcast-prizepool-corner) ── */}
            {S.broadcast_show_prizepool && !previewBreak && (
              <div style={{
                position: 'absolute',
                bottom: (S.broadcast_prizes_layout === 'sidebar' || !S.broadcast_show_prizes) ? 12 : barH + 12,
                right: S.broadcast_prizes_layout === 'sidebar' && S.broadcast_show_prizes ? 280 : 48,
                textAlign: 'right', padding: '12px 24px',
              }}>
                <div style={{ fontSize: 13 * pp, color: c.ppLabel, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 6 }}>{t('broadcastSettings.previewPrizepool')}</div>
                <div style={{ fontSize: 32 * pp, fontWeight: 800, color: c.ppVal }}>{formatCurrency(MOCK.prizePool)}</div>
              </div>
            )}

            {/* ── Prize ticker (bottom) ── */}
            {S.broadcast_show_prizes && S.broadcast_prizes_layout !== 'sidebar' && !previewBreak && (
              <div style={{
                position: 'absolute', bottom: 0, left: 0, right: 0, height: barH,
                background: 'rgba(5,8,12,0.96)', borderTop: '2px solid #5b5be8',
                display: 'flex', alignItems: 'stretch', overflow: 'hidden',
              }}>
                <div style={{
                  flexShrink: 0, display: 'flex', alignItems: 'center',
                  padding: '0 2rem 0 1.25rem',
                  background: 'linear-gradient(135deg, #5b5be8 0%, #2525b9 100%)',
                  color: '#0a0e14', fontWeight: 900, fontSize: 12 * ts,
                  letterSpacing: 2, textTransform: 'uppercase', whiteSpace: 'nowrap',
                }}>
                  {t('broadcastSettings.previewPrizes')}
                </div>
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', overflow: 'hidden', gap: 32, paddingLeft: 24 }}>
                  {[1, 2, 3, 4, 5].map((pos) => (
                    <span key={pos} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }}>
                      <span style={{ fontSize: 14 * ts, color: '#fff', fontWeight: 700 }}>{pos}º {t('broadcastSettings.previewPlace')}</span>
                      <span style={{ color: '#3a5068', fontSize: 12 * ts }}>:</span>
                      <span style={{ fontSize: 16 * ts, color: '#fff', fontWeight: 800 }}>
                        {formatCurrency(Math.round(15000 / pos / 100) * 100)}
                      </span>
                      <span style={{ color: '#5b5be8', fontSize: 8 * ts, marginLeft: 8 }}>◆</span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* ── Prize sidebar (right column) ── */}
            {S.broadcast_show_prizes && S.broadcast_prizes_layout === 'sidebar' && !previewBreak && (
              <div style={{
                position: 'absolute', top: 100, right: 24, bottom: 24, width: 240,
                background: 'rgba(5,8,12,0.96)', border: '2px solid #5b5be8', borderRadius: 8,
                display: 'flex', flexDirection: 'column', overflow: 'hidden', zIndex: 50,
              }}>
                <div style={{
                  flexShrink: 0,
                  padding: '10px 16px',
                  background: 'linear-gradient(135deg, #5b5be8 0%, #2525b9 100%)',
                  color: '#0a0e14', fontWeight: 900, fontSize: 13 * ts,
                  letterSpacing: 2, textTransform: 'uppercase', textAlign: 'center',
                }}>
                  {t('broadcastSettings.previewPrizes')}
                </div>
                <div style={{ flex: 1, overflow: 'hidden', padding: '8px 12px' }}>
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((pos) => (
                    <div key={pos} style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                      padding: '6px 0', borderBottom: '1px solid rgba(91,91,232,0.15)',
                    }}>
                      <span style={{ fontSize: 13 * ts, color: '#9ca3af', fontWeight: 700 }}>{pos}º</span>
                      <span style={{ fontSize: 14 * ts, color: '#fff', fontWeight: 800 }}>
                        {formatCurrency(Math.round(15000 / pos / 100) * 100)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

          </div>
        </div>
      </div>
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
          broadcast_show_reentries:  d.broadcast_show_reentries  === true,
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
            displayName={`${tournamentName} — ${dayName}`}
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
                {settings.broadcast_bg_image_url ? (
                  <div className="bs-img-preview-wrap">
                    <img src={settings.broadcast_bg_image_url} alt="bg" className="bs-img-preview" />
                    <button type="button" className="bs-img-remove" onClick={() => set('broadcast_bg_image_url', '')}>×</button>
                  </div>
                ) : (
                  <label className="bs-upload-zone">
                    <input
                      type="file" accept="image/*" className="bs-hidden"
                      onChange={(e) => {
                        const file = e.target.files[0];
                        if (!file) return;
                        if (file.size > 2 * 1024 * 1024) { toast.warning(t('broadcastSettings.bgImageMaxSize')); return; }
                        const reader = new FileReader();
                        reader.onloadend = () => set('broadcast_bg_image_url', reader.result);
                        reader.readAsDataURL(file);
                      }}
                    />
                    <span className="bs-upload-plus">+</span>
                    <span className="bs-upload-main">{t('broadcastSettings.bgImageUpload')}</span>
                    <span className="bs-upload-sub">{t('broadcastSettings.bgImageUploadHint')}</span>
                  </label>
                )}
                <div className="bs-url-row">
                  <span className="bs-or-label">{t('broadcastSettings.bgImageUrlLabel')}</span>
                  <input
                    type="text"
                    value={settings.broadcast_bg_image_url?.startsWith('data:') ? '' : settings.broadcast_bg_image_url}
                    onChange={(e) => set('broadcast_bg_image_url', e.target.value)}
                    placeholder={t('broadcastSettings.bgImageUrlPlaceholder')}
                    disabled={settings.broadcast_bg_image_url?.startsWith('data:')}
                    className="bs-input"
                  />
                </div>
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
                  { key: 'broadcast_show_reentries',  labelKey: 'visReentries', padrao: 'Reentradas (recompras e add-ons)' },
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
