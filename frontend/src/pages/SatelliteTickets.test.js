/**
 * Tickets de satélite — a vaga ganhada num torneio menor, resgatada em outro.
 *
 * O ticket é uma entrada JÁ PAGA por alguém: quem bancou (o `funded_by`) é
 * quem sustenta o dinheiro que vai entrar no pool do torneio-destino. Isso
 * governa o comportamento que os testes prendem:
 *
 * - **Ao resgatar, o financiador só é pedido se o ticket ainda não tem um.**
 *   Tickets novos já nascem com o financiador anexado; mandar o campo em
 *   branco por cima sobrescreveria essa informação. Tickets antigos (de antes
 *   do campo existir) precisam do preenchimento manual.
 * - **Só ticket disponível pode ser cancelado.** Cancelar um já resgatado
 *   apagaria uma entrada que já virou fichas na mesa.
 * - **Escolher o dia-destino revela o valor do ticket**, que é o buy-in
 *   daquele dia — é a conferência de que a vaga vale o que se espera.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SatelliteTickets from './SatelliteTickets';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() },
}));
jest.mock('../components/Sidebar', () => () => <nav data-testid="sidebar" />);
jest.mock('../components/PlayerSelect', () => ({ value, onChange, name }) => (
  <select
    aria-label="jogador"
    value={value}
    onChange={(e) => onChange({ target: { name: name || 'player_id', value: e.target.value } })}
  >
    <option value="">—</option>
    <option value="p1">Ana</option>
  </select>
));
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));
jest.mock('react-i18next', () => {
  const t = (chave) => chave;
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const TICKETS = [
  { id: 'tk1', player_name: 'Ana', player_nickname: 'Aninha', target_tournament_name: 'Main Event',
    target_day_name: 'Dia Final', ticket_value: 1000, status: 'awarded',
    won_at: 'Satélite de quarta', funded_by: 'Clube', created_at: '2026-06-01T00:00:00Z' },
  { id: 'tk2', target_tournament_name: 'Main Event', ticket_value: 1000, status: 'redeemed',
    created_at: '2026-06-02T00:00:00Z' },
  { id: 'tk3', player_name: 'Beto', target_tournament_name: 'Turbo', ticket_value: 500,
    status: 'cancelled', created_at: '2026-06-03T00:00:00Z' },
];

const TORNEIOS = [{ id: 't1', name: 'Main Event' }];
const DIAS = [{ id: 'd1', day_name: 'Dia Final', buy_in: 1000 }];
const RESUMO = { total_available: 4, total_redeemed: 7, total_cancelled: 1 };

const DISPONIVEIS = [
  { id: 'tk1', player_name: 'Ana', target_tournament_name: 'Main Event',
    target_day_name: 'Dia Final', ticket_value: 1000, won_at: 'Satélite de quarta',
    funded_by: 'Clube' },
  { id: 'tk9', player_name: 'Antigo', target_tournament_name: 'Main Event',
    ticket_value: 1000, funded_by: null },
];

let toast;

const responder = ({
  tickets = TICKETS, torneios = TORNEIOS, dias = DIAS, resumo = RESUMO,
  disponiveis = DISPONIVEIS,
} = {}) => {
  api.get.mockImplementation((url) => {
    if (url === '/satellite-tickets/available') {
      return disponiveis instanceof Error
        ? Promise.reject(disponiveis)
        : Promise.resolve({ data: disponiveis });
    }
    if (url === '/satellite-tickets/summary') return Promise.resolve({ data: resumo });
    if (url.startsWith('/satellite-tickets')) {
      return tickets instanceof Error ? Promise.reject(tickets) : Promise.resolve({ data: tickets });
    }
    if (url === '/tournaments') return Promise.resolve({ data: torneios });
    if (url.startsWith('/tournament-days/tournament/')) return Promise.resolve({ data: dias });
    return Promise.resolve({ data: [] });
  });
};

const erroHttp = (detail) => {
  const e = new Error('http');
  e.response = { data: { detail } };
  return e;
};

const montar = async (opcoes) => {
  responder(opcoes);
  render(<SatelliteTickets />);
  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/satellite-tickets/summary'));
  await waitFor(() => expect(document.querySelector('.skeleton-row')).toBeNull());
};

/**
 * Acha o <select> do modal que oferece uma dada opção. Indexar por posição
 * quebraria: o seletor de jogador (mockado) também é um <select>.
 */
