/**
 * Padrões do telão (tela de transmissão).
 *
 * Uma fonte só para a TV (`TournamentBroadcast`) e para a prévia das
 * Configurações (`BroadcastSettings`): antes cada uma tinha a sua cópia e, a
 * cada mudança de paleta, uma das duas ficava para trás.
 *
 * NULL no banco significa "padrão do app" — é este objeto que decide. O
 * layout é desenhado num palco fixo de 1920×1080 e escalado para a tela real
 * (720p, 1080p, 4K ou a prévia de 1200px): todos os tamanhos em px do CSS se
 * referem a esse palco.
 */

export const STAGE_W = 1920;
export const STAGE_H = 1080;

// Dourado sobre marinho — o visual escolhido pelo cliente (2026-10).
export const TV_ACCENT = '#f2cc5c';
export const TV_ACCENT_DEEP = '#d9a622';
export const TV_BG = '#0b1020';
export const TV_TEXT = '#ffffff';
export const TV_LABEL = '#f3f4f6';

export const TV_DEFAULT_SETTINGS = {
  broadcast_bg_color: TV_BG,
  broadcast_bg_image_url: '',
  broadcast_bg_overlay: 45,
  broadcast_display_name: '',
  broadcast_font_size: 100,
  // Título em separado (%), multiplicado pela fonte geral.
  broadcast_title_size: 100,
  broadcast_prize_size: 100,
  broadcast_prizepool_label_color: TV_LABEL,
  broadcast_prizepool_value_color: TV_ACCENT,
  broadcast_prizepool_size: 100,
  broadcast_timer_color: TV_TEXT,
  broadcast_title_color: TV_ACCENT,
  broadcast_blinds_label_color: TV_LABEL,
  broadcast_blinds_value_color: TV_TEXT,
  broadcast_ante_label_color: TV_LABEL,
  broadcast_ante_value_color: TV_TEXT,
  broadcast_next_label_color: TV_LABEL,
  // No mockup o próximo nível é dourado dentro da pílula ("Next: 200/400").
  broadcast_next_value_color: TV_ACCENT,
  broadcast_sidebar_label_color: TV_LABEL,
  // O valor dos tiles é a cor de DESTAQUE do tema inteiro: anel do relógio,
  // filetes do título, ícones e selo de prêmios seguem esta.
  broadcast_sidebar_value_color: TV_ACCENT,
  broadcast_show_logo: true,
  broadcast_club_logo_url: '',
  broadcast_show_club_logo: true,
  broadcast_club_logo_size: 100,
  // Divulgação na coluna da direita (imagem, vídeo direto ou YouTube).
  broadcast_promo_url: '',
  broadcast_show_promo: true,
  broadcast_promo_fit: 'contain',
  // Meios de entrada (valores) abaixo dos blinds: elemento novo, nasce desligado.
  broadcast_show_buy_types: false,
  // Faixa animada "Jogador eliminado" na parte de baixo: nasce desligada.
  broadcast_show_eliminations: false,
  // Tile "Entradas" (contagem) — interruptor próprio, ligado como sempre foi.
  broadcast_show_entries: true,
  broadcast_show_title: true,
  broadcast_show_prizepool: true,
  broadcast_show_level: true,
  broadcast_show_players: true,
  // Ligado desde 2026-10: o layout do cliente tem o tile "Reentradas" fixo
  // (migração `broadcast_show_reentries_default_on`).
  broadcast_show_reentries: true,
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
  // Tela de intervalo
  broadcast_break_layout: 'split',
  broadcast_break_bg_color: TV_BG,
  broadcast_break_bg_image_url: '',
  broadcast_break_youtube_url: '',
  broadcast_break_show_video: true,
  broadcast_break_video_muted: true,
  broadcast_break_show_next_level: true,
  broadcast_break_show_players: true,
  broadcast_break_show_chipcount: true,
  broadcast_break_show_average: true,
  broadcast_break_overlay_opacity: 70,
  broadcast_break_font_size: 100,
  broadcast_break_timer_color: TV_TEXT,
  broadcast_break_label_color: TV_LABEL,
  broadcast_break_value_color: TV_ACCENT,
  broadcast_break_title_color: TV_ACCENT,
};

// Colunas de cor: `||` no fallback (string vazia = padrão), nunca `??`.
export const TV_COLOR_KEYS = Object.keys(TV_DEFAULT_SETTINGS).filter((k) => k.endsWith('_color'));
