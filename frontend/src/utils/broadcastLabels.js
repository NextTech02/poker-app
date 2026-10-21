// Broadcast display labels for each supported language.
// Used by TournamentBroadcast.js and BroadcastSettings.js preview.

// 1st, 2nd, 3rd, 4th… 11th–13th são "th" (a exceção da casa das dezenas).
const ordinalEn = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
};

const BROADCAST_LABELS = {
  'pt-BR': {
    numberLocale:   'en-US',          // 1,000 — o cliente quer VÍRGULA de milhar em todo idioma (2026-10-09)
    level:          'NÍVEL',
    players:        'JOGADORES',
    entries:        'ENTRADAS',
    reentries:      'REENTRADAS',
    chipcount:      'CHIP COUNT',
    average:        'MÉDIA',
    intervalIn:     'INTERVALO EM',
    blinds:         'BLINDS',
    ante:           'ANTE',
    nextBlinds:     'PRÓXIMOS BLINDS',
    breakNext:      'INTERVALO',      // value shown when next blind is a break
    breakTitle:     'INTERVALO',      // break screen title
    next:           'PRÓXIMO',        // break screen next-level label
    levelPrefix:    'Nível',          // "Nível 6: ..."
    of:             'de',             // "45 de 120"
    prizepool:      'PRIZEPOOL',
    koPool:         'POOL KO',
    mysteryPool:    'POOL MYSTERY',
    mysteryStartsAt:'MYSTERY NO NÍVEL',
    envelopesLeft:  'ENVELOPES',
    relay:          'REVEZAMENTO',
    relayNext:      'PRÓXIMO',
    relayOut:       'ELIMINADA',
    awards:         'PREMIAÇÕES',
    placeLabel:     (n) => `${n}º Lugar`,
    placeRangeLabel:(a, b) => `${a}º–${b}º Lugar`,   // faixa: colocações consecutivas de mesmo prêmio
    breakOverlay:   'INTERVALO',
    breakOverlayMsg:'O torneio está em intervalo',
    completed:      'ENCERRADO',
    totalPlayers:   'TOTAL DE JOGADORES',
    seat:           'VAGA',           // prêmio do tipo vaga (sem valor em dinheiro)
    // Quadro de mesas e assentos (/tv/<código>/mesas)
    seatingTitle:   'MESAS E ASSENTOS',
    seatingPlayer:  'JOGADOR',
    seatingTable:   'MESA',
    seatingSeat:    'ASSENTO',
    seatingChips:   'FICHAS',
    seatingPage:    'Página',
    seatingEmpty:   'Os assentos ainda não foram sorteados',
    seatingOffline: 'Sem conexão — mostrando a última lista',
  },
  'en': {
    numberLocale:   'en-US',          // 1,000 — vírgula em todo idioma
    level:          'LEVEL',
    players:        'PLAYERS',
    entries:        'ENTRIES',
    reentries:      'RE-ENTRIES',
    chipcount:      'CHIP COUNT',
    average:        'AVERAGE',
    intervalIn:     'BREAK IN',
    blinds:         'BLINDS',
    ante:           'ANTE',
    nextBlinds:     'NEXT BLINDS',
    breakNext:      'BREAK',
    breakTitle:     'BREAK',
    next:           'NEXT',
    levelPrefix:    'Level',
    of:             'of',
    prizepool:      'PRIZEPOOL',
    koPool:         'KO POOL',
    mysteryPool:    'MYSTERY POOL',
    mysteryStartsAt:'MYSTERY AT LEVEL',
    envelopesLeft:  'ENVELOPES',
    relay:          'RELAY',
    relayNext:      'NEXT',
    relayOut:       'OUT',
    awards:         'AWARDS',
    placeLabel:     (n) => `${ordinalEn(n)} Place`,
    placeRangeLabel:(a, b) => `${ordinalEn(a)}–${ordinalEn(b)} Place`,
    breakOverlay:   'BREAK',
    breakOverlayMsg:'Tournament is on break',
    completed:      'COMPLETED',
    totalPlayers:   'TOTAL PLAYERS',
    seat:           'SEAT',
    seatingTitle:   'TABLES & SEATS',
    seatingPlayer:  'PLAYER',
    seatingTable:   'TABLE',
    seatingSeat:    'SEAT',
    seatingChips:   'CHIPS',
    seatingPage:    'Page',
    seatingEmpty:   'Seats have not been drawn yet',
    seatingOffline: 'Offline — showing the last list',
  },
  'es': {
    numberLocale:   'en-US',          // 1,000 — vírgula em todo idioma
    level:          'NIVEL',
    players:        'JUGADORES',
    entries:        'ENTRADAS',
    reentries:      'RECOMPRAS',
    chipcount:      'CHIP COUNT',
    average:        'PROMEDIO',
    intervalIn:     'DESCANSO EN',
    blinds:         'BLINDS',
    ante:           'ANTE',
    nextBlinds:     'SIGUIENTES BLINDS',
    breakNext:      'DESCANSO',
    breakTitle:     'DESCANSO',
    next:           'SIGUIENTE',
    levelPrefix:    'Nivel',
    of:             'de',
    prizepool:      'PRIZEPOOL',
    koPool:         'POZO KO',
    mysteryPool:    'POZO MYSTERY',
    mysteryStartsAt:'MYSTERY EN EL NIVEL',
    envelopesLeft:  'SOBRES',
    relay:          'RELEVOS',
    relayNext:      'SIGUIENTE',
    relayOut:       'ELIMINADO',
    awards:         'PREMIOS',
    placeLabel:     (n) => `${n}º Puesto`,
    placeRangeLabel:(a, b) => `${a}º–${b}º Puesto`,
    breakOverlay:   'DESCANSO',
    breakOverlayMsg:'El torneo está en descanso',
    completed:      'FINALIZADO',
    totalPlayers:   'TOTAL DE JUGADORES',
    seat:           'ENTRADA',
    seatingTitle:   'MESAS Y ASIENTOS',
    seatingPlayer:  'JUGADOR',
    seatingTable:   'MESA',
    seatingSeat:    'ASIENTO',
    seatingChips:   'FICHAS',
    seatingPage:    'Página',
    seatingEmpty:   'Los asientos aún no fueron sorteados',
    seatingOffline: 'Sin conexión — mostrando la última lista',
  },
};

/**
 * Rótulos para um código de idioma do APP (`pt-BR`, `en-US`, `es-ES`…): só a
 * língua importa, a região não. Desconhecido ou vazio cai no português — um
 * rótulo "undefined" na frente do salão é pior que o idioma errado.
 */
export const labelsForLanguage = (code) => {
  const lingua = String(code || '').trim().toLowerCase().split(/[-_]/)[0];
  if (lingua === 'en') return BROADCAST_LABELS.en;
  if (lingua === 'es') return BROADCAST_LABELS.es;
  return BROADCAST_LABELS['pt-BR'];
};

export default BROADCAST_LABELS;
