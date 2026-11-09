/**
 * Relógio de mesa fora do tablet: escolher o dia e a mesa, configurar e cuidar
 * dos cartões.
 *
 * A separação que os testes prendem é quem pode o quê. O dealer só abre a mesa;
 * regra do dia e saldo de jogador são do floor, e a tela nem pede ao servidor o
 * que ele recusaria.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import RelogioDeMesa from './RelogioDeMesa';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { usePermissions } from '../contexts/PermissionContext';
import { useStage } from '../contexts/StageContext';
import { usePresencaDoRelogio } from '../hooks/usePresencaDoRelogio';
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), put: jest.fn() },
}));
jest.mock('../components/Sidebar', () => () => <nav data-testid="sidebar" />);
jest.mock('../hooks/useRealtimeRefresh', () => ({ useRealtimeRefresh: jest.fn() }));
jest.mock('../hooks/usePresencaDoRelogio', () => ({ usePresencaDoRelogio: jest.fn() }));
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../contexts/StageContext', () => ({ useStage: jest.fn() }));
jest.mock('../contexts/PermissionContext', () => ({ usePermissions: jest.fn() }));
jest.mock('react-i18next', () => {
  const t = (chave, segundo) => {
    if (typeof segundo === 'string') return segundo;
    if (segundo?.defaultValue) {
      return segundo.defaultValue.replace(/\{\{(\w+)\}\}/g, (_, nome) => segundo[nome]);
    }
    return chave;
  };
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const DIAS = [{ id: 'd1', day_name: 'Dia 1', tournament_id: 't1', tournament_name: 'Main Event' }];
const MESAS = [
  { id: 'm1', table_number: 5, status: 'active' },
  { id: 'm2', table_number: 6, status: 'active' },
];
const CONFIG = {
  enabled: true, preflop_seconds: 20, postflop_seconds: 30, called_clock_seconds: 30, start_level: 1,
  time_bank_enabled: true, card_seconds: 30, initial_cards: 2, cards_per_break: 1, max_cards_per_decision: 6,
};
const PAINEL = {
  settings: CONFIG,
  tournament_name: 'Main Event',
  day_name: 'Dia 1',
  time_bank: { available: true, reason: null },
  entitled: 3,
  players: [
    { tournament_player_id: 'tp1', name: 'Ana', nickname: null, table_number: 5, seat_number: 3, cards: 2, used: 1 },
    { tournament_player_id: 'tp2', name: 'Beto', nickname: null, table_number: null, seat_number: null, cards: 3, used: 0 },
  ],
};
const EVENTOS = [
  { id: 'e1', kind: 'use', cards: -1, seat_number: 3, level: 2, reason: null,
    created_at: '2026-11-06T20:00:00Z', player_name: 'Ana', table_number: 5 },
  { id: 'e2', kind: 'adjust', cards: 1, seat_number: null, level: 2, reason: 'Cortesia do diretor',
    created_at: '2026-11-06T20:05:00Z', player_name: 'Beto', table_number: null },
];

let toast;

const ETAPAS = [{ id: 'e1', name: 'Etapa Lima' }, { id: 'e2', name: 'Etapa Cusco' }];

const responder = ({ painel = PAINEL, dias = DIAS, mesas = MESAS, etapas = ETAPAS } = {}) => {
  api.get.mockImplementation((url) => {
    if (url === '/table-clock/days') return Promise.resolve({ data: dias });
    if (url === '/stages') {
      return etapas instanceof Error ? Promise.reject(etapas) : Promise.resolve({ data: etapas });
    }
    if (url.startsWith('/tables/day/')) return Promise.resolve({ data: mesas });
    if (url.endsWith('/panel')) return Promise.resolve({ data: painel });
    if (url.endsWith('/events')) return Promise.resolve({ data: EVENTOS });
    return Promise.resolve({ data: {} });
  });
};

const montar = async (caminho = '/relogio-mesa/d1', opcoes) => {
  responder(opcoes);
  render(
    <MemoryRouter initialEntries={[caminho]}>
      <Routes>
        <Route path="/relogio-mesa" element={<RelogioDeMesa />} />
        <Route path="/relogio-mesa/torneio/:tournamentId" element={<RelogioDeMesa />} />
        <Route path="/relogio-mesa/:dayId" element={<RelogioDeMesa />} />
        <Route path="/relogio-mesa/:dayId/mesa/:tableId" element={<p>tablet aberto</p>} />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(document.querySelector('.loading')).toBeNull());
};

let selectStage;
let clearStage;
const naEtapa = (etapa) => useStage.mockReturnValue({ selectedStage: etapa, selectStage, clearStage });

const comoDealer = () => usePermissions.mockReturnValue({
  isAdmin: false, hasPermission: (chave) => chave === 'table_clock',
});

beforeEach(() => {
  toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn() };
  useToast.mockReturnValue({ toast });
  usePermissions.mockReturnValue({ isAdmin: false, hasPermission: (chave) => chave === 'tables' });
  useRealtimeRefresh.mockReturnValue(jest.fn());
  usePresencaDoRelogio.mockReturnValue([]);
  selectStage = jest.fn();
  clearStage = jest.fn();
  naEtapa(null);
  api.put.mockImplementation((_, corpo) => Promise.resolve({ data: corpo }));
  api.post.mockResolvedValue({ data: { event_id: 'x', cards: 3 } });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => console.error.mockRestore());

describe('escolher o torneio', () => {
  const VARIOS = [
    { id: 'd2', day_name: 'Dia 1B', status: 'pending', created_at: '2026-11-08T12:00:00Z', tournament_id: 't1', tournament_name: 'Main Event' },
    { id: 'd9', day_name: 'Dia 1', status: 'active', created_at: '2026-11-08T11:00:00Z', tournament_id: 't2', tournament_name: 'Turbo' },
    { id: 'd1', day_name: 'Dia 1A', status: 'active', created_at: '2026-11-07T12:00:00Z', tournament_id: 't1', tournament_name: 'Main Event' },
  ];

  it('mostra um item por torneio, e não um por dia', async () => {
    await montar('/relogio-mesa', { dias: VARIOS });
    const torneios = document.querySelectorAll('.rcm-item');
    expect(Array.from(torneios).map((el) => el.querySelector('strong').textContent)).toEqual(['Main Event', 'Turbo']);
  });

  it('torneio de vários dias leva à escolha do dia', async () => {
    await montar('/relogio-mesa', { dias: VARIOS });
    const main = screen.getByRole('link', { name: /Main Event/ });
    expect(main).toHaveAttribute('href', '/relogio-mesa/torneio/t1');
    expect(main).toHaveTextContent('2 dias abertos');
  });

  it('torneio de um dia só vai direto para as mesas', async () => {
    await montar('/relogio-mesa', { dias: VARIOS });
    expect(screen.getByRole('link', { name: /Turbo/ })).toHaveAttribute('href', '/relogio-mesa/d9');
    expect(screen.getByRole('link', { name: /Turbo/ })).toHaveTextContent('Dia 1 · Em andamento');
  });

  it('dia com o mesmo nome do torneio não repete o nome', async () => {
    await montar('/relogio-mesa', { dias: [{ ...VARIOS[1], day_name: 'Turbo' }] });
    const item = screen.getByRole('link', { name: /Turbo/ });
    expect(item.querySelector('span')).toHaveTextContent(/^Em andamento$/);
  });

  it('no torneio, aparecem só os dias dele, do primeiro ao último', async () => {
    await montar('/relogio-mesa/torneio/t1', { dias: VARIOS });
    const dias = Array.from(document.querySelectorAll('.rcm-item'));
    expect(dias.map((el) => el.getAttribute('href'))).toEqual(['/relogio-mesa/d1', '/relogio-mesa/d2']);
    expect(screen.queryByText('Turbo')).toBeNull();
  });

  it('cada dia diz se já começou', async () => {
    await montar('/relogio-mesa/torneio/t1', { dias: VARIOS });
    expect(screen.getByRole('link', { name: /Dia 1A/ })).toHaveTextContent('Em andamento');
    expect(screen.getByRole('link', { name: /Dia 1B/ })).toHaveTextContent('Ainda não começou');
  });

  it('do torneio dá para voltar à lista', async () => {
    await montar('/relogio-mesa/torneio/t1', { dias: VARIOS });
    expect(screen.getByRole('link', { name: 'Outros torneios' })).toHaveAttribute('href', '/relogio-mesa');
  });

  it('sem torneio com dia aberto, a tela diz isso', async () => {
    await montar('/relogio-mesa', { dias: [] });
    expect(await screen.findByText('Nenhum torneio com dia aberto nesta etapa.')).toBeInTheDocument();
  });
});

describe('etapa', () => {
  it('mostra a etapa selecionada no app', async () => {
    naEtapa(ETAPAS[0]);
    await montar('/relogio-mesa');
    expect(await screen.findByLabelText('Etapa')).toHaveValue('e1');
  });

  it('trocar a etapa troca a do app inteiro', async () => {
    await montar('/relogio-mesa');
    await userEvent.selectOptions(await screen.findByLabelText('Etapa'), 'e2');
    expect(selectStage).toHaveBeenCalledWith(ETAPAS[1]);
  });

  it('"Todas as etapas" tira o filtro', async () => {
    naEtapa(ETAPAS[0]);
    await montar('/relogio-mesa');
    await userEvent.selectOptions(await screen.findByLabelText('Etapa'), '');
    expect(clearStage).toHaveBeenCalled();
  });

  it('trocar de etapa recarrega a lista', async () => {
    naEtapa(ETAPAS[0]);
    responder();
    // Uma árvore nova a cada render, como quando o contexto da etapa muda: com o
    // mesmo elemento o React não redesenha nada.
    const arvore = () => (
      <MemoryRouter initialEntries={['/relogio-mesa']}>
        <Routes><Route path="/relogio-mesa" element={<RelogioDeMesa />} /></Routes>
      </MemoryRouter>
    );
    const { rerender } = render(arvore());
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/table-clock/days'));
    const antes = api.get.mock.calls.filter(([url]) => url === '/table-clock/days').length;
    naEtapa(ETAPAS[1]);
    rerender(arvore());
    await waitFor(() => expect(
      api.get.mock.calls.filter(([url]) => url === '/table-clock/days').length,
    ).toBe(antes + 1));
  });

  it('sem a lista de etapas, a tela segue sem o seletor', async () => {
    await montar('/relogio-mesa', { etapas: new Error('500') });
    await screen.findByRole('link', { name: /Main Event/ });
    expect(screen.queryByLabelText('Etapa')).toBeNull();
  });

  it('na escolha da mesa o seletor some: o dia já foi escolhido', async () => {
    await montar();
    await screen.findByRole('link', { name: /Mesa 5/ });
    expect(screen.queryByLabelText('Etapa')).toBeNull();
  });
});

describe('escolher a mesa', () => {
  it('cada mesa abre o tablet dela', async () => {
    await montar();
    const mesa = await screen.findByRole('link', { name: /Mesa 5/ });
    expect(mesa).toHaveAttribute('href', '/relogio-mesa/d1/mesa/m1');
  });

  it('mostra quais mesas já estão com o relógio aberto', async () => {
    usePresencaDoRelogio.mockReturnValue(['m2']);
    await montar();
    expect(await screen.findByRole('link', { name: /Mesa 6/ })).toHaveTextContent('Relógio aberto');
    expect(screen.getByRole('link', { name: /Mesa 5/ })).not.toHaveTextContent('Relógio aberto');
  });

  it('sem mesas cadastradas, explica o que falta', async () => {
    await montar('/relogio-mesa/d1', { mesas: [] });
    expect(await screen.findByText('Este dia ainda não tem mesas.')).toBeInTheDocument();
  });

  it('observa as mesas sem se anunciar como uma delas', async () => {
    await montar();
    expect(usePresencaDoRelogio).toHaveBeenCalledWith('d1');
  });
});

describe('dealer', () => {
  beforeEach(comoDealer);

  it('vê as mesas e nada de configuração', async () => {
    await montar();
    expect(await screen.findByRole('link', { name: /Mesa 5/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Salvar' })).toBeNull();
    expect(screen.queryByText('Ana')).toBeNull();
  });

  it('não vê o atalho para o painel de mesas: é do floor', async () => {
    await montar();
    await screen.findByRole('link', { name: /Mesa 5/ });
    expect(screen.queryByRole('link', { name: 'Painel de mesas' })).toBeNull();
  });

  it('nem pede o painel: o servidor recusaria', async () => {
    await montar();
    await screen.findByRole('link', { name: /Mesa 5/ });
    expect(api.get).not.toHaveBeenCalledWith('/table-clock/day/d1/panel');
    expect(api.get).not.toHaveBeenCalledWith('/table-clock/day/d1/events');
  });
});

describe('atalho do floor', () => {
  it('quem gere as mesas tem o atalho para o painel do dia', async () => {
    await montar();
    expect(await screen.findByRole('link', { name: 'Painel de mesas' })).toHaveAttribute('href', '/painel-mesas/d1');
  });
});

describe('configuração', () => {
  it('mostra o que está valendo', async () => {
    await montar();
    expect(await screen.findByLabelText('Pré-flop (segundos)')).toHaveValue(20);
    expect(screen.getByLabelText('Cartões iniciais')).toHaveValue(2);
    expect(screen.getByLabelText('Ligar o relógio neste dia')).toBeChecked();
  });

  it('salva os números como números', async () => {
    await montar();
    const campo = await screen.findByLabelText('Pré-flop (segundos)');
    await userEvent.clear(campo);
    await userEvent.type(campo, '15');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    const [url, corpo] = api.put.mock.calls[0];
    expect(url).toBe('/table-clock/day/d1/settings');
    expect(corpo).toMatchObject({ preflop_seconds: 15, postflop_seconds: 30, enabled: true });
    expect(toast.success).toHaveBeenCalled();
  });

  it('recusa do servidor aparece com a frase dele', async () => {
    api.put.mockRejectedValue(Object.assign(new Error('x'), { userMessage: 'Valor inválido' }));
    await montar();
    await userEvent.click(await screen.findByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Valor inválido'));
  });

  it('desligar o banco esconde os campos dos cartões', async () => {
    await montar();
    await userEvent.click(await screen.findByLabelText('Usar time bank'));
    expect(screen.queryByLabelText('Cartões iniciais')).toBeNull();
  });

  it('eliminação em massa avisa que só o relógio funciona', async () => {
    await montar('/relogio-mesa/d1', {
      painel: { ...PAINEL, time_bank: { available: false, reason: 'eliminacao_em_massa' }, players: [] },
    });
    expect(await screen.findByText(/eliminação em massa/)).toBeInTheDocument();
  });
});

describe('cartões dos jogadores', () => {
  // O nome também aparece no histórico: a procura fica dentro da tabela de saldos.
  const linha = (nome) => within(screen.getByText('Usados').closest('table')).getByText(nome).closest('tr');

  it('lista cada jogador com mesa, assento e saldo', async () => {
    await montar();
    await screen.findByText('Usados');
    const ana = within(linha('Ana'));
    expect(ana.getByText('5')).toBeInTheDocument();
    expect(ana.getByText('3')).toBeInTheDocument();
    expect(ana.getByText('2')).toBeInTheDocument();
  });

  it('jogador sem assento aparece com traço', async () => {
    await montar();
    await screen.findByText('Usados');
    expect(linha('Beto')).toHaveTextContent('--');
  });

  it('ajuste exige motivo antes de gravar', async () => {
    await montar();
    await screen.findByText('Usados');
    await userEvent.click(within(linha('Ana')).getByRole('button', { name: 'Ajustar' }));
    const janela = screen.getByRole('dialog');
    expect(within(janela).getByRole('button', { name: 'Confirmar' })).toBeDisabled();
    await userEvent.type(within(janela).getByLabelText('Motivo'), 'Erro do dealer');
    await userEvent.click(within(janela).getByRole('button', { name: 'Confirmar' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/table-clock/day/d1/players/tp1/adjust', { cards: 1, reason: 'Erro do dealer' },
    ));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('ajuste também tira cartão', async () => {
    await montar();
    await screen.findByText('Usados');
    await userEvent.click(within(linha('Ana')).getByRole('button', { name: 'Ajustar' }));
    const janela = screen.getByRole('dialog');
    const cartoes = within(janela).getByLabelText('Cartões (use negativo para tirar)');
    await userEvent.clear(cartoes);
    await userEvent.type(cartoes, '-2');
    await userEvent.type(within(janela).getByLabelText('Motivo'), 'Punição');
    await userEvent.click(within(janela).getByRole('button', { name: 'Confirmar' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/table-clock/day/d1/players/tp1/adjust', { cards: -2, reason: 'Punição' },
    ));
  });

  it('ajuste de zero não confirma', async () => {
    await montar();
    await screen.findByText('Usados');
    await userEvent.click(within(linha('Ana')).getByRole('button', { name: 'Ajustar' }));
    const janela = screen.getByRole('dialog');
    const cartoes = within(janela).getByLabelText('Cartões (use negativo para tirar)');
    await userEvent.clear(cartoes);
    await userEvent.type(cartoes, '0');
    await userEvent.type(within(janela).getByLabelText('Motivo'), 'x');
    expect(within(janela).getByRole('button', { name: 'Confirmar' })).toBeDisabled();
  });

  it('atualiza sozinha quando um cartão é usado', async () => {
    await montar();
    await screen.findByText('Usados');
    const { tabelas } = useRealtimeRefresh.mock.calls.at(-1)[0];
    expect(tabelas.map((x) => x.table)).toEqual(expect.arrayContaining(['time_bank_events', 'tournament_players']));
  });
});

describe('histórico', () => {
  it('mostra o uso e o ajuste com o motivo', async () => {
    await montar();
    const historico = (await screen.findByText('Cortesia do diretor')).closest('table');
    expect(historico).toHaveTextContent('Usou');
    expect(historico).toHaveTextContent('Ajuste');
  });
});
