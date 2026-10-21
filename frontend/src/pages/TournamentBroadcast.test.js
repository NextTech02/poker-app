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
 * - **Prêmios, moeda e clube vêm de uma rota PÚBLICA.** A TV não faz login;
 *   os endpoints de premiação exigem — era por isso que o salão nunca via os
 *   prêmios. Faixa com `visible=false` continua fora do público.
 *
 * O desenho em si (tiles, anel, pílula) tem teste próprio em
 * `components/broadcast/TvScreen.test.js`; aqui se testa a PÁGINA: o que ela
 * busca, como junta e o que entrega ao telão.
 */
import { render, screen, waitFor, act, within, fireEvent } from '@testing-library/react';
import TournamentBroadcast from './TournamentBroadcast';
import api from '../config/api';
import { useTimerSync } from '../hooks/useTimerSync';
import { usePolling } from '../hooks/usePolling';

jest.mock('../config/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn(), patch: jest.fn() } }));
jest.mock('../hooks/usePolling', () => ({ usePolling: jest.fn() }));
jest.mock('../hooks/useTimerSync', () => ({ useTimerSync: jest.fn() }));
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
  { position: 1, prize_amount: 20000 },
  { position: 2, prize_amount: 10000 },
];

const EXTRAS = { organization_name: 'Clube Teste', currency: 'BRL', prize_pool: 45000, prizes: PREMIOS };

const INSCRITOS = [
  { player_id: 'p1', status: 'active', buy_in_count: 1, rebuy_count: 1 },
  { player_id: 'p2', status: 'eliminated', buy_in_count: 1, rebuy_count: 0 },
];

