import React, { useLayoutEffect, useRef, useState } from 'react';
import aceblindLogo from '../../assets/aceblind-logo-white.png';
import Icon from '../Icon';
import BROADCAST_LABELS from '../../utils/broadcastLabels';
import { formatCurrency } from '../../utils/currencyUtils';
import { resolveBackground } from './tvBackgrounds';
import {
  buildTvSettings, extractYouTubeId, formatClock, formatCountdown, formatChips, shadeHex, alphaHex,
} from './tvModel';
import './TvScreen.css';

/**
 * A tela do telão, só apresentação.
 *
 * Recebe um `model` (ver `buildTvModel`) e as `settings` (ver
 * `buildTvSettings`) e desenha num palco de 1920×1080 (`TvStage`). É a MESMA
 * tela para a TV do salão e para a prévia das Configurações: a prévia passa
 * dados de amostra, a TV passa o relógio real.
 *
 * Layout (mockup do cliente, 2026-10): cabeçalho com título entre filetes e
 * marca do clube à direita; coluna de tiles encostada na borda esquerda;
 * relógio gigante dentro de um anel de progresso do nível, centrado na TELA;
 * blinds e próximo nível abaixo; barra de prêmios no rodapé, de borda a
 * borda. Cores por CSS custom properties (`--tv-*`), preenchidas pelas
 * colunas `broadcast_*_color` do dia.
 */

const RING_R = 46;
export const RING_C = 2 * Math.PI * RING_R;

const ringProgress = (model) => {
  if (!model.levelDuration) return 0;
  const p = 1 - (Number(model.timeRemaining) || 0) / model.levelDuration;
  if (!Number.isFinite(p)) return 0;
  return Math.min(1, Math.max(0, p));
};

const prizeText = (prize, L, currency) => {
  const amount = Number(prize.prize_amount) || 0;
  if (prize.prize_type === 'vaga' && amount <= 0) return L.seat;
  return formatCurrency(amount, currency);
};

// ── Cabeçalho ───────────────────────────────────────────────────────────────

const TvHeader = ({ model, settings }) => {
  const custom = !!settings.displayName;
  return (
    <header className="tv-header">
      <div className="tv-header-side tv-header-left">
        {settings.showLogo && (
          <div className="tv-logo">
            <img src={aceblindLogo} alt="AceBlind" className="tv-logo-img" />
          </div>
        )}
      </div>
      <div className="tv-header-center">
        {settings.showTitle && (
          <div className="tv-title">
            <span className="tv-rule" aria-hidden="true" />
            <h1 className={`tv-title-text${custom ? ' tv-title-text--custom' : ''}`}>
              {custom ? settings.displayName : (
                <>
                  <span className="tv-title-main">{model.tournamentName}</span>
                  {model.dayName && (
                    <>
                      <span className="tv-title-sep"> - </span>
                      <span className="tv-title-day">{model.dayName}</span>
                    </>
                  )}
                </>
              )}
            </h1>
            <span className="tv-rule" aria-hidden="true" />
          </div>
        )}
      </div>
      <div className="tv-header-side tv-header-right">
        {/* A div fica SEMPRE montada, mesmo sem logo: é ela que reserva o
            espaço que mantém o título centralizado. */}
        <div className="tv-club-logo" style={{ '--club-logo-scale': (settings.clubLogoSize || 100) / 100 }}>
          {settings.showClubLogo && settings.clubLogoUrl ? (
            <img src={settings.clubLogoUrl} alt="" className="tv-club-logo-img" />
          ) : (
            model.organizationName ? <span className="tv-club-name">{model.organizationName}</span> : null
          )}
        </div>
      </div>
    </header>
  );
};

// ── Tiles (coluna esquerda) ─────────────────────────────────────────────────

