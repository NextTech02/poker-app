/**
 * A FILA DE ESPERA na tela.
 *
 * O que estes testes travam:
 *
 * 1. **A posição vem do servidor, não do índice da lista.** Se a tela
 *    numerasse por posição no array, alguém saindo faria todo mundo subir — e
 *    o número que o jogador ouviu no balcão deixaria de bater com o da tela.
 * 2. **Visitante entra só com o nome**, e a tela diz que ele não pode ter
 *    cadeira reservada. Deixar o botão ativo produziria um clique que sempre
 *    falha.
 * 3. **Reservar não é sentar** — e o modal precisa AFIRMAR isso, senão o
 *    operador acha que já registrou a entrada e o jogador senta sem ter pago.
 * 4. **A reserva tem prazo**, e a tela explica que a cadeira volta sozinha.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CashWaitlist from './CashWaitlist';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useCashDay } from '../contexts/CashDayContext';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock('../components/Sidebar', () => () => <div data-testid="sidebar" />);
jest.mock('../components/PlayerSelect', () => ({ value, onChange }) => (
  <input
    aria-label="Jogador"
    value={value || ''}
    onChange={(e) => onChange({ target: { name: 'player_id', value: e.target.value } })}
  />
));
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../contexts/CashDayContext', () => ({ useCashDay: jest.fn() }));
jest.mock('../hooks/usePolling', () => () => {});
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (chave, padrao, vars) => {
      if (typeof padrao !== 'string') return chave;
      return padrao.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars ? vars[k] : ''));
    },
  }),
}));

const DIA = 'dia-1';

const MESA = {
  id: 'mesa-1', table_number: 3, seats: 9, free_seats: 5,
  game_type_name: 'NLH 1/2', status: 'open',
};

const entrada = (over = {}) => ({
  id: 'f1', cash_day_id: DIA, player_id: 'p1', guest_name: null,
  position: 4, status: 'waiting', game_type_id: null, table_id: null,
  player_name: 'Ana', game_type_name: 'NLH 1/2', table_number: null,
  ...over,
});

const montar = ({ fila = [entrada()], mesas = [MESA], dia = { id: DIA, status: 'open' } } = {}) => {
  useCashDay.mockReturnValue({
    cashDayId: dia?.id || null,
    isOpen: !!dia && dia.status === 'open',
    loading: false,
  });
  api.get.mockImplementation((url) => {
    if (url.includes('/waitlist')) return Promise.resolve({ data: fila });
    if (url.includes('/tables')) return Promise.resolve({ data: mesas });
    return Promise.resolve({ data: [] });
  });
  return render(<CashWaitlist />);
};

beforeEach(() => {
  jest.clearAllMocks();
  useToast.mockReturnValue({ toast: { success: jest.fn(), error: jest.fn(), warning: jest.fn() } });
  api.post.mockResolvedValue({ data: {} });
  api.delete.mockResolvedValue({ data: {} });
});

describe('a fila', () => {
  it('mostra a posição que veio do servidor', async () => {
    // O primeiro da lista é o número 4: quem estava à frente já sentou. Numerar
    // pelo índice mostraria "1" e contradiria o que o jogador ouviu no balcão.
    montar();
    expect(await screen.findByText('4')).toBeInTheDocument();
    expect(screen.getByText('Ana')).toBeInTheDocument();
  });

  it('conta quantos estão esperando', async () => {
    montar({ fila: [entrada(), entrada({ id: 'f2', position: 5, player_name: 'Bruno' })] });
    expect(await screen.findByText(/^2 na fila/)).toBeInTheDocument();
  });

  it('quem já saiu não conta e fica no histórico', async () => {
    montar({ fila: [
      entrada(),
      entrada({ id: 'f2', position: 2, status: 'seated', player_name: 'Bruno' }),
    ] });
    expect(await screen.findByText(/^1 na fila/)).toBeInTheDocument();
    expect(screen.getByText('Já saíram da fila (1)')).toBeInTheDocument();
  });

  it('sem dia aberto não dá para anotar', async () => {
    montar({ dia: null });
    expect(await screen.findByText('Nenhum dia de operação aberto')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Adicionar à fila' })).toBeNull();
  });

  it('fila vazia convida a anotar', async () => {
    montar({ fila: [] });
    expect(await screen.findByText('Ninguém na fila')).toBeInTheDocument();
  });
});

describe('entrar na fila', () => {
  it('aceita jogador cadastrado', async () => {
    montar({ fila: [] });
    await userEvent.click(await screen.findByRole('button', { name: 'Adicionar à fila' }));
    await userEvent.type(screen.getByLabelText('Jogador'), 'jogador-9');
    const dialogo = screen.getByRole('dialog');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Adicionar à fila' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/cash-game/waitlist',
      expect.objectContaining({ player_id: 'jogador-9' }),
      expect.objectContaining({ params: { cash_day_id: DIA } }),
    ));
  });

  it('aceita visitante só com o nome', async () => {
    // Quem chega pela primeira vez não pode ficar esperando um cadastro para
    // ser anotado — senão o operador volta para o papel.
    montar({ fila: [] });
    await userEvent.click(await screen.findByRole('button', { name: 'Adicionar à fila' }));
    await userEvent.type(screen.getByLabelText('Ou apenas o nome'), 'Carlos');
    const dialogo = screen.getByRole('dialog');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Adicionar à fila' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/cash-game/waitlist',
      expect.objectContaining({ guest_name: 'Carlos', player_id: null }),
      expect.anything(),
    ));
  });

  it('sem jogador e sem nome não envia', async () => {
    montar({ fila: [] });
    await userEvent.click(await screen.findByRole('button', { name: 'Adicionar à fila' }));
    const dialogo = screen.getByRole('dialog');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Adicionar à fila' }));
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe('chamar e reservar', () => {
  it('chama quem está esperando', async () => {
    montar();
    await userEvent.click(await screen.findByRole('button', { name: 'Chamar' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/cash-game/waitlist/f1/call'));
  });

  it('quem já foi chamado não aparece com o botão de chamar', async () => {
    montar({ fila: [entrada({ status: 'called' })] });
    await screen.findByText('Ana');
    expect(screen.queryByRole('button', { name: 'Chamar' })).toBeNull();
    expect(screen.getByText('Chamado')).toBeInTheDocument();
  });

  it('reserva o lugar com prazo', async () => {
    montar({ fila: [entrada({ status: 'called' })] });
    await userEvent.click(await screen.findByRole('button', { name: 'Reservar lugar' }));
    await userEvent.selectOptions(screen.getByLabelText('Lugar'), '4');
    const dialogo = screen.getByRole('dialog');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Reservar lugar' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/cash-game/waitlist/f1/seat',
      { table_id: 'mesa-1', seat_number: 4, minutes: 10 },
    ));
  });

  it('o modal afirma que reservar não é sentar', async () => {
    // Sem isso o operador acha que já registrou a entrada e o jogador senta
    // sem ter pago.
    montar({ fila: [entrada({ status: 'called' })] });
    await userEvent.click(await screen.findByRole('button', { name: 'Reservar lugar' }));
    expect(screen.getByText(/compra das fichas continua sendo feita no caixa/)).toBeInTheDocument();
    expect(screen.getByText(/volta sozinha para a sala/)).toBeInTheDocument();
  });

  it('visitante sem cadastro não pode reservar', async () => {
    montar({ fila: [entrada({ player_id: null, guest_name: 'Carlos', player_name: 'Carlos' })] });
    await screen.findByText('Carlos');
    expect(screen.getByText('Sem cadastro')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reservar lugar' })).toBeDisabled();
  });

  it('sem mesa aberta não há onde reservar', async () => {
    montar({ mesas: [] });
    await screen.findByText('Ana');
    expect(screen.getByRole('button', { name: 'Reservar lugar' })).toBeDisabled();
  });
});

describe('sair da fila', () => {
  it('marcar que sentou encerra a espera', async () => {
    montar();
    await userEvent.click(await screen.findByRole('button', { name: 'Sentou' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/cash-game/waitlist/f1/seated'));
  });

  it('não compareceu tem ação própria e só para quem foi chamado', async () => {
    // O estado separado é o que explica ao próximo da fila por que ele passou
    // na frente de alguém.
    montar({ fila: [entrada({ status: 'called' })] });
    await userEvent.click(await screen.findByRole('button', { name: 'Não veio' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/cash-game/waitlist/f1/no-show'));
  });

  it('quem ainda não foi chamado não tem o botão de não compareceu', async () => {
    montar();
    await screen.findByText('Ana');
    expect(screen.queryByRole('button', { name: 'Não veio' })).toBeNull();
  });

  it('desistir remove da fila', async () => {
    montar();
    await userEvent.click(await screen.findByRole('button', { name: 'Saiu' }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/cash-game/waitlist/f1'));
  });
});
