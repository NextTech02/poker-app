/**
 * Modelo do telão: o relógio enriquecido é a fonte única no dia; no ramo
 * legado (torneio sem dia) a conta é local. É aqui que se fixa a semântica
 * que a tela só desenha: entradas ≠ recompras, "sem próximo nível" ≠ "0/0",
 * campo nulo no banco = elemento LIGADO.
 */
import {
  buildTvModel, buildTvSettings, blindValuesAt, formatClock, formatCountdown, formatChips,
  shadeHex, extractYouTubeId,
} from './tvModel';
import { TV_ACCENT, TV_DEFAULT_SETTINGS } from './tvDefaults';

const relogio = (extra = {}) => ({
  current_level: 4,
  time_remaining_current_level: 305,
  is_paused: false,
  current_blind: { level: 4, small_blind: 500, big_blind: 1000, ante: 1000, duration: 20, is_break: false },
  next_blind: { level: 5, small_blind: 800, big_blind: 1600, ante: 1600, is_break: false },
  active_players: 18,
  total_entries: 25,
  total_reentries: 3,
  chipcount: 750000,
  average_stack: 41666,
  ...extra,
});

const TORNEIO = { id: 't1', name: 'Main Event', status: 'active' };
const DIA = { id: 'x1', tournament_id: 't1', day_name: 'Dia 1A', status: 'active', prize_pool: 30000 };
const BLINDS = [
  { level: 1, small_blind: 100, big_blind: 200, ante: 0, duration: 20 },
  { level: 2, small_blind: 200, big_blind: 400, ante: 200, duration: 20 },
];
const INSCRITOS = [
  { player_id: 'p1', status: 'active', buy_in_count: 1, rebuy_count: 1 },
  { player_id: 'p2', status: 'eliminated', buy_in_count: 1, rebuy_count: 0 },
];