const Tile = ({ icon, label, value, kind, inline = false }) => (
  <div className={`tv-tile tv-tile--${kind}${inline ? ' tv-tile--inline' : ''}`}>
    <span className="tv-tile-icon"><Icon name={icon} /></span>
    <span className="tv-tile-text">
      <span className="tv-tile-label">{label}</span>
      <span className="tv-tile-value">{value}</span>
    </span>
  </div>
);

/**
 * Os tiles seguem a estrutura do mockup do cliente: cada um que está ligado
 * aparece SEMPRE, mesmo valendo zero ("Entradas 0", "Reentradas 0"). Antes o
 * zero sumia o tile, e o cliente, com as reentradas ligadas, não as via — e a
 * coluna mudava de forma conforme o torneio andava.
 */
const buildTiles = (model, settings, L) => {
  const tiles = [];
  if (settings.showLevel) {
    // "NÍVEL 5" numa linha só, como no mockup.
    tiles.push({ kind: 'level', icon: 'trophy-cup', label: L.level, value: model.level, inline: true });
  }
  if (settings.showPlayers) {
    tiles.push({
      kind: 'players', icon: 'users', label: L.players,
      value: `${model.players.active} ${L.of} ${model.players.total}`,
    });
    tiles.push({ kind: 'entries', icon: 'ticket', label: L.entries, value: model.entries || 0 });
  }
  if (settings.showReentries) {
    tiles.push({ kind: 'reentries', icon: 'refresh', label: L.reentries, value: model.reentries || 0 });
  }
  if (settings.showInterval && model.breakIn !== null && model.breakIn !== undefined) {
    tiles.push({ kind: 'break', icon: 'clock', label: L.intervalIn, value: formatCountdown(model.breakIn) });
  }
  if (model.isDayBased && settings.showChipcount && model.chipcount > 0) {
    tiles.push({ kind: 'chips', icon: 'chips', label: L.chipcount, value: formatChips(model.chipcount) });
  }
  if (model.isDayBased && settings.showAverage && model.averageStack > 0) {
    tiles.push({ kind: 'average', icon: 'chart', label: L.average, value: formatChips(model.averageStack) });
  }
  return tiles;
};

// ── Ao vivo: tiles + relógio ────────────────────────────────────────────────

