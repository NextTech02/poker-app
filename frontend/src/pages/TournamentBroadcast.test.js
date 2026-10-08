/**
 * Transmissão — a tela projetada no telão do salão.
 *
 * Ninguém opera essa tela: ela é lida de longe, por jogadores, durante horas.
 * Isso muda o que importa nos testes:
 *
 * - **A rota aceita DIA ou TORNEIO.** O mesmo `/broadcast/:id` serve os dois;
 *   a sondagem inicial em `/tournament-days/:id` recebe 404 quando o id é de
 *   um torneio, e isso é caminho normal, não erro.
 * - **Blinds nunca podem faltar.** Se o dia não tem estrutura própria, cai na
 *   do torneio; se nem essa existe, a estrutura é gerada da configuração. Um
 *   telão em branco no meio do nível é pior do que uma estrutura aproximada.
 * - **Cada elemento é ligável/desligável** pela configuração da transmissão, e
 *   os padrões precisam ser "ligado" — um campo ainda nulo no banco não pode
 *   apagar o relógio do salão.
 * - **Faixa de prêmio com `visible=false` some do público** sem o dado ser
 *   apagado: é como o clube esconde a premiação antes da hora.
 *
 * No intervalo a tela inteira troca de layout, porque o que interessa passa a
 * ser quanto falta para voltar.
 */
import { render, screen, waitFor, act, within, fireEvent } from '@testing-library/react';
import TournamentBroadcast from './TournamentBroadcast';
import api from '../config/api';
import { useTimerSync } from '../hooks/useTimerSync';
import { useCurrency } from '../contexts/CurrencyContext';

