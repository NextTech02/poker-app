// Broadcast display labels for each supported language.
// Used by TournamentBroadcast.js and BroadcastSettings.js preview.

const BROADCAST_LABELS = {
  'pt-BR': {
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
    awards:         'PREMIAÇÕES',
    placeLabel:     (n) => `${n}º Lugar`,
    breakOverlay:   'INTERVALO',
    breakOverlayMsg:'O torneio está em intervalo',
    completed:      'ENCERRADO',
    totalPlayers:   'TOTAL DE JOGADORES',
    seat:           'VAGA',           // prêmio do tipo vaga (sem valor em dinheiro)
  },
  'en': {
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
    awards:         'AWARDS',
    placeLabel:     (n) => {
      const s = ['th', 'st', 'nd', 'rd'];
      const v = n % 100;
      return `${n}${s[(v - 20) % 10] || s[v] || s[0]} Place`;
    },
    breakOverlay:   'BREAK',
    breakOverlayMsg:'Tournament is on break',
    completed:      'COMPLETED',
    totalPlayers:   'TOTAL PLAYERS',
    seat:           'SEAT',
  },
  'es': {
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
    awards:         'PREMIOS',
    placeLabel:     (n) => `${n}º Puesto`,
    breakOverlay:   'DESCANSO',
    breakOverlayMsg:'El torneo está en descanso',
    completed:      'FINALIZADO',
    totalPlayers:   'TOTAL DE JUGADORES',
    seat:           'ENTRADA',
  },
};

export default BROADCAST_LABELS;
