/**
 * Dados de amostra para a prévia das Configurações. Mesmo formato que
 * `buildTvModel` devolve na TV de verdade — a prévia desenha exatamente a
 * tela que o salão vai ver, só que com números fictícios.
 */
export const SAMPLE_PRIZES = [
  { position: 1, prize_amount: 15000 },
  { position: 2, prize_amount: 7500 },
  { position: 3, prize_amount: 5000 },
  { position: 4, prize_amount: 3800 },
  { position: 5, prize_amount: 3000 },
];

export const sampleModel = ({
  tournamentName = 'Main Event',
  dayName = 'Dia 1A',
  organizationName = null,
  isBreak = false,
} = {}) => ({
  tournamentName,
  dayName,
  status: 'active',
  organizationName,
  isDayBased: true,
  level: 5,
  timeRemaining: 1210,
  levelDuration: 1500,
  isPaused: false,
  blinds: { sb: 100, bb: 200, ante: 200 },
  nextBlind: { level: 6, sb: 200, bb: 400, ante: 400, isBreak: false },
  isBreak,
  players: { active: 45, total: 120 },
  entries: 165,
  reentries: 6,
  chipcount: 1650000,
  averageStack: 36667,
  breakIn: 1112,
  prizes: SAMPLE_PRIZES,
  prizePool: 34300,
  totalPlayers: 120,
});