const seletorComOpcao = (valor) =>
  Array.from(document.querySelectorAll('.modal select')).find((sel) =>
    Array.from(sel.options).some((o) => o.value === valor)
  );

const linhaDoTicket = (texto) =>
  Array.from(document.querySelectorAll('.transactions-table tbody tr')).find((tr) =>
    tr.textContent.includes(texto)
  );

beforeEach(() => {
  toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn() };
  useToast.mockReturnValue({ toast });
  useCurrency.mockReturnValue({ formatCurrency: (v) => `R$ ${Number(v || 0).toFixed(2)}` });
  api.post.mockResolvedValue({ data: {} });
  jest.spyOn(window, 'confirm').mockReturnValue(true);
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  window.confirm.mockRestore();
  console.error.mockRestore();
});

describe('lista e resumo', () => {
  it('mostra disponíveis, resgatados e cancelados', async () => {
    await montar();
    const cartoes = document.querySelectorAll('.stat-card');
    expect(cartoes[0]).toHaveTextContent('4');
    expect(cartoes[1]).toHaveTextContent('7');
    expect(cartoes[2]).toHaveTextContent('1');
  });

  it('cada ticket mostra jogador, destino e valor', async () => {
    await montar();
    const linha = linhaDoTicket('Ana');
    expect(linha).toHaveTextContent('Main Event');
    expect(linha).toHaveTextContent('R$ 1000.00');
    expect(within(linha).getByText('(Aninha)')).toBeInTheDocument();
  });

  it('ticket sem jogador ainda definido é sinalizado', async () => {
    // O clube pode emitir a vaga antes de saber quem ganhou.
    await montar();
    expect(linhaDoTicket('Main Event')).toBeDefined();
    expect(document.querySelectorAll('.st-unassigned').length).toBeGreaterThan(0);
  });

  it('o status é traduzido em etiqueta', async () => {
    await montar();
    expect(within(linhaDoTicket('Ana')).getByText('satelliteTickets.badgeAvailable')).toBeInTheDocument();
    expect(within(linhaDoTicket('Beto')).getByText('satelliteTickets.badgeCancelled')).toBeInTheDocument();
  });

  it('status desconhecido não some da tela', async () => {
    await montar({
      tickets: [{ id: 'tk9', target_tournament_name: 'X', ticket_value: 1, status: 'em_disputa',
        created_at: '2026-06-01T00:00:00Z' }],
    });
    expect(await screen.findByText('em_disputa')).toBeInTheDocument();
  });

  it('sem ticket nenhum explica o que fazer', async () => {
    await montar({ tickets: [] });
    expect(screen.getByText('satelliteTickets.emptyTitle')).toBeInTheDocument();
  });

  it('falhas de carga não derrubam a tela', async () => {
    // As três consultas são independentes; uma delas caindo não pode apagar
    // a tela inteira.
    await montar({ tickets: new Error('500') });
    expect(screen.getByText('satelliteTickets.emptyTitle')).toBeInTheDocument();
  });
});

describe('filtros', () => {
  it('os filtros escolhidos viajam na consulta', async () => {
    await montar();
    await userEvent.selectOptions(document.querySelectorAll('.st-filters select')[0], 'redeemed');
    await userEvent.selectOptions(document.querySelectorAll('.st-filters select')[1], 't1');
    await userEvent.click(screen.getByRole('button', { name: 'common.filter' }));
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith(
        expect.stringMatching(/satellite-tickets\?.*status=redeemed.*target_tournament_id=t1/)
      )
    );
  });

  it('limpar zera os filtros', async () => {
    await montar();
    await userEvent.selectOptions(document.querySelectorAll('.st-filters select')[0], 'redeemed');
    await userEvent.click(screen.getByRole('button', { name: 'satelliteTickets.clear' }));
    expect(document.querySelectorAll('.st-filters select')[0]).toHaveValue('');
  });

  it('falha ao filtrar não apaga a lista atual', async () => {
    await montar();
    api.get.mockRejectedValue(new Error('500'));
    await userEvent.click(screen.getByRole('button', { name: 'common.filter' }));
    await waitFor(() => expect(console.error).toHaveBeenCalled());
    expect(linhaDoTicket('Ana')).toBeDefined();
  });
});