const TvLive = ({ model, settings, L }) => {
  const tiles = buildTiles(model, settings, L);
  const progress = ringProgress(model);
  const { sb, bb, ante } = model.blinds;
  const anteShown = settings.showAnte && ante > 0;
  const nb = model.nextBlind;
  let nextText = '—';
  if (nb) {
    nextText = nb.isBreak ? L.breakNext : `${nb.sb}/${nb.bb}${nb.ante > 0 ? ` (${nb.ante})` : ''}`;
  }

  return (
    <div className={`tv-live${tiles.length === 0 ? ' tv-live--no-tiles' : ''}`}>
      {tiles.length > 0 && (
        <aside className="tv-tiles">
          {tiles.map((tile) => <Tile key={tile.kind} {...tile} />)}
        </aside>
      )}

      <main className="tv-center">
        <div className={`tv-clock-wrap${model.isPaused ? ' tv-clock-wrap--paused' : ''}`}>
          {settings.showTimer && (
            <svg className="tv-ring" viewBox="0 0 100 100" aria-hidden="true">
              <circle className="tv-ring-track" cx="50" cy="50" r={RING_R} />
              <circle
                className="tv-ring-progress"
                cx="50" cy="50" r={RING_R}
                strokeDasharray={RING_C}
                strokeDashoffset={RING_C * (1 - progress)}
              />
            </svg>
          )}
          <div className="tv-clock-content">
            {settings.showTimer && (
              <div className="tv-clock">{formatClock(model.timeRemaining)}</div>
            )}

            {(settings.showBlinds || anteShown) && (
              <div className="tv-blinds-block">
                <div className="tv-blinds-label">{anteShown ? L.ante : L.blinds}</div>
                <div className="tv-blinds-line">
                  {settings.showBlinds && <span className="tv-blinds">{sb}/{bb}</span>}
                  {anteShown && (
                    <span className="tv-ante">{settings.showBlinds ? ` (${ante})` : ante}</span>
                  )}
                </div>
              </div>
            )}

            {settings.showNextBlind && (
              <div className="tv-next">
                <span className="tv-next-label">{L.next}:</span>
                <span className="tv-next-value">{nextText}</span>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
};

// ── Prêmios ─────────────────────────────────────────────────────────────────

const PrizeGroup = React.forwardRef(({ prizes, L, currency }, ref) => (
  <span className="tv-prizes-group" ref={ref}>
    {prizes.map((p, i) => (
      <React.Fragment key={`${p.position}-${i}`}>
        {i > 0 && <span className="tv-prize-sep" aria-hidden="true" />}
        <span className="tv-prize-item">
          <span className="tv-prize-pos">{L.placeLabel(p.position)}</span>
          <span className="tv-prize-colon">:</span>
          <span className="tv-prize-val">{prizeText(p, L, currency)}</span>
        </span>
      </React.Fragment>
    ))}
  </span>
));

/** Faixa inferior: só rola quando a lista não cabe na largura. */
const PrizeTrack = ({ prizes, L, currency, forceScroll }) => {
  const wrapRef = useRef(null);
  const groupRef = useRef(null);
  const [overflow, setOverflow] = useState(false);

  useLayoutEffect(() => {
    const measure = () => {
      const wrap = wrapRef.current;
      const group = groupRef.current;
      if (!wrap || !group) return;
      setOverflow(group.scrollWidth > wrap.clientWidth + 1);
    };
    measure();
    let observer = null;
    if (typeof ResizeObserver !== 'undefined' && wrapRef.current) {
      observer = new ResizeObserver(measure);
      observer.observe(wrapRef.current);
    }
    return () => { if (observer) observer.disconnect(); };
  }, [prizes]);

  const scrolling = forceScroll || overflow;
  return (
    <div className="tv-prizes-track-wrap" ref={wrapRef}>
      <div
        className={`tv-prizes-track${scrolling ? ' scrolling' : ''}`}
        style={scrolling ? { animationDuration: `${prizes.length * 5}s` } : undefined}
      >
        <PrizeGroup ref={groupRef} prizes={prizes} L={L} currency={currency} />
        {scrolling && <span className="tv-prize-sep" aria-hidden="true" />}
        {scrolling && <PrizeGroup prizes={prizes} L={L} currency={currency} />}
      </div>
    </div>
  );
};

const TvPrizes = ({ model, settings, L, currency, forceScroll }) => {
  const prizes = settings.showPrizes ? model.prizes : [];
  if (!settings.showPrizepool && prizes.length === 0) return null;

  const pool = settings.showPrizepool ? (
    <div className="tv-pool">
      <span className="tv-pool-label">{L.prizepool}</span>
      <span className="tv-pool-value">{formatCurrency(model.prizePool, currency)}</span>
    </div>
  ) : null;

  if (settings.prizesLayout === 'sidebar') {
    // Mais de 8 faixas não cabem paradas; a lista é duplicada para o laço.
    const scrolling = prizes.length > 8;
    const items = scrolling ? [...prizes, ...prizes] : prizes;
    return (
      <aside className="tv-prizes-sidebar">
        <div className="tv-prizes-sidebar-header">
          <Icon name="trophy-cup" />
          <span>{L.awards}</span>
        </div>
        {pool}
        {prizes.length > 0 && (
          <div className="tv-prizes-sidebar-wrap">
            <div
              className={`tv-prizes-sidebar-list${scrolling ? ' scrolling' : ''}`}
              style={scrolling ? { animationDuration: `${prizes.length * 4}s` } : undefined}
            >
              {items.map((p, i) => (
                <div key={`${p.position}-${i}`} className="tv-prizes-sidebar-row">
                  <span className="tv-prize-pos">{L.placeLabel(p.position)}</span>
                  <span className="tv-prize-val">{prizeText(p, L, currency)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </aside>
    );
  }

  return (
    <div className="tv-prizes-bar">
      <div className="tv-prizes-label">
        <Icon name="trophy-cup" />
        <span>{L.awards}</span>
      </div>
      {pool}
      {prizes.length > 0 && (
        <PrizeTrack prizes={prizes} L={L} currency={currency} forceScroll={forceScroll} />
      )}
    </div>
  );
};

// ── Intervalo ───────────────────────────────────────────────────────────────

const BREAK_LAYOUTS = ['split', 'fullscreen', 'overlay'];

const TvBreak = ({ model, settings, L }) => {
  const layout = BREAK_LAYOUTS.includes(settings.breakLayout) ? settings.breakLayout : 'split';
  const videoId = extractYouTubeId(settings.breakYoutubeUrl);
  const showVid = settings.breakShowVideo && !!videoId;
  const opacity = ((settings.breakOverlayOpacity ?? 70) / 100).toFixed(2);
  const bg = showVid ? null : resolveBackground(settings.breakBgValue, settings.breakBgColor, 0);
  const muteFlag = settings.breakVideoMuted !== false ? 1 : 0;
  const embedUrl = videoId
    ? `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=${muteFlag}&loop=1&playlist=${videoId}&controls=0&modestbranding=1`
    : null;
  const nb = model.nextBlind;

  const info = (
    <div className="tv-break-info">
      <div className="tv-break-title">{L.breakTitle}</div>
      <div className="tv-break-timer">{formatClock(model.timeRemaining)}</div>

      {settings.breakShowNextLevel && nb && (
        <div className="tv-break-stat">
          <span className="tv-break-stat-label">{L.next}</span>
          <span className="tv-break-stat-value">
            {L.levelPrefix} {nb.level}: {formatChips(nb.sb)}/{formatChips(nb.bb)}
            {nb.ante > 0 && ` (${formatChips(nb.ante)})`}
          </span>
        </div>
      )}
      {settings.breakShowPlayers && (
        <div className="tv-break-stat">
          <span className="tv-break-stat-label">{L.players}</span>
          <span className="tv-break-stat-value">{model.players.active} {L.of} {model.players.total}</span>
        </div>
      )}
      {settings.breakShowChipcount && model.chipcount > 0 && (
        <div className="tv-break-stat">
          <span className="tv-break-stat-label">{L.chipcount}</span>
          <span className="tv-break-stat-value">{formatChips(model.chipcount)}</span>
        </div>
      )}
      {settings.breakShowAverage && model.averageStack > 0 && (
        <div className="tv-break-stat">
          <span className="tv-break-stat-label">{L.average}</span>
          <span className="tv-break-stat-value">{formatChips(model.averageStack)}</span>
        </div>
      )}
    </div>
  );

  const style = {
    ...(bg ? bg.style : {}),
    '--tv-break-fs': (settings.breakFontSize ?? 100) / 100,
    '--tv-break-overlay': opacity,
  };
  const video = (cls) => (
    <iframe
      className={cls}
      src={embedUrl}
      allow="autoplay; encrypted-media"
      allowFullScreen
      title="break-video"
    />
  );

  if (layout === 'split') {
    return (
      <section className="tv-break split" style={style}>
        {info}
        <div className="tv-break-video-wrap">
          {showVid ? video('tv-break-video') : <div className="tv-break-video-placeholder" />}
        </div>
      </section>
    );
  }
  if (layout === 'fullscreen') {
    return (
      <section className="tv-break fullscreen" style={style}>
        {showVid && video('tv-break-video-bg')}
        <div className="tv-break-bottom-bar">{info}</div>
      </section>
    );
  }
  return (
    <section className="tv-break overlay" style={style}>
      {showVid && video('tv-break-video-bg')}
      <div className="tv-break-overlay-panel">{info}</div>
    </section>
  );
};

// ── Encerrado ───────────────────────────────────────────────────────────────

const TvCompleted = ({ model, L }) => (
  <section className="tv-completed">
    <div className="tv-completed-icon"><Icon name="trophy-cup" /></div>
    <div className="tv-completed-title">{L.completed}</div>
    <div className="tv-completed-stats">
      <div className="tv-completed-stat">
        <span className="tv-completed-label">{L.totalPlayers}</span>
        <span className="tv-completed-value">{model.totalPlayers}</span>
      </div>
    </div>
  </section>
);

// ── Tela ────────────────────────────────────────────────────────────────────

const TvScreen = ({
  mode = 'live',
  model,
  settings,
  labels,
  currency = 'BRL',
  fontScale,
  forceScroll = false,
  className = '',
}) => {
  const s = settings || buildTvSettings(null);
  const L = labels || BROADCAST_LABELS[s.language] || BROADCAST_LABELS['pt-BR'];
  const fs = fontScale ?? (s.fontSize || 100) / 100;
  const c = s.colors;
  const accent = c.sidebarValue;

  const vars = {
    '--tv-font': fs,
    '--tv-prize': s.prizeScale,
    '--tv-pool': s.prizepoolScale,
    '--tv-accent': accent,
    '--tv-accent-deep': shadeHex(accent),
    // Bordas e brilhos na cor de destaque, translúcidos (barra de prêmios).
    '--tv-accent-soft': alphaHex(accent, 0.55),
    '--tv-accent-glow': alphaHex(accent, 0.12),
    '--tv-c-timer': c.timer,
    '--tv-c-title': c.title,
    '--tv-c-blinds-label': c.blindsLabel,
    '--tv-c-blinds-value': c.blindsValue,
    '--tv-c-ante-label': c.anteLabel,
    '--tv-c-ante-value': c.anteValue,
    '--tv-c-next-label': c.nextLabel,
    '--tv-c-next-value': c.nextValue,
    '--tv-c-tile-label': c.sidebarLabel,
    '--tv-c-tile-value': c.sidebarValue,
    '--tv-c-pool-label': c.prizepoolLabel,
    '--tv-c-pool-value': c.prizepoolValue,
    '--tv-c-break-timer': c.breakTimer,
    '--tv-c-break-label': c.breakLabel,
    '--tv-c-break-value': c.breakValue,
    '--tv-c-break-title': c.breakTitle,
  };

  const prizesAllowed = mode !== 'break';
  const hasPrizeContent = s.showPrizepool || (s.showPrizes && model.prizes.length > 0);
  const sidebarPrizes = prizesAllowed && s.prizesLayout === 'sidebar' && hasPrizeContent;
  const bottomPrizes = prizesAllowed && s.prizesLayout !== 'sidebar' && hasPrizeContent;

  const classes = [
    'tv-screen',
    `tv-screen--${mode}`,
    sidebarPrizes ? 'tv-screen--with-sidebar' : '',
    bottomPrizes ? 'tv-screen--with-bar' : '',
    className,
  ].filter(Boolean).join(' ');

  let body;
  if (mode === 'completed') body = <TvCompleted model={model} L={L} />;
  else if (mode === 'break') body = <TvBreak model={model} settings={s} L={L} />;
  else body = <TvLive model={model} settings={s} L={L} />;

  return (
    <div className={classes} style={vars}>
      <TvHeader model={model} settings={s} />
      <div className="tv-body">
        {body}
        {sidebarPrizes && (
          <TvPrizes model={model} settings={s} L={L} currency={currency} forceScroll={forceScroll} />
        )}
      </div>
      {bottomPrizes && (
        <TvPrizes model={model} settings={s} L={L} currency={currency} forceScroll={forceScroll} />
      )}
    </div>
  );
};

export default TvScreen;