const relogio = (extra = {}) => ({
  current_level: 4,
  // O servidor manda os dois: a POSIÇÃO (`current_level`) e o número MOSTRADO
  // (`display_level`, sem contar intervalos). Aqui não há intervalo antes.
  display_level: 4,
  time_remaining_current_level: 305,
  current_blind: { level: 4, display_level: 4, small_blind: 500, big_blind: 1000, ante: 1000, duration: 20, is_break: false },
  next_blind: { level: 5, display_level: 5, small_blind: 800, big_blind: 1600, ante: 1600, is_break: false },
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
  extras = EXTRAS,
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
    if (url === '/public/tv/days/x1/extras') {
      return extras instanceof Error ? Promise.reject(extras) : ok(extras);
    }
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

const tiles = () => document.querySelector('.tv-tiles');
const tela = () => document.querySelector('.tv-screen');
const relogioNaTela = () => document.querySelector('.tv-clock');

let bipes;

beforeEach(() => {
  jest.useRealTimers();
  localStorage.clear();
  api.patch.mockReset();
  bipes = [];
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

  it('o telão é desenhado no palco escalado', async () => {
    await montar();
    expect(document.querySelector('.tv-root--viewport')).toBeInTheDocument();
    expect(document.querySelector('.tv-stage')).toContainElement(tela());
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
    expect(screen.getByText('50-100')).toBeInTheDocument();
  });

  it('erro ao buscar blinds também gera a estrutura', async () => {
    await montar({ blindsDoDia: new Error('500'), dia: { ...DIA, initial_small_blind: 25 } }, null);
    expect(document.querySelector('.tv-blinds')).toBeInTheDocument();
  });

  it.each([
    ['double', '50-100'],
    ['triple', '75-150'],
    ['1.5x', '38-75'],
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
    expect(document.querySelector('.tv-next-value')).toHaveTextContent(esperado);
  });
});

describe('o que a tela mostra ao vivo', () => {
  it('o relógio é a fonte única quando o id é de um dia', async () => {
    await montar();
    expect(relogioNaTela()).toHaveTextContent('05:05');
    expect(document.querySelector('.tv-blinds')).toHaveTextContent('500-1,000');
    expect(document.querySelector('.tv-ante')).toHaveTextContent('1,000');
  });

  it('mostra o nível atual', async () => {
    await montar();
    expect(document.querySelector('.tv-tile--level')).toHaveTextContent('4');
  });

  it('o intervalo não conta como nível', async () => {
    // 800/1600 é o "Nível 9" na tela de blinds, mas ocupa a POSIÇÃO 10 na
    // estrutura (há um intervalo antes). A TV mostrava "NÍVEL 10" — a mesa
    // inteira via um número diferente do que o operador cadastrou.
    await montar({}, relogio({
      current_level: 10,
      display_level: 9,
      current_blind: { level: 10, display_level: 9, small_blind: 800, big_blind: 1600, ante: 1600, is_break: false },
    }));
    expect(document.querySelector('.tv-tile--level')).toHaveTextContent('9');
    expect(document.querySelector('.tv-tile--level')).not.toHaveTextContent('10');
  });

  it('sem display_level do servidor, conta na estrutura em cache', async () => {
    // Estado montado localmente (troca de nível sem rede) não passa pelo
    // servidor; o número ainda tem que pular o intervalo.
    const comIntervalo = [
      { level: 1, small_blind: 100, big_blind: 200, ante: 0, duration: 20 },
      { level: 2, small_blind: 0, big_blind: 0, ante: 0, duration: 10, is_break: true },
      { level: 3, small_blind: 200, big_blind: 400, ante: 200, duration: 20 },
    ];
    await montar({ blindsDoDia: comIntervalo }, relogio({
      current_level: 3,
      display_level: undefined,
      current_blind: { level: 3, small_blind: 200, big_blind: 400, ante: 200, is_break: false },
    }));
    expect(document.querySelector('.tv-tile--level')).toHaveTextContent('2');
    expect(document.querySelector('.tv-tile--level')).not.toHaveTextContent('3');
  });

  it('mostra restantes e total de entradas', async () => {
    await montar();
    expect(document.querySelector('.tv-tile--players')).toHaveTextContent('18 de 25');
    expect(document.querySelector('.tv-tile--entries')).toHaveTextContent('25');
  });

  it('sem entrada nenhuma a linha de entradas fica em 0 (a coluna não muda de forma)', async () => {
    await montar({}, relogio({ total_entries: 0 }));
    expect(document.querySelector('.tv-tile--entries .tv-tile-value')).toHaveTextContent('0');
  });

  it('mostra chipcount e stack médio formatados', async () => {
    await montar();
    expect(tiles()).toHaveTextContent('750,000');
    expect(tiles()).toHaveTextContent('41,666');
  });

  it('chipcount zerado não ocupa espaço no telão', async () => {
    await montar({}, relogio({ chipcount: 0, average_stack: 0 }));
    expect(tiles()).not.toHaveTextContent('CHIP COUNT');
  });

  it('quando há intervalo à vista, ele aparece como contagem', async () => {
    await montar({}, relogio({ next_break: { time_until_break: 1800 } }));
    expect(document.querySelector('.tv-tile--break')).toHaveTextContent('30:00');
  });

  it('o próximo nível é anunciado', async () => {
    await montar();
    expect(document.querySelector('.tv-next-value')).toHaveTextContent('800-1,600 (1,600)');
  });

  it('se o próximo nível é INTERVALO, o telão diz isso', async () => {
    // "800/1600" seguido de um intervalo confundiria a mesa.
    await montar({}, relogio({ next_blind: { is_break: true } }));
    expect(document.querySelector('.tv-next-value')).toHaveTextContent('INTERVALO');
  });

  it('o anel acompanha o nível', async () => {
    await montar();
    const arco = document.querySelector('.tv-ring-progress');
    expect(arco).toBeInTheDocument();
    expect(parseFloat(arco.getAttribute('stroke-dashoffset'))).toBeGreaterThan(0);
  });

  it('sem relógio ainda, a contagem local assume', async () => {
    // O nível local vem do tempo decorrido desde o início: começando agora,
    // o torneio está no nível 1.
    await montar({ comoDia: false, torneio: { ...TORNEIO, start_time: new Date().toISOString() } }, null);
    expect(document.querySelector('.tv-blinds')).toHaveTextContent('100-200');
  });

  it('em torneio sem dia, os jogadores vêm da lista', async () => {
    // 2 buy-ins e 1 recompra: 1 jogador ainda em jogo e 2 ENTRADAS.
    // A recompra nao vira entrada — quem recompra voltou ao torneio, nao
    // entrou nele de novo.
    await montar({ comoDia: false }, null);
    expect(document.querySelector('.tv-tile--players')).toHaveTextContent('1 de 2');
    expect(document.querySelector('.tv-tile--entries')).toHaveTextContent('2');
  });
});

describe('premiação exibida (rota pública)', () => {
  it('a TV busca prêmios no endpoint público, sem login', async () => {
    await montar();
    expect(api.get).toHaveBeenCalledWith('/public/tv/days/x1/extras', { _silentError: true, _public: true });
    expect(api.get.mock.calls.some(([url]) => url.endsWith('/prizes'))).toBe(false);
  });

  it('em torneio sem dia não há extras para buscar', async () => {
    await montar({ comoDia: false }, null);
    expect(api.get.mock.calls.some(([url]) => url.includes('/public/tv/'))).toBe(false);
  });

  it('mostra o prizepool dos extras', async () => {
    await montar();
    expect(document.querySelector('.tv-pool')).toHaveTextContent('R$ 45.000,00');
  });

  it('sem prize pool nos extras cai no do dia', async () => {
    await montar({ extras: { ...EXTRAS, prize_pool: null } });
    expect(document.querySelector('.tv-pool')).toHaveTextContent('R$ 30.000,00');
  });

  it('a moeda é a do clube do dia, não a de quem abriu a tela', async () => {
    await montar({ extras: { ...EXTRAS, currency: 'PEN' } });
    expect(document.querySelector('.tv-pool')).toHaveTextContent('S/ 45,000.00');
    expect(document.querySelector('.tv-prize-item')).toHaveTextContent('S/ 20,000.00');
  });

  it('o nome do clube NÃO aparece em texto (pedido do cliente); sem logo o canto fica vazio', async () => {
    await montar();
    expect(document.querySelector('.tv-club-name')).toBeNull();
    expect(document.querySelector('.tv-header')).not.toHaveTextContent('Clube Teste');
    expect(document.querySelector('.tv-club-logo-img')).toBeNull();
  });

  it('faixa marcada como invisível some do público', async () => {
    // É como o clube segura a premiação antes da hora, sem apagar o dado.
    await montar({
      extras: {
        ...EXTRAS,
        prizes: [
          { position: 1, prize_amount: 20000, visible: true },
          { position: 2, prize_amount: 10000, visible: false },
        ],
      },
    });
    const faixa = document.querySelector('.tv-prizes-bar');
    expect(faixa).toHaveTextContent('R$ 20.000,00');
    expect(faixa).not.toHaveTextContent('R$ 10.000,00');
  });

  it('falha ao carregar os extras não derruba o telão', async () => {
    await montar({ extras: new Error('500') });
    expect(document.querySelector('.tv-prize-item')).toBeNull();
    expect(relogioNaTela()).toBeInTheDocument();
    expect(document.querySelector('.tv-pool')).toHaveTextContent('R$ 30.000,00');
  });

  it('o layout lateral troca a faixa por uma coluna', async () => {
    await montar({ dia: { ...DIA, broadcast_prizes_layout: 'sidebar' } });
    expect(document.querySelector('.tv-prizes-sidebar')).toBeInTheDocument();
    expect(document.querySelector('.tv-prizes-bar')).toBeNull();
  });

  it('lista longa na coluna entra em rolagem', async () => {
    // Mais de 8 faixas não cabem paradas; a lista é duplicada para o laço.
    const muitos = Array.from({ length: 10 }, (_, i) => ({ position: i + 1, prize_amount: 100 * (10 - i) }));
    await montar({ extras: { ...EXTRAS, prizes: muitos }, dia: { ...DIA, broadcast_prizes_layout: 'sidebar' } });
    expect(document.querySelector('.tv-prizes-sidebar-list')).toHaveClass('scrolling');
    expect(document.querySelectorAll('.tv-prizes-sidebar-row').length).toBe(20);
  });

  it('lista curta na coluna fica parada', async () => {
    await montar({ dia: { ...DIA, broadcast_prizes_layout: 'sidebar' } });
    expect(document.querySelector('.tv-prizes-sidebar-list')).not.toHaveClass('scrolling');
    expect(document.querySelectorAll('.tv-prizes-sidebar-row').length).toBe(2);
  });
});

describe('o que pode ser desligado', () => {
  it.each([
    ['broadcast_show_timer', '.tv-clock'],
    ['broadcast_show_blinds', '.tv-blinds'],
    ['broadcast_show_ante', '.tv-ante'],
    ['broadcast_show_next_blind', '.tv-next'],
    ['broadcast_show_prizepool', '.tv-pool'],
    ['broadcast_show_prizes', '.tv-prize-item'],
    ['broadcast_show_logo', '.tv-logo'],
    ['broadcast_show_title', '.tv-title'],
    // A logo do clube só some se ELA existir: sem a URL o teste passaria à toa.
    ['broadcast_show_club_logo', '.tv-club-logo-img', { broadcast_club_logo_url: LOGO }],
  ])('%s desligado esconde %s', async (campo, seletor, extra = {}) => {
    await montar({ dia: { ...DIA, ...extra, [campo]: false } });
    expect(document.querySelector(seletor)).toBeNull();
  });

  it('campo ainda nulo no banco mantém tudo ligado', async () => {
    // Um dia criado antes dessas configurações existirem não pode apagar o
    // relógio do salão.
    await montar({ dia: { id: 'x1', tournament_id: 't1', day_name: 'Dia 1A', status: 'active' } });
    expect(relogioNaTela()).toBeInTheDocument();
    expect(document.querySelector('.tv-pool')).toBeInTheDocument();
  });

  it('desligar tudo da lateral remove a lateral inteira', async () => {
    await montar({
      dia: {
        ...DIA,
        broadcast_show_level: false, broadcast_show_players: false,
        broadcast_show_reentries: false, broadcast_show_interval: false,
        broadcast_show_chipcount: false, broadcast_show_average: false,
      },
    });
    expect(tiles()).toBeNull();
  });

  it('a configuração do DIA tem precedência sobre a do torneio', async () => {
    // Cada dia pode ter seu visual; o do torneio é só o padrão.
    await montar({
      dia: { ...DIA, broadcast_show_timer: false },
      torneio: { ...TORNEIO, broadcast_show_timer: true },
    });
    expect(relogioNaTela()).toBeNull();
  });

  it('em torneio sem dia, vale a configuração do torneio', async () => {
    await montar({ comoDia: false, torneio: { ...TORNEIO, broadcast_show_timer: false } }, null);
    expect(relogioNaTela()).toBeNull();
  });
});

describe('fundo do telão', () => {
  it('imagem escolhida cobre a tela com o escurecimento do dia', async () => {
    await montar({ dia: { ...DIA, broadcast_bg_image_url: 'https://cdn/fundo.webp', broadcast_bg_overlay: 30 } });
    const root = document.querySelector('.tv-root');
    expect(root).toHaveAttribute('data-bg-kind', 'image');
    expect(document.querySelector('.tv-bg').style.backgroundImage).toBe('url(https://cdn/fundo.webp)');
    expect(root.style.getPropertyValue('--tv-overlay')).toBe('0.3');
  });

  it('preset vira gradiente; sem nada, o padrão', async () => {
    await montar({ dia: { ...DIA, broadcast_bg_image_url: 'preset:felt' } });
    expect(document.querySelector('.tv-root')).toHaveAttribute('data-bg-kind', 'preset');
    document.body.innerHTML = '';
    await montar();
    expect(document.querySelector('.tv-root')).toHaveAttribute('data-bg-kind', 'default');
  });

  it('a cor padrão antiga gravada no dia não vira retângulo sólido', async () => {
    await montar({ dia: { ...DIA, broadcast_bg_color: '#0a0e13' } });
    expect(document.querySelector('.tv-root')).toHaveAttribute('data-bg-kind', 'default');
  });
});

describe('logo do clube', () => {
  const logoDoClube = () => document.querySelector('.tv-club-logo-img');
  const espacoDaLogo = () => document.querySelector('.tv-club-logo');

  it('a logo configurada aparece no canto direito do cabeçalho', async () => {
    // É a marca do clube no telão do salão, ao lado da nossa.
    await montar({ dia: { ...DIA, broadcast_club_logo_url: LOGO } });
    expect(logoDoClube()).toHaveAttribute('src', LOGO);
    expect(document.querySelector('.tv-header')).toContainElement(logoDoClube());
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
    expect(relogioNaTela()).toBeInTheDocument();
  });

  it('depois de encerrado a logo do clube continua no telão', async () => {
    await montar({ dia: { ...DIA, status: 'completed', broadcast_club_logo_url: LOGO } });
    expect(document.querySelector('.tv-completed')).toBeInTheDocument();
    expect(logoDoClube()).toHaveAttribute('src', LOGO);
  });
});

/**
 * Idioma do telão = a mesma regra do app: escolha explícita da pessoa
 * (bandeiras) > idioma do CLUBE (extras públicos, porque a TV do salão não
 * tem login) > idioma em que o app está > português. A coluna
 * `broadcast_language` do dia nunca ganhou tela e ficava em pt-BR para todo
 * mundo — o telão "não traduzia" quando o resto do app estava em espanhol.
 */
describe('idioma do telão', () => {
  const i18nDoApp = () => jest.requireMock('react-i18next').useTranslation().i18n;

  it('padrão é português', async () => {
    await montar();
    expect(tiles()).toHaveTextContent('JOGADORES');
  });

  it('segue o idioma do clube (extras), mesmo com a coluna do dia em pt-BR', async () => {
    await montar({ dia: { ...DIA, broadcast_language: 'pt-BR' }, extras: { ...EXTRAS, language: 'es-ES' } });
    expect(tiles()).toHaveTextContent('JUGADORES');
  });

  it('a escolha explícita da pessoa neste aparelho vence o clube', async () => {
    localStorage.setItem('aceblind:idiomaEscolhido', 'en-US');
    await montar({ extras: { ...EXTRAS, language: 'es-ES' } });
    expect(tiles()).toHaveTextContent('PLAYERS');
  });

  it('sem extras (backend antigo) segue o idioma em que o app está', async () => {
    const i18n = i18nDoApp();
    i18n.language = 'es-ES';
    try {
      await montar({ extras: new Error('404') });
      expect(tiles()).toHaveTextContent('JUGADORES');
    } finally {
      i18n.language = 'pt-BR';
    }
  });

  it('idioma desconhecido cai no português', async () => {
    await montar({ extras: { ...EXTRAS, language: 'xx-YY' } });
    expect(tiles()).toHaveTextContent('JOGADORES');
  });
});

describe('intervalo', () => {
  const noIntervalo = (extra = {}) =>
    relogio({ current_blind: { is_break: true }, next_blind: { level: 5, small_blind: 800, big_blind: 1600, ante: 0 }, ...extra });

  it('troca a tela inteira, porque o que importa é quanto falta', async () => {
    await montar({}, noIntervalo());
    expect(document.querySelector('.tv-break')).toBeInTheDocument();
    expect(relogioNaTela()).toBeNull();
  });

  it('mostra o tempo restante do intervalo', async () => {
    await montar({}, noIntervalo());
    expect(document.querySelector('.tv-break-timer')).toHaveTextContent('05:05');
  });

  it('anuncia o nível que vem depois do intervalo', async () => {
    // É a informação que faz o jogador voltar na hora certa.
    await montar({}, noIntervalo());
    expect(document.querySelector('.tv-break-info')).toHaveTextContent('800-1,600');
  });

  it('ante zero não aparece no anúncio', async () => {
    await montar({}, noIntervalo());
    expect(document.querySelector('.tv-break-info')).not.toHaveTextContent('(0)');
  });

  it('o número do próximo nível não conta o intervalo', async () => {
    // Depois do intervalo (posição 5) vem o 4º nível de jogo, não o "5".
    await montar({}, noIntervalo({
      next_blind: { level: 5, display_level: 4, small_blind: 800, big_blind: 1600, ante: 0 },
    }));
    expect(document.querySelector('.tv-break-info')).toHaveTextContent('4: 800-1,600');
  });

  it.each(['split', 'fullscreen', 'overlay'])('o layout %s é respeitado', async (layout) => {
    await montar({ dia: { ...DIA, broadcast_break_layout: layout } }, noIntervalo());
    expect(document.querySelector('.tv-break')).toHaveClass(layout);
  });

  it('um vídeo do YouTube é embutido a partir da URL', async () => {
    await montar(
      { dia: { ...DIA, broadcast_break_youtube_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } },
      noIntervalo()
    );
    expect(document.querySelector('.tv-break-video')).toHaveAttribute(
      'src',
      expect.stringContaining('youtube.com/embed/dQw4w9WgXcQ')
    );
  });

  it('URL que não é do YouTube não vira vídeo', async () => {
    // Um iframe com endereço inválido deixaria um retângulo preto no telão.
    await montar(
      { dia: { ...DIA, broadcast_break_youtube_url: 'https://exemplo.com/video' } },
      noIntervalo()
    );
    expect(document.querySelector('.tv-break-video')).toBeNull();
    expect(document.querySelector('.tv-break-video-placeholder')).toBeInTheDocument();
  });

  it('o vídeo entra mudo por padrão e o som pode ser ligado', async () => {
    // O som do vídeo abafaria o anúncio do staff no salão.
    await montar(
      { dia: { ...DIA, broadcast_break_youtube_url: 'https://youtu.be/dQw4w9WgXcQ' } },
      noIntervalo()
    );
    expect(document.querySelector('.tv-break-video').getAttribute('src')).toContain('mute=1');
    document.body.innerHTML = '';
    await montar(
      { dia: { ...DIA, broadcast_break_youtube_url: 'https://youtu.be/dQw4w9WgXcQ', broadcast_break_video_muted: false } },
      noIntervalo()
    );
    expect(document.querySelector('.tv-break-video').getAttribute('src')).toContain('mute=0');
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
    expect(document.querySelectorAll('.tv-break-stat').length).toBe(0);
  });

  it('durante o intervalo o prizepool sai da tela', async () => {
    await montar({}, noIntervalo());
    expect(document.querySelector('.tv-pool')).toBeNull();
    expect(document.querySelector('.tv-prizes-bar')).toBeNull();
  });
});

describe('torneio encerrado', () => {
  it('mostra a tela de encerrado com o total de jogadores, no idioma do telão', async () => {
    await montar({ dia: { ...DIA, status: 'completed' }, extras: { ...EXTRAS, language: 'es-ES' } });
    expect(document.querySelector('.tv-completed')).toHaveTextContent('FINALIZADO');
    expect(within(document.querySelector('.tv-completed-stats')).getByText('2')).toBeInTheDocument();
  });

  it('a premiação continua visível depois de encerrado', async () => {
    // É o momento em que mais gente olha para os prêmios.
    await montar({ dia: { ...DIA, status: 'completed' } });
    expect(document.querySelector('.tv-prizes-bar')).toBeInTheDocument();
    expect(document.querySelector('.tv-pool')).toBeInTheDocument();
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
    expect(document.querySelector('.tv-tile--players')).toHaveTextContent('18 de 200');
  });

  it('sem estatísticas agregadas usa o número do próprio dia', async () => {
    await montar({ dia: { ...DIA, day_type: 'final' }, estatisticas: new Error('500') });
    expect(document.querySelector('.tv-tile--players')).toHaveTextContent('18 de 25');
  });
});

describe('alerta sonoro de fim de nível', () => {
  const montarComTempo = async (segundos, extraDia = {}) =>
    montar({ dia: { ...DIA, ...extraDia } }, relogio({ time_remaining_current_level: segundos }));

  it.each([10, 7, 3, 1])('toca faltando %is (contagem dos últimos 10 s)', async (segundos) => {
    // É o aviso que faz o dealer terminar a mão antes da subida: começa 10 s
    // antes e bate a cada segundo até a troca.
    await montarComTempo(segundos);
    expect(bipes.length).toBe(1);
  });

  it.each([60, 30, 11, 45])('não toca faltando %is', async (segundos) => {
    // Antes havia bipes suaves em 60 s e 30 s que ninguém ouvia no salão.
    await montarComTempo(segundos);
    expect(bipes.length).toBe(0);
  });

  it('o clube pode desligar o alerta', async () => {
    // Em sala pequena o bipe incomoda mais do que ajuda.
    await montarComTempo(5, { broadcast_blind_alerts_enabled: false });
    expect(bipes.length).toBe(0);
  });

  it('não toca durante o intervalo', async () => {
    // No intervalo não há mão para terminar.
    await montar({}, relogio({
      time_remaining_current_level: 5,
      current_blind: { is_break: true },
    }));
    expect(bipes.length).toBe(0);
  });

  it('falha no áudio do navegador não derruba o telão', async () => {
    // Sem interação do usuário o navegador bloqueia áudio; a tela precisa
    // continuar de pé.
    global.AudioContext = jest.fn(() => { throw new Error('bloqueado'); });
    await montarComTempo(5);
    expect(relogioNaTela()).toBeInTheDocument();
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
    const antes = relogioNaTela().textContent;
    await act(async () => { jest.advanceTimersByTime(3000); });
    expect(relogioNaTela().textContent).not.toBe(antes);
    jest.useRealTimers();
  });

  it('torneio que não está ativo não conta', async () => {
    jest.useFakeTimers();
    responder({ comoDia: false, torneio: { ...TORNEIO, status: 'pending' } });
    useTimerSync.mockReturnValue({ timerState: null });
    render(<TournamentBroadcast />);
    await act(async () => {});
    const antes = relogioNaTela().textContent;
    await act(async () => { jest.advanceTimersByTime(5000); });
    expect(relogioNaTela().textContent).toBe(antes);
    jest.useRealTimers();
  });

  it('a contagem para o intervalo aparece no tile', async () => {
    await montar({ comoDia: false, torneio: { ...TORNEIO, break_interval: 60, start_time: new Date().toISOString() } }, null);
    expect(document.querySelector('.tv-tile--break')).toHaveTextContent('1:00:00');
  });

  it('torneio antigo sem data de início não deixa o tile em NaN', async () => {
    await montar({ comoDia: false, torneio: { ...TORNEIO, break_interval: 60 } }, null);
    expect(document.querySelector('.tv-tile--break')).toHaveTextContent('1:00:00');
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
  const fonte = () => tela().style.getPropertyValue('--tv-font');

  it('clicar em + aumenta a fonte em 10% na hora', async () => {
    await montar();
    expect(fonte()).toBe('1');
    fireEvent.click(mais());
    expect(fonte()).toBe('1.1');
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
    expect(fonte()).toBe('1.3');
    expect(api.patch).not.toHaveBeenCalled();
    await act(async () => { jest.advanceTimersByTime(600); });
    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(api.patch).toHaveBeenCalledWith('/tournament-days/x1', { broadcast_font_size: 130 });
    expect(localStorage.getItem(CHAVE_LOCAL)).toBeNull();
    // Servidor virou a fonte da verdade e a tela continua no tamanho pedido.
    expect(fonte()).toBe('1.3');
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
    expect(fonte()).toBe('1.1');
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
    expect(fonte()).toBe('1.3');
  });

  it('lixo guardado no aparelho é ignorado', async () => {
    localStorage.setItem(CHAVE_LOCAL, '999');
    await montar();
    expect(fonte()).toBe('1');
  });

  it('os botões são invisíveis: mexer o mouse pela tela não os revela', async () => {
    // Pedido do cliente (2026-10): nada de +/− no telão. Eles continuam no DOM
    // (quem leva o cursor até o cantinho, ou chega por teclado, usa), mas sem
    // a classe que o movimento do mouse ligava — só o hover/foco do CSS.
    await montar();
    const grupo = document.querySelector('.broadcast-font-controls');
    fireEvent.mouseMove(window, { clientX: 300, clientY: 300 });
    expect(grupo.classList.contains('is-visible')).toBe(false);
    expect(grupo.className).toBe('broadcast-font-controls');
    expect(mais()).toBeInTheDocument();
  });
});

describe('meios de entrada no telão', () => {
  it('com o interruptor do dia ligado, a linha mostra os meios dos extras', async () => {
    await montar({
      dia: { ...DIA, broadcast_show_buy_types: true },
      extras: { ...EXTRAS, buy_types: [{ name: 'Buy-in', count: 37, amount: 50, category: 'buy_in' }, { name: 'Tasa', count: 4, amount: 50, category: 'addon' }] },
    });
    const linha = document.querySelector('.tv-buytypes');
    expect(linha).toHaveTextContent('Buy-in:37');
    expect(linha).toHaveTextContent('Tasa:4');
    // Os tiles da lateral saem: é a mesma conta, aberta por meio.
    expect(document.querySelector('.tv-tile--entries')).toBeNull();
    expect(document.querySelector('.tv-tile--reentries')).toBeNull();
  });

  it('desligado (padrão), nada aparece mesmo com lista', async () => {
    await montar({ extras: { ...EXTRAS, buy_types: [{ name: 'Buy-in', amount: 50 }] } });
    expect(document.querySelector('.tv-buytypes')).toBeNull();
  });
});


/**
 * Duplo clique no telão = pausar/retomar o relógio. Só logado (o diretor
 * abriu o telão pelo "Ver", na mesma sessão) e com dia; a TV anônima do
 * salão ignora. Mesmo comando do Controle: otimista + broadcast + POST.
 */
describe('duplo clique pausa/retoma o relógio', () => {
  const area = () => screen.getByTestId('broadcast-stage-area');
  const montarLogado = async (estadoRelogio, extras = {}) => {
    localStorage.setItem('supabase_token', 'tok');
    api.post.mockResolvedValue({ data: {} });
    const applyOptimistic = jest.fn();
    const broadcastCommand = jest.fn((patch) => ({ ...patch, remaining: 300 }));
    const refetch = jest.fn();
    responder({});
    useTimerSync.mockReturnValue({ timerState: estadoRelogio, applyOptimistic, broadcastCommand, refetch, ...extras });
    render(<TournamentBroadcast />);
    await waitFor(() => expect(screen.queryByText('common.loading')).toBeNull());
    return { applyOptimistic, broadcastCommand, refetch };
  };

  it('relógio rodando: pausa na hora e manda o comando ao servidor', async () => {
    const { applyOptimistic, broadcastCommand, refetch } = await montarLogado(relogio({ is_paused: false }));
    fireEvent.doubleClick(area());
    expect(broadcastCommand).toHaveBeenCalledWith({ is_paused: true });
    expect(applyOptimistic).toHaveBeenCalledWith({ is_paused: true, remaining: 300 });
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/tournament-days/x1/timer/pause'));
    await waitFor(() => expect(refetch).toHaveBeenCalled());
  });

  it('relógio pausado: retoma', async () => {
    await montarLogado(relogio({ is_paused: true }));
    fireEvent.doubleClick(area());
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/tournament-days/x1/timer/start'));
  });

  it('sem login (TV do salão) o duplo clique não faz nada', async () => {
    await montar();
    fireEvent.doubleClick(area());
    expect(api.post).not.toHaveBeenCalled();
  });

  it('torneio sem dia (contagem local) também não manda comando', async () => {
    localStorage.setItem('supabase_token', 'tok');
    responder({ comoDia: false });
    useTimerSync.mockReturnValue({ timerState: null });
    render(<TournamentBroadcast />);
    await waitFor(() => expect(screen.queryByText('common.loading')).toBeNull());
    fireEvent.doubleClick(area());
    expect(api.post).not.toHaveBeenCalled();
  });

  it('falha do servidor não derruba o telão e reconcilia com o relógio', async () => {
    const { refetch } = await montarLogado(relogio({ is_paused: false }));
    api.post.mockRejectedValue(new Error('rede'));
    fireEvent.doubleClick(area());
    await waitFor(() => expect(refetch).toHaveBeenCalled());
    expect(screen.getByTestId('broadcast-stage-area')).toBeInTheDocument();
  });
});

describe('aviso animado de jogador eliminado', () => {
  /* Pedido do NSOP: o floor elimina e o telão mostra embaixo "JOGADOR
     ELIMINADO · <nome>". O telão já relê os inscritos a cada 10 s; o aviso
     sai da comparação entre duas leituras. */
  const VIVOS = [
    { id: 'tp1', player_id: 'p1', player_name: 'Carlos Montea', status: 'active', buy_in_count: 1, rebuy_count: 0 },
    { id: 'tp2', player_id: 'p2', player_name: 'Ana', status: 'active', buy_in_count: 1, rebuy_count: 0 },
  ];
  const CAIU = [{ ...VIVOS[0], status: 'eliminated', eliminated_at: '2026-10-21T22:00:00Z' }, VIVOS[1]];
  const COM_AVISO = { ...DIA, broadcast_show_eliminations: true };

  // O último callback de 10 s registrado é o que relê os inscritos.
  const lerInscritos = async () => {
    const chamadas = usePolling.mock.calls.filter(([, ms]) => ms === 10000);
    await act(async () => { await chamadas[chamadas.length - 1][0](); });
  };

  it('ligado: quem cai aparece na faixa de baixo com o nome', async () => {
    await montar({ dia: COM_AVISO, inscritos: VIVOS });
    expect(document.querySelector('.tv-elim')).toBeNull();
    responder({ dia: COM_AVISO, inscritos: CAIU });
    await lerInscritos();
    const faixa = await waitFor(() => {
      const el = document.querySelector('.tv-elim');
      expect(el).not.toBeNull();
      return el;
    });
    expect(within(faixa).getByText('Carlos Montea')).toBeInTheDocument();
    expect(within(faixa).getByText('JOGADOR ELIMINADO')).toBeInTheDocument();
  });

  it('quem já estava eliminado ao abrir a TV não ganha aviso', async () => {
    await montar({ dia: COM_AVISO, inscritos: CAIU });
    await lerInscritos();
    expect(document.querySelector('.tv-elim')).toBeNull();
  });

  it('desligado (padrão): eliminação não mostra nada', async () => {
    await montar({ inscritos: VIVOS });
    responder({ inscritos: CAIU });
    await lerInscritos();
    expect(document.querySelector('.tv-elim')).toBeNull();
  });
});