jest.mock('../config/api', () => ({ __esModule: true, default: { get: jest.fn(), patch: jest.fn() } }));
jest.mock('../hooks/usePolling', () => ({ usePolling: jest.fn() }));
jest.mock('../hooks/useTimerSync', () => ({
  useTimerSync: jest.fn(),
  formatTime: (s) => `${Math.floor((s || 0) / 60)}:${String((s || 0) % 60).padStart(2, '0')}`,
  formatTimeHuman: (s) => `${Math.round((s || 0) / 60)}min`,
}));
jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useParams: () => ({ id: 'x1' }),
}));
jest.mock('react-i18next', () => {
  const t = (chave) => chave;
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const DIA = {
  id: 'x1', tournament_id: 't1', day_name: 'Dia 1A', status: 'active',
  day_type: 'starting', prize_pool: 30000,
};

const TORNEIO = { id: 't1', name: 'Main Event', status: 'active' };

const LOGO = 'https://cdn.exemplo.com/clube.png';

const BLINDS = [
  { level: 1, small_blind: 100, big_blind: 200, ante: 0, duration: 20 },
  { level: 2, small_blind: 200, big_blind: 400, ante: 200, duration: 20 },
];

const PREMIOS = [
  { position: 1, prize_amount: 20000, visible: true },
  { position: 2, prize_amount: 10000, visible: true },
];

const RESUMO = { available_prize_pool: 45000 };

const INSCRITOS = [
  { player_id: 'p1', status: 'active', buy_in_count: 1, rebuy_count: 1 },
  { player_id: 'p2', status: 'eliminated', buy_in_count: 1, rebuy_count: 0 },
];

const relogio = (extra = {}) => ({
  current_level: 4,
  time_remaining_current_level: 305,
  current_blind: { level: 4, small_blind: 500, big_blind: 1000, ante: 1000, is_break: false },
  next_blind: { level: 5, small_blind: 800, big_blind: 1600, ante: 1600, is_break: false },
  active_players: 18,
  total_entries: 25,
  chipcount: 750000,
  average_stack: 41666,
  ...extra,
});

/**
 * O id da rota pode ser de DIA ou de TORNEIO. `comoDia:false` faz a sondagem
 * em /tournament-days/:id falhar, que é exatamente o que o servidor devolve
 * quando o id é de um torneio.
 */
const responder = ({
  comoDia = true,
  dia = DIA,
  torneio = TORNEIO,
  blindsDoDia = BLINDS,
  blindsDoTorneio = BLINDS,
  premios = PREMIOS,
  resumo = RESUMO,
  inscritos = INSCRITOS,
  estatisticas = null,
} = {}) => {
  api.get.mockImplementation((url) => {
    const ok = (data) => Promise.resolve({ data });
    const naoAchou = () => Promise.reject(new Error('404'));
    if (url === '/tournament-days/x1') return comoDia ? ok(dia) : naoAchou();
    if (url === '/tournament-days/x1/blinds') {
      return blindsDoDia instanceof Error ? Promise.reject(blindsDoDia) : ok(blindsDoDia);
    }
    if (url === '/tournaments/t1/blinds' || url === '/tournaments/x1/blinds') {
      return blindsDoTorneio instanceof Error ? Promise.reject(blindsDoTorneio) : ok(blindsDoTorneio);
    }
    if (url === '/tournaments/t1' || url === '/tournaments/x1') {
      return torneio instanceof Error ? Promise.reject(torneio) : ok(torneio);
    }
    if (url.startsWith('/tournament-players/')) return ok(inscritos);
    if (url.endsWith('/prizes')) {
      return premios instanceof Error ? Promise.reject(premios) : ok(premios);
    }
    if (url.endsWith('/prizes/summary')) return ok(resumo);
    if (url.endsWith('/aggregated-stats')) {
      return estatisticas instanceof Error ? Promise.reject(estatisticas) : ok(estatisticas);
    }
    return ok([]);
  });
};

const montar = async (opcoes = {}, estadoRelogio = relogio()) => {
  responder(opcoes);
  useTimerSync.mockReturnValue({ timerState: estadoRelogio });
  render(<TournamentBroadcast />);
  await waitFor(() => expect(screen.queryByText('common.loading')).toBeNull());
};

const barraLateral = () => document.querySelector('.broadcast-sidebar');

let bipes;

beforeEach(() => {
  jest.useRealTimers();
  localStorage.clear();
  api.patch.mockReset();
  bipes = [];
  useCurrency.mockReturnValue({ formatCurrency: (v) => `R$ ${Number(v || 0).toFixed(2)}` });
  // O alerta sonoro do fim de nível: só interessa SE tocou, não como soa.
  global.AudioContext = jest.fn(() => ({
    currentTime: 0,
    createOscillator: () => ({
      connect: () => {},
      start: (t) => bipes.push(t),
      stop: () => {},
      frequency: { setValueAtTime: () => {} },
      type: '',
    }),
    createGain: () => ({
      connect: () => {},
      gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
    }),
    destination: {},
  }));
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => console.error.mockRestore());

describe('a rota serve dia OU torneio', () => {
  it('id de dia mostra torneio e dia juntos no título', async () => {
    await montar();
    expect(screen.getByRole('heading')).toHaveTextContent('Main Event - Dia 1A');
  });

  it('id de torneio mostra só o nome do torneio', async () => {
    // A sondagem em /tournament-days/:id devolve 404 e isso é caminho normal.
    await montar({ comoDia: false });
    expect(screen.getByRole('heading')).toHaveTextContent('Main Event');
    expect(screen.getByRole('heading')).not.toHaveTextContent('Dia 1A');
  });

  it('um nome personalizado substitui os dois', async () => {
    await montar({ dia: { ...DIA, broadcast_display_name: 'FINAL TABLE' } });
    expect(screen.getByRole('heading')).toHaveTextContent('FINAL TABLE');
  });

  it('enquanto carrega mostra o aviso de carregamento', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    useTimerSync.mockReturnValue({ timerState: null });
    render(<TournamentBroadcast />);
    expect(screen.getByText('common.loading')).toBeInTheDocument();
  });

  it('falha total vira uma mensagem, não uma tela preta', async () => {
    await montar({ comoDia: false, torneio: new Error('500') });
    expect(screen.getByText('common.error')).toBeInTheDocument();
  });
});

describe('estrutura de blinds nunca falta', () => {
  it('usa a estrutura do próprio dia quando existe', async () => {
    await montar();
    expect(api.get).toHaveBeenCalledWith('/tournament-days/x1/blinds', { _silentError: true });
  });

  it('dia sem estrutura cai na do torneio', async () => {
    // Um Dia 2 herdando a estrutura do torneio é o caso comum.
    await montar({ blindsDoDia: [] });
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/tournaments/t1/blinds', { _silentError: true })
    );
  });

  it('sem estrutura nenhuma, ela é gerada da configuração do dia', async () => {
    // Telão em branco no meio do nível é pior do que estrutura aproximada.
    await montar(
      {
        blindsDoDia: [],
        blindsDoTorneio: [],
        dia: { ...DIA, initial_small_blind: 50, initial_big_blind: 100, blind_duration: 20 },
      },
      null
    );
    expect(screen.getByText('50/100')).toBeInTheDocument();
  });

  it('erro ao buscar blinds também gera a estrutura', async () => {
    await montar({ blindsDoDia: new Error('500'), dia: { ...DIA, initial_small_blind: 25 } }, null);
    expect(document.querySelector('.blinds-value')).toBeInTheDocument();
  });

  it.each([
    ['double', '50/100'],
    ['triple', '75/150'],
    ['1.5x', '38/75'],
  ])('o crescimento %s define o nível seguinte (%s)', async (tipo, esperado) => {
    // O tipo de crescimento é o que separa um turbo de um regular.
    await montar(
      {
        blindsDoDia: [],
        blindsDoTorneio: [],
        dia: {
          ...DIA, initial_small_blind: 25, initial_big_blind: 50,
          blind_increase_type: tipo, status: 'pending',
        },
      },
      null
    );
    expect(document.querySelector('.next-blind-value')).toHaveTextContent(esperado);
  });
});

describe('o que a tela mostra ao vivo', () => {
  it('o relógio é a fonte única quando o id é de um dia', async () => {
    await montar();
    expect(document.querySelector('.timer-display')).toHaveTextContent('5:05');
    expect(document.querySelector('.blinds-value')).toHaveTextContent('500/1000');
    expect(document.querySelector('.ante-value')).toHaveTextContent('1000');
  });

  it('mostra o nível atual', async () => {
    await montar();
    expect(barraLateral()).toHaveTextContent('4');
  });

  it('mostra restantes e total de entradas', async () => {
    await montar();
    expect(barraLateral()).toHaveTextContent('18');
    expect(barraLateral()).toHaveTextContent('25');
  });

  it('sem entrada nenhuma a linha de entradas some', async () => {
    // "Entradas: 0" antes do torneio começar não informa nada.
    await montar({}, relogio({ total_entries: 0 }));
    expect(barraLateral()).not.toHaveTextContent('ENTRADAS');
  });

  it('mostra chipcount e stack médio formatados', async () => {
    await montar();
    expect(barraLateral()).toHaveTextContent('750.000');
    expect(barraLateral()).toHaveTextContent('41.666');
  });

  it('chipcount zerado não ocupa espaço no telão', async () => {
    await montar({}, relogio({ chipcount: 0, average_stack: 0 }));
    expect(barraLateral()).not.toHaveTextContent('CHIPCOUNT');
  });

  it('quando há intervalo à vista, ele aparece na lateral', async () => {
    await montar({}, relogio({ next_break: { time_until_break: 1800 } }));
    expect(barraLateral()).toHaveTextContent('30min');
  });

  it('o próximo nível é anunciado', async () => {
    await montar();
    expect(document.querySelector('.next-blind-value')).toHaveTextContent('800/1600 ( 1600 )');
  });

  it('se o próximo nível é INTERVALO, o telão diz isso', async () => {
    // "800/1600" seguido de um intervalo confundiria a mesa.
    await montar({}, relogio({ next_blind: { is_break: true } }));
    expect(document.querySelector('.next-blind-value')).toHaveTextContent('BROADCAST.BREAK');
  });

  it('sem relógio ainda, a contagem local assume', async () => {
    // O nível local vem do tempo decorrido desde o início: começando agora,
    // o torneio está no nível 1.
    await montar({ comoDia: false, torneio: { ...TORNEIO, start_time: new Date().toISOString() } }, null);
    expect(document.querySelector('.blinds-value')).toHaveTextContent('100/200');
  });

  it('em torneio sem dia, os jogadores vêm da lista', async () => {
    // 2 buy-ins e 1 recompra: 1 jogador ainda em jogo e 2 ENTRADAS.
    // A recompra nao vira entrada — quem recompra voltou ao torneio, nao
    // entrou nele de novo.
    await montar({ comoDia: false }, null);
    expect(barraLateral()).toHaveTextContent('1');
    expect(barraLateral()).toHaveTextContent('2');
  });
});

describe('premiação exibida', () => {
  it('mostra o prizepool do resumo', async () => {
    await montar();
    expect(document.querySelector('.broadcast-prizepool-corner')).toHaveTextContent('R$ 45000.00');
  });

  it('sem resumo cai no prize pool do dia', async () => {
    await montar({ resumo: {} });
    expect(document.querySelector('.broadcast-prizepool-corner')).toHaveTextContent('R$ 30000.00');
  });

  it('faixa marcada como invisível some do público', async () => {
    // É como o clube segura a premiação antes da hora, sem apagar o dado.
    await montar({
      premios: [
        { position: 1, prize_amount: 20000, visible: true },
        { position: 2, prize_amount: 10000, visible: false },
      ],
    });
    const faixa = document.querySelector('.prize-ticker-bar');
    expect(faixa).toHaveTextContent('R$ 20000.00');
    expect(faixa).not.toHaveTextContent('R$ 10000.00');
  });

  it('falha ao carregar prêmios não derruba o telão', async () => {
    await montar({ premios: new Error('500') });
    expect(document.querySelector('.prize-ticker-bar')).toBeNull();
    expect(document.querySelector('.timer-display')).toBeInTheDocument();
  });

  it('o layout lateral troca a faixa por uma coluna', async () => {
    await montar({ dia: { ...DIA, broadcast_prizes_layout: 'sidebar' } });
    expect(document.querySelector('.prize-sidebar')).toBeInTheDocument();
    expect(document.querySelector('.prize-ticker-bar')).toBeNull();
  });

  it('lista longa na coluna entra em rolagem', async () => {
    // Mais de 8 faixas não cabem paradas; a lista é duplicada para o laço.
    const muitos = Array.from({ length: 10 }, (_, i) => ({
      position: i + 1, prize_amount: 100 * (10 - i), visible: true,
    }));
    await montar({ premios: muitos, dia: { ...DIA, broadcast_prizes_layout: 'sidebar' } });
    expect(document.querySelector('.prize-sidebar-list')).toHaveClass('scrolling');
    expect(document.querySelectorAll('.prize-sidebar-row').length).toBe(20);
  });

  it('lista curta na coluna fica parada', async () => {
    await montar({ dia: { ...DIA, broadcast_prizes_layout: 'sidebar' } });
    expect(document.querySelector('.prize-sidebar-list')).not.toHaveClass('scrolling');
    expect(document.querySelectorAll('.prize-sidebar-row').length).toBe(2);
  });
});

describe('o que pode ser desligado', () => {
  it.each([
    ['broadcast_show_timer', '.timer-display'],
    ['broadcast_show_blinds', '.blinds-section'],
    ['broadcast_show_ante', '.ante-section'],
    ['broadcast_show_next_blind', '.next-blind-section'],
    ['broadcast_show_prizepool', '.broadcast-prizepool-corner'],
    ['broadcast_show_prizes', '.prize-ticker-bar'],
    ['broadcast_show_logo', '.broadcast-logo'],
    ['broadcast_show_title', '.broadcast-title'],
    // A logo do clube só some se ELA existir: sem a URL o teste passaria à toa.
    ['broadcast_show_club_logo', '.broadcast-club-logo-img', { broadcast_club_logo_url: LOGO }],
  ])('%s desligado esconde %s', async (campo, seletor, extra = {}) => {
    await montar({ dia: { ...DIA, ...extra, [campo]: false } });
    expect(document.querySelector(seletor)).toBeNull();
  });

  it('campo ainda nulo no banco mantém tudo ligado', async () => {
    // Um dia criado antes dessas configurações existirem não pode apagar o
    // relógio do salão.
    await montar({ dia: { id: 'x1', tournament_id: 't1', day_name: 'Dia 1A', status: 'active' } });
    expect(document.querySelector('.timer-display')).toBeInTheDocument();
    expect(document.querySelector('.broadcast-prizepool-corner')).toBeInTheDocument();
  });

  it('desligar tudo da lateral remove a lateral inteira', async () => {
    await montar({
      dia: {
        ...DIA,
        broadcast_show_level: false, broadcast_show_players: false,
        broadcast_show_interval: false, broadcast_show_chipcount: false,
        broadcast_show_average: false,
      },
    });
    expect(barraLateral()).toBeNull();
  });

  it('a configuração do DIA tem precedência sobre a do torneio', async () => {
    // Cada dia pode ter seu visual; o do torneio é só o padrão.
    await montar({
      dia: { ...DIA, broadcast_show_timer: false },
      torneio: { ...TORNEIO, broadcast_show_timer: true },
    });
    expect(document.querySelector('.timer-display')).toBeNull();
  });

  it('em torneio sem dia, vale a configuração do torneio', async () => {
    await montar({ comoDia: false, torneio: { ...TORNEIO, broadcast_show_timer: false } }, null);
    expect(document.querySelector('.timer-display')).toBeNull();
  });
});

describe('logo do clube', () => {
  const logoDoClube = () => document.querySelector('.broadcast-club-logo-img');
  const espacoDaLogo = () => document.querySelector('.broadcast-club-logo');

  it('a logo configurada aparece no canto direito do cabeçalho', async () => {
    // É a marca do clube no telão do salão, ao lado da nossa.
    await montar({ dia: { ...DIA, broadcast_club_logo_url: LOGO } });
    expect(logoDoClube()).toHaveAttribute('src', LOGO);
    expect(document.querySelector('.broadcast-header')).toContainElement(logoDoClube());
  });

  it('sem logo cadastrada o espaço continua reservado', async () => {
    // O espaço é o que mantém o título centralizado; se ele sumisse, o nome do
    // torneio sairia do meio do telão.
    await montar();
    expect(logoDoClube()).toBeNull();
    expect(espacoDaLogo()).toBeInTheDocument();
  });

  it('o tamanho escolhido vira escala no espaço da logo', async () => {
    await montar({ dia: { ...DIA, broadcast_club_logo_url: LOGO, broadcast_club_logo_size: 200 } });
    expect(espacoDaLogo().style.getPropertyValue('--club-logo-scale')).toBe('2');
  });

  it('sem tamanho salvo a logo fica no tamanho da nossa (100%)', async () => {
    await montar({ dia: { ...DIA, broadcast_club_logo_url: LOGO } });
    expect(espacoDaLogo().style.getPropertyValue('--club-logo-scale')).toBe('1');
  });

  it('dia antigo, sem nenhuma das colunas novas, não quebra o telão', async () => {
    await montar({ dia: { id: 'x1', tournament_id: 't1', day_name: 'Dia 1A', status: 'active' } });
    expect(logoDoClube()).toBeNull();
    expect(document.querySelector('.timer-display')).toBeInTheDocument();
  });

  it('depois de encerrado a logo do clube continua no telão', async () => {
    // O cabeçalho é duplicado no código; é aqui que se percebe se um dos dois
    // ficou para trás.
    await montar({ dia: { ...DIA, status: 'completed', broadcast_club_logo_url: LOGO } });
    expect(document.querySelector('.broadcast-completed')).toBeInTheDocument();
    expect(logoDoClube()).toHaveAttribute('src', LOGO);
  });
});

describe('idioma do telão', () => {
  it('padrão é português', async () => {
    await montar();
    expect(barraLateral()).toHaveTextContent('JOGADORES');
  });

  it('a transmissão pode estar em inglês mesmo com o app em português', async () => {
    // O telão é lido pelo público, que pode não falar a língua do operador.
    await montar({ dia: { ...DIA, broadcast_language: 'en' } });
    expect(barraLateral()).toHaveTextContent('PLAYERS');
  });

  it('idioma desconhecido cai no português', async () => {
    await montar({ dia: { ...DIA, broadcast_language: 'xx-YY' } });
    expect(barraLateral()).toHaveTextContent('JOGADORES');
  });
});

describe('intervalo', () => {
  const noIntervalo = (extra = {}) =>
    relogio({ current_blind: { is_break: true }, next_blind: { level: 5, small_blind: 800, big_blind: 1600, ante: 0 }, ...extra });

  it('troca a tela inteira, porque o que importa é quanto falta', async () => {
    await montar({}, noIntervalo());
    expect(document.querySelector('.break-screen')).toBeInTheDocument();
    expect(document.querySelector('.timer-display')).toBeNull();
  });

  it('mostra o tempo restante do intervalo', async () => {
    await montar({}, noIntervalo());
    expect(document.querySelector('.break-timer-text')).toHaveTextContent('5:05');
  });

  it('anuncia o nível que vem depois do intervalo', async () => {
    // É a informação que faz o jogador voltar na hora certa.
    await montar({}, noIntervalo());
    expect(document.querySelector('.break-info-panel')).toHaveTextContent('800/1.600');
  });

  it('ante zero não aparece no anúncio', async () => {
    await montar({}, noIntervalo());
    expect(document.querySelector('.break-info-panel')).not.toHaveTextContent('( 0 )');
  });

  it.each([
    ['split', '.break-layout-split'],
    ['fullscreen', '.break-layout-fullscreen'],
    ['overlay', '.break-layout-overlay'],
  ])('o layout %s é respeitado', async (layout, seletor) => {
    await montar({ dia: { ...DIA, broadcast_break_layout: layout } }, noIntervalo());
    expect(document.querySelector(seletor)).toBeInTheDocument();
  });

  it('um vídeo do YouTube é embutido a partir da URL', async () => {
    await montar(
      { dia: { ...DIA, broadcast_break_youtube_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } },
      noIntervalo()
    );
    expect(document.querySelector('.break-video-iframe')).toHaveAttribute(
      'src',
      expect.stringContaining('youtube.com/embed/dQw4w9WgXcQ')
    );
  });

  it('o formato curto youtu.be também funciona', async () => {
    await montar(
      { dia: { ...DIA, broadcast_break_youtube_url: 'https://youtu.be/dQw4w9WgXcQ' } },
      noIntervalo()
    );
    expect(document.querySelector('.break-video-iframe')).toBeInTheDocument();
  });

  it('URL que não é do YouTube não vira vídeo', async () => {
    // Um iframe com endereço inválido deixaria um retângulo preto no telão.
    await montar(
      { dia: { ...DIA, broadcast_break_youtube_url: 'https://exemplo.com/video' } },
      noIntervalo()
    );
    expect(document.querySelector('.break-video-iframe')).toBeNull();
    expect(document.querySelector('.break-video-placeholder')).toBeInTheDocument();
  });

  it('o vídeo entra mudo por padrão', async () => {
    // O som do vídeo abafaria o anúncio do staff no salão.
    await montar(
      { dia: { ...DIA, broadcast_break_youtube_url: 'https://youtu.be/dQw4w9WgXcQ' } },
      noIntervalo()
    );
    expect(document.querySelector('.break-video-iframe').getAttribute('src')).toContain('mute=1');
  });

  it('o som pode ser ligado explicitamente', async () => {
    await montar(
      {
        dia: {
          ...DIA,
          broadcast_break_youtube_url: 'https://youtu.be/dQw4w9WgXcQ',
          broadcast_break_video_muted: false,
        },
      },
      noIntervalo()
    );
    expect(document.querySelector('.break-video-iframe').getAttribute('src')).toContain('mute=0');
  });

  it('desligar o vídeo mantém o painel de informações', async () => {
    await montar(
      {
        dia: {
          ...DIA,
          broadcast_break_youtube_url: 'https://youtu.be/dQw4w9WgXcQ',
          broadcast_break_show_video: false,
        },
      },
      noIntervalo()
    );
    expect(document.querySelector('.break-video-iframe')).toBeNull();
    expect(document.querySelector('.break-timer-text')).toBeInTheDocument();
  });

  it('cada informação do intervalo pode ser desligada', async () => {
    await montar(
      {
        dia: {
          ...DIA,
          broadcast_break_show_next_level: false,
          broadcast_break_show_players: false,
          broadcast_break_show_chipcount: false,
          broadcast_break_show_average: false,
        },
      },
      noIntervalo()
    );
    expect(document.querySelectorAll('.break-stat').length).toBe(0);
  });

  it('durante o intervalo o prizepool sai da tela', async () => {
    await montar({}, noIntervalo());
    expect(document.querySelector('.broadcast-prizepool-corner')).toBeNull();
    expect(document.querySelector('.prize-ticker-bar')).toBeNull();
  });
});

describe('torneio encerrado', () => {
  it('mostra a tela de encerrado com o total de jogadores', async () => {
    await montar({ dia: { ...DIA, status: 'completed' } });
    expect(document.querySelector('.broadcast-completed')).toBeInTheDocument();
    expect(within(document.querySelector('.completed-stats')).getByText('2')).toBeInTheDocument();
  });

  it('a premiação continua visível depois de encerrado', async () => {
    // É o momento em que mais gente olha para os prêmios.
    await montar({ dia: { ...DIA, status: 'completed' } });
    expect(document.querySelector('.prize-ticker-bar')).toBeInTheDocument();
    expect(document.querySelector('.broadcast-prizepool-corner')).toBeInTheDocument();
  });
});

describe('dia final', () => {
  it('o total de jogadores soma os classificatórios', async () => {
    // Na final, "18 de 25" mentiria: as 25 entradas do dia final não são o
    // tamanho do torneio, que veio dos classificatórios.
    await montar({
      dia: { ...DIA, day_type: 'final' },
      estatisticas: { qualifying_days: [{ total_players: 120 }, { total_players: 80 }] },
    });
    expect(barraLateral()).toHaveTextContent('200');
  });

  it('sem estatísticas agregadas usa o número do próprio dia', async () => {
    await montar({ dia: { ...DIA, day_type: 'final' }, estatisticas: new Error('500') });
    expect(barraLateral()).toHaveTextContent('25');
  });
});

describe('alerta sonoro de fim de nível', () => {
  const montarComTempo = async (segundos, extraDia = {}) =>
    montar({ dia: { ...DIA, ...extraDia } }, relogio({ time_remaining_current_level: segundos }));

  it.each([60, 30, 1])('toca faltando %is', async (segundos) => {
    // É o aviso que faz o dealer terminar a mão antes da subida.
    await montarComTempo(segundos);
    expect(bipes.length).toBeGreaterThan(0);
  });

  it('não toca em qualquer segundo', async () => {
    await montarComTempo(45);
    expect(bipes.length).toBe(0);
  });

  it('o clube pode desligar o alerta', async () => {
    // Em sala pequena o bipe incomoda mais do que ajuda.
    await montarComTempo(30, { broadcast_blind_alerts_enabled: false });
    expect(bipes.length).toBe(0);
  });

  it('não toca durante o intervalo', async () => {
    // No intervalo não há mão para terminar.
    await montar({}, relogio({
      time_remaining_current_level: 30,
      current_blind: { is_break: true },
    }));
    expect(bipes.length).toBe(0);
  });

  it('falha no áudio do navegador não derruba o telão', async () => {
    // Sem interação do usuário o navegador bloqueia áudio; a tela precisa
    // continuar de pé.
    global.AudioContext = jest.fn(() => { throw new Error('bloqueado'); });
    await montarComTempo(30);
    expect(document.querySelector('.timer-display')).toBeInTheDocument();
  });
});

describe('contagem local (torneio sem dia)', () => {
  it('o relógio anda sozinho', async () => {
    // Sem o endpoint enriquecido, o telão conta localmente — é o modo antigo,
    // ainda usado por torneios sem estrutura de dias.
    jest.useFakeTimers();
    responder({ comoDia: false });
    useTimerSync.mockReturnValue({ timerState: null });
    render(<TournamentBroadcast />);
    await act(async () => {});
    const antes = document.querySelector('.timer-display').textContent;
    await act(async () => { jest.advanceTimersByTime(3000); });
    expect(document.querySelector('.timer-display').textContent).not.toBe(antes);
    jest.useRealTimers();
  });

  it('torneio que não está ativo não conta', async () => {
    jest.useFakeTimers();
    responder({ comoDia: false, torneio: { ...TORNEIO, status: 'pending' } });
    useTimerSync.mockReturnValue({ timerState: null });
    render(<TournamentBroadcast />);
    await act(async () => {});
    const antes = document.querySelector('.timer-display').textContent;
    await act(async () => { jest.advanceTimersByTime(5000); });
    expect(document.querySelector('.timer-display').textContent).toBe(antes);
    jest.useRealTimers();
  });
});

/**
 * Botões +/− de fonte no canto do telão. A tela muda na hora em qualquer
 * caso; o que varia é onde o valor fica guardado: logado vai para o servidor
 * (e o slider das Configurações passa a refletir), sem login fica só no
 * aparelho. Nunca um toast: ninguém está operando essa tela.
 */
describe('ajuste de fonte pelo próprio telão', () => {
  const CHAVE_LOCAL = 'aceblind:broadcastFontSize:x1';
  const mais = () => screen.getByRole('button', { name: 'broadcast.fontIncrease' });
  const menos = () => screen.getByRole('button', { name: 'broadcast.fontDecrease' });
  const relogio = () => document.querySelector('.timer-display');

  it('clicar em + aumenta a fonte em 10% na hora', async () => {
    await montar();
    expect(relogio().style.fontSize).toBe('160px');
    fireEvent.click(mais());
    expect(relogio().style.fontSize).toBe('176px');
    expect(screen.getByText('110%')).toBeInTheDocument();
  });

  it('sem login, o valor fica só neste aparelho e o servidor não é tocado', async () => {
    await montar();
    fireEvent.click(mais());
    expect(localStorage.getItem(CHAVE_LOCAL)).toBe('110');
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('logado, vários cliques viram um PATCH só e o aparelho esquece o valor', async () => {
    localStorage.setItem('supabase_token', 'tok');
    api.patch.mockResolvedValue({ data: {} });
    await montar();
    jest.useFakeTimers();
    fireEvent.click(mais());
    fireEvent.click(mais());
    fireEvent.click(mais());
    expect(relogio().style.fontSize).toBe('208px');
    expect(api.patch).not.toHaveBeenCalled();
    await act(async () => { jest.advanceTimersByTime(600); });
    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(api.patch).toHaveBeenCalledWith('/tournament-days/x1', { broadcast_font_size: 130 });
    expect(localStorage.getItem(CHAVE_LOCAL)).toBeNull();
    // Servidor virou a fonte da verdade e a tela continua no tamanho pedido.
    expect(relogio().style.fontSize).toBe('208px');
    jest.useRealTimers();
  });

  it('se o servidor recusar, o valor fica no aparelho e a tela não volta atrás', async () => {
    localStorage.setItem('supabase_token', 'tok');
    api.patch.mockRejectedValue({ response: { status: 403 } });
    await montar();
    jest.useFakeTimers();
    fireEvent.click(mais());
    await act(async () => { jest.advanceTimersByTime(600); });
    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(relogio().style.fontSize).toBe('176px');
    expect(localStorage.getItem(CHAVE_LOCAL)).toBe('110');
    jest.useRealTimers();
  });

  it('em torneio sem dia, fica no aparelho mesmo logado (não há dia para gravar)', async () => {
    localStorage.setItem('supabase_token', 'tok');
    await montar({ comoDia: false }, null);
    fireEvent.click(menos());
    expect(localStorage.getItem(CHAVE_LOCAL)).toBe('90');
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('nos limites o botão correspondente desliga', async () => {
    await montar({ dia: { ...DIA, broadcast_font_size: 200 } });
    expect(mais()).toBeDisabled();
    expect(menos()).not.toBeDisabled();
  });

  it('no mínimo o − desliga', async () => {
    await montar({ dia: { ...DIA, broadcast_font_size: 50 } });
    expect(menos()).toBeDisabled();
    expect(mais()).not.toBeDisabled();
  });

  it('o valor guardado no aparelho vence o do servidor ao abrir', async () => {
    localStorage.setItem(CHAVE_LOCAL, '130');
    await montar({ dia: { ...DIA, broadcast_font_size: 100 } });
    expect(relogio().style.fontSize).toBe('208px');
  });

  it('lixo guardado no aparelho é ignorado', async () => {
    localStorage.setItem(CHAVE_LOCAL, '999');
    await montar();
    expect(relogio().style.fontSize).toBe('160px');
  });

  it('mexer o mouse em qualquer ponto mostra os botões por alguns segundos', async () => {
    // Só hover em cima deles não bastava: com a coluna de premiação no canto,
    // ninguém sabia onde estavam. Parado, o telão volta a ficar limpo.
    await montar();
    jest.useFakeTimers();
    const grupo = () => document.querySelector('.broadcast-font-controls');
    expect(grupo().classList.contains('is-visible')).toBe(false);
    fireEvent.mouseMove(window, { clientX: 300, clientY: 300 });
    expect(grupo().classList.contains('is-visible')).toBe(true);
    act(() => { jest.advanceTimersByTime(2500); });
    expect(grupo().classList.contains('is-visible')).toBe(true);
    fireEvent.mouseMove(window, { clientX: 310, clientY: 300 });
    act(() => { jest.advanceTimersByTime(2500); });
    // O segundo movimento reiniciou a contagem.
    expect(grupo().classList.contains('is-visible')).toBe(true);
    act(() => { jest.advanceTimersByTime(600); });
    expect(grupo().classList.contains('is-visible')).toBe(false);
    jest.useRealTimers();
  });
});