describe('buildTvModel — dia (relógio enriquecido)', () => {
  const base = { isDayBased: true, timerState: relogio(), tournament: TORNEIO, tournamentDay: DIA };

  it('nível, tempo, blinds e duração do nível vêm do relógio', () => {
    const m = buildTvModel(base);
    expect(m.level).toBe(4);
    expect(m.timeRemaining).toBe(305);
    expect(m.levelDuration).toBe(1200);      // 20 min, para o anel
    expect(m.blinds).toEqual({ sb: 500, bb: 1000, ante: 1000 });
    expect(m.nextBlind).toEqual({ level: 5, sb: 800, bb: 1600, ante: 1600, isBreak: false });
    expect(m.isBreak).toBe(false);
  });

  it('o intervalo não conta como nível: usa o display_level do servidor', () => {
    // 800/1600 é o "Nível 9" na tela de blinds, mas ocupa a POSIÇÃO 10 na
    // estrutura (há um intervalo antes). A mesa lê o número sem intervalos.
    const m = buildTvModel({
      ...base,
      timerState: relogio({
        current_level: 10, display_level: 9,
        current_blind: { level: 10, display_level: 9, small_blind: 800, big_blind: 1600, ante: 1600, duration: 20 },
        next_blind: { level: 11, display_level: 10, small_blind: 1000, big_blind: 2000, ante: 2000 },
      }),
    });
    expect(m.level).toBe(9);
    expect(m.nextBlind.level).toBe(10);
  });

  it('sem display_level, conta na estrutura em cache pulando os intervalos', () => {
    const comIntervalo = [
      { level: 1, small_blind: 100, big_blind: 200, ante: 0, duration: 20 },
      { level: 2, small_blind: 0, big_blind: 0, ante: 0, duration: 10, is_break: true },
      { level: 3, small_blind: 200, big_blind: 400, ante: 200, duration: 20 },
    ];
    const m = buildTvModel({
      ...base,
      blinds: comIntervalo,
      timerState: relogio({
        current_level: 3,
        current_blind: { level: 3, small_blind: 200, big_blind: 400, ante: 200, duration: 20 },
        next_blind: null,
      }),
    });
    expect(m.level).toBe(2);
  });

  it('sem duração no relógio o anel não tem base (null, nunca NaN)', () => {
    const m = buildTvModel({ ...base, timerState: relogio({ current_blind: { small_blind: 1, big_blind: 2 } }) });
    expect(m.levelDuration).toBeNull();
  });

  it('jogadores, entradas e recompras são números distintos', () => {
    const m = buildTvModel(base);
    expect(m.players).toEqual({ active: 18, total: 25 });
    expect(m.entries).toBe(25);
    expect(m.reentries).toBe(3);
    expect(m.chipcount).toBe(750000);
    expect(m.averageStack).toBe(41666);
  });

  it('sem próximo nível o modelo diz null (a tela mostra "—", não "0/0")', () => {
    expect(buildTvModel({ ...base, timerState: relogio({ next_blind: null }) }).nextBlind).toBeNull();
  });

  it('intervalo à vista vira contagem; sem intervalo, null', () => {
    expect(buildTvModel({ ...base, timerState: relogio({ next_break: { time_until_break: 1800 } }) }).breakIn).toBe(1800);
    expect(buildTvModel(base).breakIn).toBeNull();
  });

  it('dia final soma os classificatórios no total', () => {
    const m = buildTvModel({
      ...base,
      tournamentDay: { ...DIA, day_type: 'final' },
      aggregatedStats: { qualifying_days: [{ total_players: 120 }, { total_players: 80 }] },
    });
    expect(m.players.total).toBe(200);
  });

  it('prêmios vêm dos extras públicos, sem os invisíveis; pool dos extras ou do dia', () => {
    const extras = {
      organization_name: 'Clube', currency: 'PEN', prize_pool: 45000,
      prizes: [{ position: 1, prize_amount: 20000 }, { position: 2, prize_amount: 10000, visible: false }],
    };
    const m = buildTvModel({ ...base, extras });
    expect(m.prizes.map((p) => p.position)).toEqual([1]);
    expect(m.prizePool).toBe(45000);
    expect(m.organizationName).toBe('Clube');
    expect(buildTvModel({ ...base, extras: { prizes: [] } }).prizePool).toBe(30000);
    expect(buildTvModel(base).prizePool).toBe(30000);
  });

  it('título e status', () => {
    const m = buildTvModel(base);
    expect(m.tournamentName).toBe('Main Event');
    expect(m.dayName).toBe('Dia 1A');
    expect(m.status).toBe('active');
    expect(m.isDayBased).toBe(true);
  });
});

describe('buildTvModel — legado (torneio sem dia)', () => {
  const base = {
    isDayBased: false, timerState: null, tournament: TORNEIO, tournamentDay: null,
    players: INSCRITOS, blinds: BLINDS, blindLevel: 1, timeRemaining: 600,
  };

  it('blinds da lista local e o próximo nível pela posição seguinte', () => {
    const m = buildTvModel(base);
    expect(m.level).toBe(1);
    expect(m.timeRemaining).toBe(600);
    expect(m.levelDuration).toBe(1200);
    expect(m.blinds).toEqual({ sb: 100, bb: 200, ante: 0 });
    expect(m.nextBlind).toEqual({ level: 2, sb: 200, bb: 400, ante: 200, isBreak: false });
  });

  it('no último nível não existe próximo', () => {
    expect(buildTvModel({ ...base, blindLevel: 2 }).nextBlind).toBeNull();
  });

  it('jogadores vêm da lista: 1 ativo de 2 entradas; recompra não é entrada', () => {
    const m = buildTvModel(base);
    expect(m.players).toEqual({ active: 1, total: 2 });
    expect(m.entries).toBe(2);
    expect(m.reentries).toBe(1);
    expect(m.chipcount).toBe(0);
  });

  it('contagem para o intervalo vem da página', () => {
    expect(buildTvModel({ ...base, legacyBreakIn: 900 }).breakIn).toBe(900);
  });

  it('sem dia o título é só o torneio', () => {
    const m = buildTvModel(base);
    expect(m.dayName).toBeNull();
    expect(m.isDayBased).toBe(false);
  });
});

