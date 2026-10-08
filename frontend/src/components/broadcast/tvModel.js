/**
 * Modelo do telão: transforma o que a página tem (dia, torneio, relógio,
 * extras públicos) no objeto plano que `TvScreen` desenha.
 *
 * Separado da tela por dois motivos: a prévia das Configurações monta o mesmo
 * modelo com dados de amostra, e a lógica do ramo LEGADO (torneio sem dia,
 * contagem local) fica testável sem renderizar nada.
 */
import { TV_DEFAULT_SETTINGS, TV_COLOR_KEYS } from './tvDefaults';
import { nivelExibido } from '../../utils/nivelExibido';

export const extractYouTubeId = (url) => {
  if (!url) return null;
  const m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
};

/**
 * Que tipo de peça de divulgação é a URL: 'youtube', 'video' (arquivo direto)
 * ou 'image'. Nulo quando não há URL. O telão escolhe o elemento por aqui.
 */
export const promoKind = (url) => {
  const u = String(url || '').trim();
  if (!u) return null;
  if (extractYouTubeId(u)) return 'youtube';
  if (u.startsWith('data:video')) return 'video';
  const caminho = u.split(/[?#]/)[0].toLowerCase();
  if (/\.(mp4|webm|ogv|ogg|mov|m4v)$/.test(caminho)) return 'video';
  return 'image';
};

/** "MM:SS" — minutos sem teto (um nível de 75 min mostra 75:00). */
export const formatClock = (seconds) => {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
};

/** Contagem para o intervalo: "18:32", ou "1:20:00" quando passa de uma hora. */
export const formatCountdown = (seconds) => {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (s < 3600) return formatClock(s);
  const h = Math.floor(s / 3600);
  const rest = s % 3600;
  return `${h}:${String(Math.floor(rest / 60)).padStart(2, '0')}:${String(rest % 60).padStart(2, '0')}`;
};

export const formatChips = (n) => (Number(n) || 0).toLocaleString('pt-BR');

/** Escurece um hex (#rrggbb) — a 2ª parada do gradiente do selo de prêmios. */
export const shadeHex = (hex, amount = 0.18) => {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const f = (c) => Math.max(0, Math.min(255, Math.round(c * (1 - amount))));
  const r = f((n >> 16) & 255);
  const g = f((n >> 8) & 255);
  const b = f(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
};

/** Hex (#rrggbb) → rgba() com transparência; hex inválido volta como veio. */
export const alphaHex = (hex, alpha) => {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};

const color = (source, key) => source?.[key] || TV_DEFAULT_SETTINGS[key];
const on = (source, key) => source?.[key] !== false;   // nulo no banco = ligado
const num = (source, key) => source?.[key] ?? TV_DEFAULT_SETTINGS[key];

/**
 * Configurações do telão a partir da linha do dia (ou do torneio, no ramo
 * legado). Mesma semântica de sempre: campo nulo mantém o elemento LIGADO
 * (reentradas inclusive, desde o layout do cliente de 2026-10).
 */
export const buildTvSettings = (source, { fontSizeOverride = null } = {}) => {
  const s = source || {};
  const colors = {};
  TV_COLOR_KEYS.forEach((k) => {
    colors[k.replace('broadcast_', '')] = color(s, k);
  });
  return {
    bgColor: s.broadcast_bg_color || null,
    bgValue: s.broadcast_bg_image_url || null,
    bgOverlay: num(s, 'broadcast_bg_overlay'),
    displayName: s.broadcast_display_name || null,
    fontSize: fontSizeOverride ?? (s.broadcast_font_size || 100),
    prizeScale: (s.broadcast_prize_size || 100) / 100,
    prizepoolScale: (s.broadcast_prizepool_size || 100) / 100,
    showLogo: on(s, 'broadcast_show_logo'),
    clubLogoUrl: s.broadcast_club_logo_url || null,
    showClubLogo: on(s, 'broadcast_show_club_logo'),
    clubLogoSize: s.broadcast_club_logo_size ?? 100,
    // Divulgação na coluna da direita: imagem, vídeo direto ou YouTube.
    promoUrl: String(s.broadcast_promo_url || '').trim() || null,
    showPromo: on(s, 'broadcast_show_promo'),
    promoFit: s.broadcast_promo_fit === 'cover' ? 'cover' : 'contain',
    showTitle: on(s, 'broadcast_show_title'),
    showPrizepool: on(s, 'broadcast_show_prizepool'),
    showLevel: on(s, 'broadcast_show_level'),
    showPlayers: on(s, 'broadcast_show_players'),
    showReentries: on(s, 'broadcast_show_reentries'),
    showInterval: on(s, 'broadcast_show_interval'),
    showTimer: on(s, 'broadcast_show_timer'),
    showBlinds: on(s, 'broadcast_show_blinds'),
    showAnte: on(s, 'broadcast_show_ante'),
    showNextBlind: on(s, 'broadcast_show_next_blind'),
    showPrizes: on(s, 'broadcast_show_prizes'),
    showChipcount: on(s, 'broadcast_show_chipcount'),
    showAverage: on(s, 'broadcast_show_average'),
    prizesLayout: s.broadcast_prizes_layout === 'sidebar' ? 'sidebar' : 'bottom',
    language: s.broadcast_language || 'pt-BR',
    // Intervalo
    breakLayout: s.broadcast_break_layout || 'split',
    breakBgColor: s.broadcast_break_bg_color || null,
    breakBgValue: s.broadcast_break_bg_image_url || null,
    breakYoutubeUrl: s.broadcast_break_youtube_url || null,
    breakShowVideo: on(s, 'broadcast_break_show_video'),
    breakVideoMuted: on(s, 'broadcast_break_video_muted'),
    breakShowNextLevel: on(s, 'broadcast_break_show_next_level'),
    breakShowPlayers: on(s, 'broadcast_break_show_players'),
    breakShowChipcount: on(s, 'broadcast_break_show_chipcount'),
    breakShowAverage: on(s, 'broadcast_break_show_average'),
    breakOverlayOpacity: s.broadcast_break_overlay_opacity ?? 70,
    breakFontSize: s.broadcast_break_font_size ?? 100,
    colors: {
      timer: colors.timer_color,
      title: colors.title_color,
      blindsLabel: colors.blinds_label_color,
      blindsValue: colors.blinds_value_color,
      anteLabel: colors.ante_label_color,
      anteValue: colors.ante_value_color,
      nextLabel: colors.next_label_color,
      nextValue: colors.next_value_color,
      sidebarLabel: colors.sidebar_label_color,
      sidebarValue: colors.sidebar_value_color,
      prizepoolLabel: colors.prizepool_label_color,
      prizepoolValue: colors.prizepool_value_color,
      breakTimer: colors.break_timer_color,
      breakLabel: colors.break_label_color,
      breakValue: colors.break_value_color,
      breakTitle: colors.break_title_color,
    },
  };
};

// ── Ramo legado (torneio sem dia): blinds de uma lista local ────────────────

export const blindValuesAt = (blinds, level) => {
  if (!blinds || blinds.length === 0) {
    return { smallBlind: 0, bigBlind: 0, ante: 0, duration: 15 };
  }
  const blind = blinds.find((b) => b.level === level);
  if (blind) {
    return {
      smallBlind: blind.small_blind, bigBlind: blind.big_blind,
      ante: blind.ante || 0, duration: blind.duration || 15,
    };
  }
  const last = blinds[blinds.length - 1];
  return {
    smallBlind: last?.small_blind || 0, bigBlind: last?.big_blind || 0,
    ante: last?.ante || 0, duration: last?.duration || 15,
  };
};

/**
 * Monta o modelo que a tela desenha.
 *
 * Dia (`isDayBased`): o relógio enriquecido (`timerState`) é a FONTE ÚNICA —
 * nível, tempo, blinds, jogadores, chipcount. Legado: estado local da página.
 */
export const buildTvModel = ({
  isDayBased,
  timerState,
  tournament,
  tournamentDay,
  players = [],
  blinds = [],
  blindLevel = 1,
  timeRemaining = 0,
  legacyBreakIn = null,
  aggregatedStats = null,
  extras = null,
}) => {
  const live = isDayBased && timerState;

  let level; let remaining; let levelDuration = null; let isPaused = false;
  let sb; let bb; let ante; let isBreak = false; let nextBlind = null;

  if (live) {
    // `current_level` é a POSIÇÃO na estrutura (o intervalo ocupa uma). O que
    // a mesa lê é o número sem os intervalos — o mesmo da tela de blinds.
    level = nivelExibido(timerState, blinds, timerState.current_level);
    remaining = timerState.time_remaining_current_level;
    const dur = timerState.current_blind?.duration;
    levelDuration = Number.isFinite(Number(dur)) && Number(dur) > 0 ? Number(dur) * 60 : null;
    isPaused = timerState.is_paused === true;
    sb = timerState.current_blind?.small_blind || 0;
    bb = timerState.current_blind?.big_blind || 0;
    ante = timerState.current_blind?.ante || 0;
    isBreak = timerState.current_blind?.is_break === true;
    // Existe um próximo nível? No último da estrutura não existe, e sem esta
    // distinção o telão anunciava "0/0 (0)" — zero não é um blind.
    nextBlind = timerState.next_blind
      ? {
        // Número MOSTRADO do próximo nível, sem contar o intervalo.
        level: nivelExibido(timerState.next_blind, blinds, timerState.next_blind.level),
        sb: timerState.next_blind.small_blind || 0,
        bb: timerState.next_blind.big_blind || 0,
        ante: timerState.next_blind.ante || 0,
        isBreak: timerState.next_blind.is_break === true,
      }
      : null;
  } else {
    const cur = blindValuesAt(blinds, blindLevel);
    const nxt = blindValuesAt(blinds, blindLevel + 1);
    // `blindValuesAt` repete o ÚLTIMO nível quando se pede um além da lista;
    // para o "próximo", isso anunciaria o nível atual de novo. Só há próximo
    // se ele existe na estrutura.
    const hasNext = (blinds || []).some((b) => b.level === blindLevel + 1);
    level = nivelExibido({ level: blindLevel }, blinds, blindLevel);
    remaining = timeRemaining;
    levelDuration = (cur.duration || 0) * 60 || null;
    sb = cur.smallBlind; bb = cur.bigBlind; ante = cur.ante;
    nextBlind = hasNext && (nxt.bigBlind || 0) > 0
      ? {
        level: nivelExibido({ level: blindLevel + 1 }, blinds, blindLevel + 1),
        sb: nxt.smallBlind, bb: nxt.bigBlind, ante: nxt.ante, isBreak: false,
      }
      : null;
  }

  // Jogadores/entradas: no dia vêm do relógio enriquecido (entradas −
  // eliminações); no legado, da lista de inscritos.
  // Fora do dia: eliminado E cancelado (inscrição estornada não está na mesa).
  const activePlayers = live
    ? (timerState.active_players || 0)
    : players.filter((p) => p.status !== 'eliminated' && p.status !== 'cancelled').length;
  // ENTRADA = buy-in. Quem recompra voltou ao torneio, não entrou de novo.
  const entries = live
    ? (timerState.total_entries || 0)
    : players.reduce((sum, p) => sum + (p.buy_in_count || 0), 0);
  // REENTRADA = recompra. O add-on compra fichas para quem já está na mesa
  // e não traz ninguém de volta, então não conta (mesma regra do backend).
  const reentries = live
    ? (timerState.total_reentries || 0)
    : players.reduce((sum, p) => sum + (p.rebuy_count || 0), 0);
  const chipcount = live ? (timerState.chipcount || 0) : 0;
  const averageStack = live ? (timerState.average_stack || 0) : 0;

  // Dia final: o total é a soma dos classificatórios, não as entradas do dia.
  const isFinalDay = tournamentDay?.day_type === 'final' || players.some((p) => p.is_qualified_entry);
  let totalPlayers = entries;
  if (isFinalDay && aggregatedStats) {
    const qualifying = aggregatedStats.qualifying_days?.reduce(
      (sum, day) => sum + (day.total_players || 0), 0,
    ) || 0;
    if (qualifying > 0) totalPlayers = qualifying;
  }

  const breakIn = live
    ? (timerState.next_break ? timerState.next_break.time_until_break : null)
    : legacyBreakIn;

  const prizes = (extras?.prizes || []).filter((p) => p.visible !== false);
  const prizePool = parseFloat(extras?.prize_pool ?? tournamentDay?.prize_pool ?? 0) || 0;

  return {
    tournamentName: tournament?.name || '',
    dayName: tournamentDay?.day_name || null,
    status: tournamentDay?.status || tournament?.status || null,
    organizationName: extras?.organization_name || null,
    isDayBased: !!isDayBased,
    level,
    timeRemaining: remaining,
    levelDuration,
    isPaused,
    blinds: { sb, bb, ante },
    nextBlind,
    isBreak,
    players: { active: activePlayers, total: totalPlayers },
    entries,
    reentries,
    chipcount,
    averageStack,
    breakIn,
    prizes,
    prizePool,
    totalPlayers: players.length,
  };
};