describe('emitir ticket', () => {
  const abrir = () => userEvent.click(screen.getByRole('button', { name: 'satelliteTickets.registerTicket' }));

  it('escolher o torneio carrega os dias dele', async () => {
    await montar();
    await abrir();
    await userEvent.selectOptions(seletorComOpcao('t1'), 't1');
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/tournament-days/tournament/t1')
    );
  });

  it('escolher o dia revela o valor do ticket', async () => {
    // O valor é o buy-in daquele dia; é a conferência de que a vaga vale o
    // que se espera.
    await montar();
    await abrir();
    await userEvent.selectOptions(seletorComOpcao('t1'), 't1');
    await waitFor(() => expect(seletorComOpcao('d1')).toBeTruthy());
    await userEvent.selectOptions(seletorComOpcao('d1'), 'd1');
    expect(document.querySelector('.st-info-box')).toHaveTextContent('R$ 1000.00');
  });

  it('emite o ticket com jogador, destino e financiador', async () => {
    await montar();
    await abrir();
    await userEvent.selectOptions(screen.getByLabelText('jogador'), 'p1');
    await userEvent.selectOptions(seletorComOpcao('t1'), 't1');
    await waitFor(() => expect(seletorComOpcao('d1')).toBeTruthy());
    await userEvent.selectOptions(seletorComOpcao('d1'), 'd1');
    await userEvent.type(screen.getByPlaceholderText('satelliteTickets.wonAtPlaceholder'), 'Satélite de quarta');
    await userEvent.type(screen.getByPlaceholderText('satelliteTickets.fundedByPlaceholder'), 'Clube');
    await userEvent.click(screen.getByRole('button', { name: 'satelliteTickets.submitCreate' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/satellite-tickets', expect.objectContaining({
        player_id: 'p1', target_tournament_id: 't1', target_tournament_day_id: 'd1',
        funded_by: 'Clube',
      }))
    );
    expect(toast.success).toHaveBeenCalledWith('satelliteTickets.toastCreated');
  });

  it('erro do servidor mostra o motivo', async () => {
    api.post.mockRejectedValue(erroHttp('Dia já lotado'));
    await montar();
    await abrir();
    await userEvent.selectOptions(screen.getByLabelText('jogador'), 'p1');
    await userEvent.selectOptions(seletorComOpcao('t1'), 't1');
    await waitFor(() => expect(seletorComOpcao('d1')).toBeTruthy());
    await userEvent.selectOptions(seletorComOpcao('d1'), 'd1');
    await userEvent.type(screen.getByPlaceholderText('satelliteTickets.wonAtPlaceholder'), 'Satélite');
    await userEvent.type(screen.getByPlaceholderText('satelliteTickets.fundedByPlaceholder'), 'Clube');
    await userEvent.click(screen.getByRole('button', { name: 'satelliteTickets.submitCreate' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Dia já lotado'));
  });

  it('a emissão só libera com origem e financiador preenchidos', async () => {
    // Sem saber de onde veio a vaga e quem a bancou, o ticket não tem lastro.
    await montar();
    await abrir();
    await userEvent.selectOptions(screen.getByLabelText('jogador'), 'p1');
    await userEvent.selectOptions(seletorComOpcao('t1'), 't1');
    await waitFor(() => expect(seletorComOpcao('d1')).toBeTruthy());
    await userEvent.selectOptions(seletorComOpcao('d1'), 'd1');
    expect(screen.getByRole('button', { name: 'satelliteTickets.submitCreate' })).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText('satelliteTickets.wonAtPlaceholder'), 'Satélite');
    await userEvent.type(screen.getByPlaceholderText('satelliteTickets.fundedByPlaceholder'), 'Clube');
    expect(screen.getByRole('button', { name: 'satelliteTickets.submitCreate' })).toBeEnabled();
  });

  it('fechar não emite nada', async () => {
    // "Cancelar" do modal e "Cancelar" da linha do ticket têm o mesmo rótulo.
    await montar();
    await abrir();
    await userEvent.click(
      within(document.querySelector('.modal')).getByRole('button', { name: 'satelliteTickets.cancelAction' })
    );
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe('resgatar ticket', () => {
  const abrir = async () => {
    await userEvent.click(screen.getByRole('button', { name: 'satelliteTickets.redeemTicket' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/satellite-tickets/available'));
  };

  const escolherTicket = async (id) => userEvent.selectOptions(seletorComOpcao(id), id);

  it('só oferece tickets ainda disponíveis', async () => {
    // Resgatar um ticket já usado geraria uma segunda entrada de graça.
    await montar();
    await abrir();
    expect(api.get).toHaveBeenCalledWith('/satellite-tickets/available');
  });

  it('sem ticket disponível, a tela diz isso', async () => {
    await montar({ disponiveis: [] });
    await abrir();
    expect(await screen.findByText('satelliteTickets.noTicketsToRedeem')).toBeInTheDocument();
  });

  it('escolher o ticket mostra os detalhes antes de confirmar', async () => {
    // O operador confere jogador, destino e valor antes de dar a entrada.
    await montar();
    await abrir();
    await escolherTicket('tk1');
    const detalhe = document.querySelector('.st-info-box--detail');
    expect(detalhe).toHaveTextContent('Ana');
    expect(detalhe).toHaveTextContent('Main Event');
    expect(detalhe).toHaveTextContent('R$ 1000.00');
  });

  it('ticket que JÁ TEM financiador não pede o campo de novo', async () => {
    // Mandar em branco por cima sobrescreveria quem bancou a vaga.
    await montar();
    await abrir();
    await escolherTicket('tk1');
    expect(screen.queryByPlaceholderText('satelliteTickets.legacyFundedByPlaceholder')).toBeNull();
  });

  it('ticket ANTIGO sem financiador pede o preenchimento', async () => {
    await montar();
    await abrir();
    await escolherTicket('tk9');
    expect(screen.getByPlaceholderText('satelliteTickets.legacyFundedByPlaceholder')).toBeInTheDocument();
  });

  it('resgatar um ticket completo não manda financiador nenhum', async () => {
    await montar();
    await abrir();
    await escolherTicket('tk1');
    await userEvent.click(screen.getByRole('button', { name: 'satelliteTickets.submitRedeem' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/satellite-tickets/tk1/redeem', {})
    );
  });

  it('no ticket antigo, o financiador digitado vai junto', async () => {
    await montar();
    await abrir();
    await escolherTicket('tk9');
    await userEvent.type(
      screen.getByPlaceholderText('satelliteTickets.legacyFundedByPlaceholder'),
      '  Patrocinador X  '
    );
    await userEvent.click(screen.getByRole('button', { name: 'satelliteTickets.submitRedeem' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/satellite-tickets/tk9/redeem', {
        funded_by: 'Patrocinador X',
      })
    );
  });

  it('a mensagem do servidor é preferida à genérica', async () => {
    // O backend informa em qual dia a entrada foi criada; a frase padrão
    // perderia essa informação.
    api.post.mockResolvedValue({ data: { message: 'Entrada criada no Dia Final' } });
    await montar();
    await abrir();
    await escolherTicket('tk1');
    await userEvent.click(screen.getByRole('button', { name: 'satelliteTickets.submitRedeem' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Entrada criada no Dia Final'));
  });

  it('erro no resgate mostra o motivo', async () => {
    api.post.mockRejectedValue(erroHttp('Ticket expirado'));
    await montar();
    await abrir();
    await escolherTicket('tk1');
    await userEvent.click(screen.getByRole('button', { name: 'satelliteTickets.submitRedeem' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Ticket expirado'));
  });

  it('falha ao listar disponíveis não trava o modal', async () => {
    await montar({ disponiveis: new Error('500') });
    await abrir();
    expect(await screen.findByText('satelliteTickets.noTicketsToRedeem')).toBeInTheDocument();
  });
});

describe('cancelar ticket', () => {
  it('só ticket DISPONÍVEL pode ser cancelado', async () => {
    // Cancelar um já resgatado apagaria uma entrada que virou fichas na mesa.
    await montar();
    expect(within(linhaDoTicket('Ana')).getByText('satelliteTickets.cancelAction')).toBeInTheDocument();
    expect(within(linhaDoTicket('Beto')).queryByText('satelliteTickets.cancelAction')).toBeNull();
  });

  it('cancelar pede confirmação', async () => {
    await montar();
    await userEvent.click(within(linhaDoTicket('Ana')).getByText('satelliteTickets.cancelAction'));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/satellite-tickets/tk1/cancel'));
    expect(toast.success).toHaveBeenCalledWith('satelliteTickets.toastCancelled');
  });

  it('recusar não cancela', async () => {
    window.confirm.mockReturnValue(false);
    await montar();
    await userEvent.click(within(linhaDoTicket('Ana')).getByText('satelliteTickets.cancelAction'));
    expect(api.post).not.toHaveBeenCalled();
  });

  it('erro ao cancelar mostra o motivo', async () => {
    api.post.mockRejectedValue(erroHttp('Ticket já resgatado'));
    await montar();
    await userEvent.click(within(linhaDoTicket('Ana')).getByText('satelliteTickets.cancelAction'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Ticket já resgatado'));
  });
});