describe('blindValuesAt', () => {
  it('lista vazia devolve zeros', () => {
    expect(blindValuesAt([], 1)).toEqual({ smallBlind: 0, bigBlind: 0, ante: 0, duration: 15 });
  });
  it('nível além da lista repete o último', () => {
    expect(blindValuesAt(BLINDS, 9).bigBlind).toBe(400);
  });
});

describe('buildTvSettings', () => {
  it('campo nulo no banco mantém tudo LIGADO; só reentradas nasce desligada', () => {
    const s = buildTvSettings({});
    expect(s.showTimer).toBe(true);
    expect(s.showPrizepool).toBe(true);
    expect(s.showReentries).toBe(false);
    expect(buildTvSettings({ broadcast_show_reentries: true }).showReentries).toBe(true);
    expect(buildTvSettings({ broadcast_show_timer: false }).showTimer).toBe(false);
  });

  it('cores nulas caem no dourado padrão; cor salva vence', () => {
    const s = buildTvSettings({ broadcast_timer_color: null, broadcast_title_color: '#ff0000' });
    expect(s.colors.timer).toBe(TV_DEFAULT_SETTINGS.broadcast_timer_color);
    expect(s.colors.sidebarValue).toBe(TV_ACCENT);
    expect(s.colors.title).toBe('#ff0000');
  });

  it('fonte local vence a do servidor; escalas em fração', () => {
    expect(buildTvSettings({ broadcast_font_size: 120 }).fontSize).toBe(120);
    expect(buildTvSettings({ broadcast_font_size: 120 }, { fontSizeOverride: 90 }).fontSize).toBe(90);
    expect(buildTvSettings({ broadcast_prize_size: 150 }).prizeScale).toBe(1.5);
    expect(buildTvSettings({}).prizepoolScale).toBe(1);
  });

  it('fundo, escurecimento e layout dos prêmios', () => {
    const s = buildTvSettings({ broadcast_bg_image_url: 'preset:navy', broadcast_bg_overlay: 0, broadcast_prizes_layout: 'sidebar' });
    expect(s.bgValue).toBe('preset:navy');
    expect(s.bgOverlay).toBe(0);                   // zero é válido, não vira 45
    expect(s.prizesLayout).toBe('sidebar');
    expect(buildTvSettings({}).bgOverlay).toBe(45);
    expect(buildTvSettings({ broadcast_prizes_layout: 'qualquer' }).prizesLayout).toBe('bottom');
  });

  it('nulo inteiro não quebra', () => {
    expect(buildTvSettings(null).language).toBe('pt-BR');
  });
});

describe('formatadores', () => {
  it('relógio MM:SS sem teto de minutos', () => {
    expect(formatClock(305)).toBe('05:05');
    expect(formatClock(4500)).toBe('75:00');
    expect(formatClock(-3)).toBe('00:00');
    expect(formatClock(undefined)).toBe('00:00');
  });
  it('contagem para o intervalo passa a h:mm:ss depois de uma hora', () => {
    expect(formatCountdown(1112)).toBe('18:32');
    expect(formatCountdown(4800)).toBe('1:20:00');
  });
  it('fichas em pt-BR', () => {
    expect(formatChips(1650000)).toBe('1.650.000');
  });
  it('shadeHex escurece e tolera lixo', () => {
    expect(shadeHex('#ffffff', 0.5)).toBe('#808080');
    expect(shadeHex('lixo')).toBe('lixo');
  });
  it('extractYouTubeId', () => {
    expect(extractYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractYouTubeId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractYouTubeId('https://exemplo.com/video')).toBeNull();
    expect(extractYouTubeId(null)).toBeNull();
  });
});
