/**
 * O tablet do dealer: a mesa desenhada, um toque por ação, e o relógio não
 * depende da rede.
 *
 * A conta do relógio tem teste próprio (relogioDeAcao.test.js), e a posição dos
 * assentos também (mesaDesenhada.test.js). Aqui fica o que só existe na tela:
 *
 * - **A mesa mostra todos os lugares e o tempo do nível.** É a visão que o clube
 *   pediu: quem está em cada assento e quanto falta, de relance.
 * - **O tempo acaba e o dealer toca no assento de quem usa o cartão.** O sistema
 *   não sabe quem está agindo. Fora dessa hora, tocar no assento não faz nada:
 *   a mão do dealer passa pela tela o tempo todo.
 * - **O dealer só usa cartão.** Eliminar e trocar de mesa são do floor.
 * - **A rede cair não perde o cartão nem para o relógio.** O toque fica no
 *   aparelho e reenvia sozinho, com o mesmo id.
 * - **O saldo na tela já desconta o que falta enviar.**
 * - **Intervalo e pausa param o relógio.** Quem decide é o relógio de blinds.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import RelogioDaMesa from './RelogioDaMesa';
import api from '../config/api';
import { supabase } from '../config/supabase';
import { useToast } from '../contexts/ToastContext';
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh';
import { lerFila } from '../utils/filaDeCartoes';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() },
}));
jest.mock('../config/supabase', () => ({
  supabase: { channel: jest.fn(), removeChannel: jest.fn() },
}));
jest.mock('../hooks/useRealtimeRefresh', () => ({ useRealtimeRefresh: jest.fn() }));
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
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

const ESTADO = {
  table: { id: 'm1', table_number: 5, seats: 9, blocked_seats: [] },
  day: { id: 'd1', day_name: 'Dia 1', tournament_id: 't1', tournament_name: 'Main Event' },
  settings: {
    enabled: true, preflop_seconds: 20, postflop_seconds: 30, called_clock_seconds: 30, start_level: 1,
    time_bank_enabled: true, card_seconds: 30, initial_cards: 2, cards_per_break: 1, max_cards_per_decision: 6,
  },
  clock_active: true,
  timer: {
    level: 2, display_level: 2, is_break: false, is_paused: false, started: true,
    small_blind: 200, big_blind: 400, ante: 400, level_ends_at: null, server_time: null, time_remaining: null,
  },
  time_bank: { available: true, reason: null },
  seats: [
    { seat_number: 3, tournament_player_id: 'tp1', name: 'Ana', nickname: null, cards: 2 },
    { seat_number: 7, tournament_player_id: 'tp2', name: 'Beto', nickname: 'Betão', cards: 0 },
  ],
};

let toast;
let estado;

const montar = async (mudancas = {}) => {
  estado = { ...ESTADO, ...mudancas };
  api.get.mockImplementation(() => Promise.resolve({ data: estado }));
  render(
    <MemoryRouter initialEntries={['/relogio-mesa/d1/mesa/m1']}>
      <Routes>
        <Route path="/relogio-mesa/:dayId/mesa/:tableId" element={<RelogioDaMesa />} />
      </Routes>
    </MemoryRouter>,
  );
  await act(async () => {});
};

const tocar = (nome) => fireEvent.click(screen.getByRole('button', { name: nome }));
const digitos = () => document.querySelector('.rm-digitos:not(.rm-digitos--invertido)');
const centro = () => document.querySelector('.rm-oval');
const pergunta = () => document.querySelector('.rm-pergunta');
const passar = async (ms) => {
  await act(async () => { jest.advanceTimersByTime(ms); });
};
const esgotar = async () => {
  tocar('Nova mão');
  await passar(20500);
};
const assento = (nome) => within(document.querySelector('.rm-mesa-area')).getByRole('button', { name: nome });
const assentos = () => document.querySelectorAll('.rm-assento');
const envios = () => api.post.mock.calls.filter(([url]) => url.endsWith('/cards'));
const semRede = () => Object.assign(new Error('rede'), { userMessage: 'Sem conexão' });

beforeEach(() => {
  jest.useFakeTimers();
  localStorage.clear();
  toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn() };
  useToast.mockReturnValue({ toast });
  useRealtimeRefresh.mockReturnValue(jest.fn());
  const canal = { on: () => canal, subscribe: () => canal, track: jest.fn(), presenceState: () => ({}) };
  supabase.channel.mockReturnValue(canal);
  api.post.mockResolvedValue({ data: { event_id: 'ev1', cards: 1 } });
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
  console.error.mockRestore();
  console.warn.mockRestore();
});

describe('carga', () => {
  it('mostra a mesa, o nível e os blinds', async () => {
    await montar();
    expect(api.get).toHaveBeenCalledWith('/table-clock/table/m1');
    const topo = document.querySelector('.rm-topo');
    expect(topo).toHaveTextContent('Mesa 5');
    expect(topo).toHaveTextContent('Nível 2');
    expect(topo).toHaveTextContent('200/400');
  });

  it('atualiza sozinha quando a mesa ou os cartões mudam', async () => {
    await montar();
    const { tabelas, ativo } = useRealtimeRefresh.mock.calls.at(-1)[0];
    expect(ativo).toBe(true);
    expect(tabelas.map((x) => x.table)).toEqual(expect.arrayContaining([
      'tournament_days', 'tournament_players', 'tournament_tables', 'seat_allocations',
      'time_bank_events', 'table_clock_settings',
    ]));
  });

  it('falha ao carregar diz o motivo e não deixa tela em branco', async () => {
    api.get.mockRejectedValue(Object.assign(new Error('x'), { userMessage: 'Mesa não encontrada.' }));
    render(
      <MemoryRouter initialEntries={['/relogio-mesa/d1/mesa/m1']}>
        <Routes><Route path="/relogio-mesa/:dayId/mesa/:tableId" element={<RelogioDaMesa />} /></Routes>
      </MemoryRouter>,
    );
    await act(async () => {});
    expect(screen.getByRole('alert')).toHaveTextContent('Mesa não encontrada.');
  });

  it('relê a mesa quando o nível acaba: o intervalo não avisa o banco', async () => {
    const agora = Date.now() / 1000;
    await montar({ timer: { ...ESTADO.timer, level_ends_at: agora + 60, server_time: agora } });
    api.get.mockClear();
    await passar(62000);
    expect(api.get).toHaveBeenCalledWith('/table-clock/table/m1');
  });
});

describe('a mesa desenhada', () => {
  it('desenha todos os lugares da mesa, vazios inclusive', async () => {
    await montar();
    expect(assentos()).toHaveLength(9);
    expect(assento(/^3/)).toHaveTextContent('Ana');
    expect(assento(/^1/)).toHaveTextContent('Livre');
  });

  it('o apelido vale mais que o nome', async () => {
    await montar();
    expect(assento(/^7/)).toHaveTextContent('Betão');
  });

  it('cada assento mostra os cartões que restam', async () => {
    await montar();
    expect(assento(/Ana/)).toHaveTextContent('Cartões: 2');
  });

  it('assento bloqueado pelo floor aparece assim', async () => {
    await montar({ table: { ...ESTADO.table, blocked_seats: [5] } });
    expect(assento(/^5/)).toHaveTextContent('Bloqueado');
  });

  it('sem time bank, a mesa mostra os nomes e nenhum cartão', async () => {
    await montar({ time_bank: { available: false, reason: 'desligado' } });
    expect(assento(/Ana/)).not.toHaveTextContent('Cartões');
  });

  it('parado, o centro mostra o tempo do nível e os blinds', async () => {
    const servidor = Date.now() / 1000 + 100;
    await montar({ timer: { ...ESTADO.timer, server_time: servidor, level_ends_at: servidor + 578 } });
    expect(digitos()).toBeNull();
    expect(centro()).toHaveTextContent('9:38');
    expect(centro()).toHaveTextContent('Nível 2');
    expect(centro()).toHaveTextContent('200/400');
  });

  it('o tempo do nível corre pelo relógio do servidor', async () => {
    const servidor = Date.now() / 1000 + 100;
    await montar({ timer: { ...ESTADO.timer, server_time: servidor, level_ends_at: servidor + 578 } });
    await passar(2000);
    expect(centro()).toHaveTextContent('9:36');
  });

  it('pausado, o tempo do nível fica parado no que restava', async () => {
    await montar({ timer: { ...ESTADO.timer, is_paused: true, time_remaining: 300 } });
    await passar(3000);
    expect(centro()).toHaveTextContent('5:00');
  });

  it('no intervalo o centro diz que é intervalo', async () => {
    await montar({ timer: { ...ESTADO.timer, is_break: true } });
    expect(centro()).toHaveTextContent('Intervalo');
  });

  it('fora da escolha, tocar no assento não gasta cartão', async () => {
    await montar();
    tocar('Nova mão');
    expect(assento(/Ana/)).toBeDisabled();
    fireEvent.click(assento(/Ana/));
    await passar(0);
    expect(envios()).toHaveLength(0);
  });

  it('o dealer não tem como eliminar nem trocar jogador de mesa', async () => {
    await montar();
    await esgotar();
    expect(screen.queryByRole('button', { name: /Eliminar|Trocar/ })).toBeNull();
  });
});

describe('contagem', () => {
  it('nova mão começa no tempo do pré-flop e desce', async () => {
    await montar();
    tocar('Nova mão');
    expect(digitos()).toHaveTextContent('20');
    await passar(3000);
    expect(digitos()).toHaveTextContent('17');
  });

  it('próxima ação volta ao tempo cheio', async () => {
    await montar();
    tocar('Nova mão');
    await passar(5000);
    tocar('Próxima ação');
    expect(digitos()).toHaveTextContent('20');
  });

  it('flop passa para o tempo do pós-flop', async () => {
    await montar();
    tocar('Nova mão');
    tocar('Flop');
    expect(digitos()).toHaveTextContent('30');
    expect(document.querySelector('.rm-rotulo')).toHaveTextContent('Pós-flop');
  });

  it('pausar segura a contagem e retomar continua', async () => {
    await montar();
    tocar('Nova mão');
    await passar(5000);
    tocar('Pausar');
    await passar(10000);
    expect(digitos()).toHaveTextContent('15');
    tocar('Retomar');
    await passar(1000);
    expect(digitos()).toHaveTextContent('14');
  });

  it('o relógio segue contando com a rede fora', async () => {
    await montar();
    api.get.mockRejectedValue(semRede());
    tocar('Nova mão');
    await passar(5000);
    expect(digitos()).toHaveTextContent('15');
  });

  it('relógio chamado conta o tempo próprio e diz o que é', async () => {
    await montar();
    tocar('Relógio chamado');
    expect(digitos()).toHaveTextContent('30');
    expect(document.querySelector('.rm-rotulo')).toHaveTextContent('Relógio chamado');
  });

  it('os segundos finais mudam a cor da tela', async () => {
    await montar();
    tocar('Nova mão');
    await passar(11000);
    expect(document.querySelector('.rm-tela')).toHaveClass('rm-tela--aviso');
    await passar(5000);
    expect(document.querySelector('.rm-tela')).toHaveClass('rm-tela--urgente');
  });
});

describe('tempo esgotado', () => {
  it('pede o assento de quem vai usar o cartão', async () => {
    await montar();
    await esgotar();
    expect(pergunta()).toHaveTextContent('Quem vai usar o cartão?');
    expect(assento(/Ana/)).toBeEnabled();
  });

  it('o cartão soma o tempo, desconta e vai ao servidor', async () => {
    await montar();
    await esgotar();
    fireEvent.click(assento(/Ana/));
    expect(digitos()).toHaveTextContent('30');
    expect(pergunta()).toBeNull();
    await passar(0);
    expect(envios()).toHaveLength(1);
    expect(envios()[0][0]).toBe('/table-clock/table/m1/cards');
    expect(envios()[0][1]).toMatchObject({ tournament_player_id: 'tp1' });
    expect(envios()[0][1].client_event_id).toBeTruthy();
  });

  it('jogador sem cartão não pode ser escolhido', async () => {
    await montar();
    await esgotar();
    expect(assento(/Betão/)).toBeDisabled();
  });

  it('lugar vazio não pode ser escolhido', async () => {
    await montar();
    await esgotar();
    expect(assento(/^1/)).toBeDisabled();
  });

  it('chegou ao máximo da decisão: ninguém mais pode usar', async () => {
    await montar({ settings: { ...ESTADO.settings, max_cards_per_decision: 1 } });
    await esgotar();
    fireEvent.click(assento(/Ana/));
    tocar('Time bank');
    expect(assento(/Ana/)).toBeDisabled();
    expect(pergunta()).toHaveTextContent('máximo');
  });

  it('sem usar cartão, o floor decide: a tela não mata a mão', async () => {
    await montar();
    await esgotar();
    tocar('Chamar o floor');
    expect(pergunta()).toBeNull();
    expect(digitos()).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('o jogador pode pedir o cartão antes de o tempo acabar', async () => {
    await montar();
    tocar('Nova mão');
    await passar(5000);
    tocar('Time bank');
    fireEvent.click(assento(/Ana/));
    expect(digitos()).toHaveTextContent('45');
  });

  it('com o tempo correndo, a contagem continua à vista na escolha', async () => {
    await montar();
    tocar('Nova mão');
    await passar(5000);
    tocar('Time bank');
    expect(digitos()).toHaveTextContent('15');
  });

  it('fechar a escolha sem usar não gasta nada', async () => {
    await montar();
    tocar('Nova mão');
    tocar('Time bank');
    tocar('Voltar');
    expect(pergunta()).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe('rede fora', () => {
  it('o cartão fica no aparelho, e o saldo na tela já desconta', async () => {
    api.post.mockRejectedValue(semRede());
    await montar();
    await esgotar();
    fireEvent.click(assento(/Ana/));
    await passar(0);
    expect(lerFila()).toHaveLength(1);
    expect(assento(/Ana/)).toHaveTextContent('Cartões: 1');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('o dealer vê que há cartão esperando a rede', async () => {
    api.post.mockRejectedValue(semRede());
    await montar();
    await esgotar();
    fireEvent.click(assento(/Ana/));
    await passar(0);
    expect(document.querySelector('.rm-pendentes')).toHaveTextContent('Cartões a enviar: 1');
  });

  it('reenvia sozinho com o mesmo id quando a rede volta', async () => {
    api.post.mockRejectedValueOnce(semRede());
    await montar();
    await esgotar();
    fireEvent.click(assento(/Ana/));
    await passar(0);
    const id = envios()[0][1].client_event_id;
    await act(async () => { window.dispatchEvent(new Event('online')); });
    expect(envios()).toHaveLength(2);
    expect(envios()[1][1].client_event_id).toBe(id);
    expect(lerFila()).toEqual([]);
  });

  it('reenvia de tempos em tempos, mesmo sem o aviso do navegador', async () => {
    api.post.mockRejectedValueOnce(semRede());
    await montar();
    await esgotar();
    fireEvent.click(assento(/Ana/));
    await passar(0);
    await passar(16000);
    expect(lerFila()).toEqual([]);
  });

  it('cartão guardado de antes é enviado ao abrir a tela', async () => {
    localStorage.setItem('relogio_cartoes_pendentes', JSON.stringify([
      { client_event_id: 'antigo', table_id: 'm1', tournament_player_id: 'tp1' },
    ]));
    await montar();
    expect(envios()[0][1].client_event_id).toBe('antigo');
    expect(lerFila()).toEqual([]);
  });

  it('recusa do servidor tira da fila e avisa: reenviar não resolveria', async () => {
    api.post.mockRejectedValue(Object.assign(new Error('x'), {
      response: { status: 409 }, userMessage: 'Este jogador não tem cartões.',
    }));
    await montar();
    await esgotar();
    fireEvent.click(assento(/Ana/));
    await passar(0);
    expect(lerFila()).toEqual([]);
    expect(toast.error).toHaveBeenCalledWith('Este jogador não tem cartões.');
  });
});

describe('desfazer', () => {
  it('avisa quem usou', async () => {
    await montar();
    await esgotar();
    fireEvent.click(assento(/Ana/));
    expect(document.querySelector('.rm-ultimo')).toHaveTextContent('Ana');
  });

  it('toque errado devolve o cartão e o tempo', async () => {
    await montar();
    await esgotar();
    fireEvent.click(assento(/Ana/));
    await passar(0);
    await act(async () => { tocar('Desfazer'); });
    expect(api.post).toHaveBeenCalledWith('/table-clock/events/ev1/undo');
    expect(pergunta()).not.toBeNull();
  });

  it('sem rede, o cartão ainda não enviado só sai da fila', async () => {
    api.post.mockRejectedValue(semRede());
    await montar();
    await esgotar();
    fireEvent.click(assento(/Ana/));
    await passar(0);
    await act(async () => { tocar('Desfazer'); });
    expect(lerFila()).toEqual([]);
    expect(api.post).not.toHaveBeenCalledWith(expect.stringContaining('/undo'));
  });

  it('o aviso some na próxima ação', async () => {
    await montar();
    await esgotar();
    fireEvent.click(assento(/Ana/));
    tocar('Próxima ação');
    expect(document.querySelector('.rm-ultimo')).toBeNull();
  });
});

describe('quando o relógio não pode rodar', () => {
  it('no intervalo tudo trava e diz por quê', async () => {
    await montar({ timer: { ...ESTADO.timer, is_break: true } });
    expect(screen.getByRole('button', { name: 'Próxima ação' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Relógio chamado' })).toBeDisabled();
    expect(document.querySelector('.rm-aviso')).toHaveTextContent('Intervalo');
  });

  it('começar o intervalo para a contagem que estava rodando', async () => {
    const carregar = async () => useRealtimeRefresh.mock.calls.at(-1)[0].aoMudar();
    await montar();
    tocar('Nova mão');
    estado = { ...estado, timer: { ...ESTADO.timer, is_break: true } };
    await act(carregar);
    expect(digitos()).toBeNull();
    expect(document.querySelector('.rm-tela')).not.toHaveClass('rm-tela--urgente');
  });

  it('torneio pausado trava', async () => {
    await montar({ timer: { ...ESTADO.timer, is_paused: true } });
    expect(screen.getByRole('button', { name: 'Nova mão' })).toBeDisabled();
    expect(document.querySelector('.rm-aviso')).toHaveTextContent('Torneio pausado');
  });

  it('antes do nível de início, só o relógio chamado funciona', async () => {
    await montar({ clock_active: false, settings: { ...ESTADO.settings, start_level: 8 } });
    expect(screen.getByRole('button', { name: 'Nova mão' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Relógio chamado' })).toBeEnabled();
    expect(document.querySelector('.rm-aviso')).toHaveTextContent('nível 8');
  });

  it('desligado no dia diz isso e onde ligar', async () => {
    await montar({ clock_active: false, settings: { ...ESTADO.settings, enabled: false } });
    expect(document.querySelector('.rm-aviso')).toHaveTextContent('desligado');
    expect(document.querySelector('.rm-aviso')).toHaveTextContent('Configuração do dia');
  });

  it('o motivo aparece no centro da mesa, onde o dealer está olhando', async () => {
    await montar({ clock_active: false, settings: { ...ESTADO.settings, enabled: false } });
    expect(document.querySelector('.rm-oval .rm-aviso')).not.toBeNull();
  });

  it('torneio que ainda não começou diz para iniciar no Controle', async () => {
    await montar({ timer: { ...ESTADO.timer, is_paused: true, started: false } });
    const aviso = document.querySelector('.rm-aviso');
    expect(aviso).toHaveTextContent('ainda não começou');
    expect(aviso).toHaveTextContent('Controle');
    expect(screen.getByRole('button', { name: 'Próxima ação' })).toBeDisabled();
  });

  it('pausado de verdade diz que volta quando o Controle retomar', async () => {
    await montar({ timer: { ...ESTADO.timer, is_paused: true } });
    expect(document.querySelector('.rm-aviso')).toHaveTextContent('Torneio pausado');
    expect(document.querySelector('.rm-aviso')).toHaveTextContent('retomar');
  });

  it('servidor antigo, sem dizer se começou: trata como pausado', async () => {
    const { started, ...semInicio } = ESTADO.timer;
    await montar({ timer: { ...semInicio, is_paused: true } });
    expect(document.querySelector('.rm-aviso')).toHaveTextContent('Torneio pausado');
  });

  it('com o relógio liberado, nenhum aviso', async () => {
    await montar();
    expect(document.querySelector('.rm-aviso')).toBeNull();
  });
});

describe('torneio sem time bank', () => {
  const SEM_BANCO = { time_bank: { available: false, reason: 'eliminacao_em_massa' }, seats: [] };

  it('não oferece o botão', async () => {
    await montar(SEM_BANCO);
    expect(screen.queryByRole('button', { name: 'Time bank' })).toBeNull();
  });

  it('a mesa continua desenhada, só com os números', async () => {
    await montar(SEM_BANCO);
    expect(assentos()).toHaveLength(9);
  });

  it('não diz que os lugares estão livres: o sistema só não sabe quem está sentado', async () => {
    await montar(SEM_BANCO);
    expect(document.querySelector('.rm-mesa-area')).not.toHaveTextContent('Livre');
  });

  it('tempo esgotado só manda chamar o floor', async () => {
    await montar(SEM_BANCO);
    await esgotar();
    expect(pergunta()).toHaveTextContent('Chame o floor');
    expect(screen.getByRole('button', { name: 'Chamar o floor' })).toBeInTheDocument();
  });
});

describe('o aparelho', () => {
  it('pede para a tela ficar acesa', async () => {
    const release = jest.fn();
    const request = jest.fn().mockResolvedValue({ release });
    Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true });
    await montar();
    expect(request).toHaveBeenCalledWith('screen');
    delete navigator.wakeLock;
  });

  it('aparelho sem esse recurso funciona igual', async () => {
    await montar();
    expect(screen.getByRole('button', { name: 'Nova mão' })).toBeEnabled();
  });

  it('espelhar mostra a contagem também para o outro lado da mesa', async () => {
    await montar();
    fireEvent.click(screen.getByLabelText('Espelhar'));
    tocar('Nova mão');
    expect(document.querySelector('.rm-digitos--invertido')).toHaveTextContent('20');
  });

  it('a escolha fica guardada no aparelho', async () => {
    await montar();
    fireEvent.click(screen.getByLabelText('Espelhar'));
    expect(localStorage.getItem('relogio_espelhar')).toBe('1');
  });

  it('o som começa desligado: bipe na mesa incomoda os jogadores', async () => {
    await montar();
    expect(screen.getByLabelText('Som')).not.toBeChecked();
  });

  it('avisa o painel do floor que esta mesa está com o relógio aberto', async () => {
    await montar();
    expect(supabase.channel).toHaveBeenCalledWith(
      'relogio-dia-d1', { config: { presence: { key: 'm1' } } },
    );
  });
});
