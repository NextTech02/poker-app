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
import { usePermissions } from '../contexts/PermissionContext';
import { usePaymentMethods } from '../contexts/PaymentMethodsContext';

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
// Seleção múltipla: o teste só precisa do contrato (lista de ids que entra e
// sai); a busca por digitação tem teste próprio no componente.
jest.mock('../components/PlayerMultiSelect', () => ({ values, onChange }) => (
  <div data-testid="multi-jogadores">
    <span data-testid="multi-total">{values.length}</span>
    <button type="button" onClick={() => onChange([...values, `p${values.length + 1}`])}>
      somar-jogador
    </button>
  </div>
));
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));
jest.mock('../contexts/PermissionContext', () => ({ usePermissions: jest.fn() }));
jest.mock('../contexts/PaymentMethodsContext', () => ({ usePaymentMethods: jest.fn() }));
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

const HISTORICO_TROCAS = [
  { id: 'h1', kind: 'sale', amount: 200, from_player_name: 'Ana',
    to_player_name: 'Beto', created_at: '2026-06-04T00:00:00Z' },
];

const responder = ({
  tickets = TICKETS, torneios = TORNEIOS, dias = DIAS, resumo = RESUMO,
  disponiveis = DISPONIVEIS, trocas = HISTORICO_TROCAS,
} = {}) => {
  api.get.mockImplementation((url) => {
    if (url === '/satellite-tickets/available') {
      return disponiveis instanceof Error
        ? Promise.reject(disponiveis)
        : Promise.resolve({ data: disponiveis });
    }
    if (url === '/satellite-tickets/summary') return Promise.resolve({ data: resumo });
    if (url.endsWith('/transfers')) {
      return trocas instanceof Error
        ? Promise.reject(trocas)
        : Promise.resolve({ data: trocas });
    }
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

/** Liga o perfil "master" (quem pode emitir em lote). */
const comoMaster = () =>
  usePermissions.mockReturnValue({
    isAdmin: false,
    hasPermission: (p) => p === 'cashier_tickets.master',
  });

beforeEach(() => {
  toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn() };
  useToast.mockReturnValue({ toast });
  useCurrency.mockReturnValue({ formatCurrency: (v) => `R$ ${Number(v || 0).toFixed(2)}` });
  // Por padrão, operador de caixa comum: sem emissão em lote.
  usePermissions.mockReturnValue({ isAdmin: false, hasPermission: () => false });
  usePaymentMethods.mockReturnValue({
    activeMethods: [{ id: 'm1', code: 'pix', label: 'PIX' }],
  });
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

describe('emitir em lote (só master)', () => {
  const abrir = () => userEvent.click(screen.getByRole('button', { name: 'satelliteTickets.registerTicket' }));

  const preencherDestino = async () => {
    await userEvent.selectOptions(seletorComOpcao('t1'), 't1');
    await waitFor(() => expect(seletorComOpcao('d1')).toBeTruthy());
    await userEvent.selectOptions(seletorComOpcao('d1'), 'd1');
    await userEvent.type(screen.getByPlaceholderText('satelliteTickets.wonAtPlaceholder'), 'Satélite');
    await userEvent.type(screen.getByPlaceholderText('satelliteTickets.fundedByPlaceholder'), 'Clube');
  };

  it('operador de caixa comum não vê o modo lote', async () => {
    // Emitir 40 entradas já pagas num clique é decisão de dono; o backend
    // recusa, e oferecer o botão só geraria 403.
    await montar();
    await abrir();
    expect(screen.queryByRole('button', { name: 'satelliteTickets.bulkModeMultiple' })).toBeNull();
    expect(screen.getByLabelText('jogador')).toBeInTheDocument();
  });

  it('o master escolhe entre um e vários jogadores', async () => {
    comoMaster();
    await montar();
    await abrir();
    await userEvent.click(screen.getByRole('button', { name: 'satelliteTickets.bulkModeMultiple' }));
    expect(screen.getByTestId('multi-jogadores')).toBeInTheDocument();
    expect(screen.queryByLabelText('jogador')).toBeNull();
  });

  it('o lote mostra quantos jogadores e quanto custa antes de confirmar', async () => {
    // O valor total é o que o financiador vai bancar no pool do destino.
    comoMaster();
    await montar();
    await abrir();
    await userEvent.click(screen.getByRole('button', { name: 'satelliteTickets.bulkModeMultiple' }));
    await preencherDestino();
    await userEvent.click(screen.getByText('somar-jogador'));
    await userEvent.click(screen.getByText('somar-jogador'));
    const caixa = document.querySelectorAll('.st-info-box')[1];
    expect(caixa).toHaveTextContent('2');
    expect(caixa).toHaveTextContent('R$ 2000.00');
  });

  it('três jogadores viram UM post no endpoint de lote', async () => {
    comoMaster();
    api.post.mockResolvedValue({ data: { created: [{}, {}, {}], skipped: [], total_value: 3000 } });
    await montar();
    await abrir();
    await userEvent.click(screen.getByRole('button', { name: 'satelliteTickets.bulkModeMultiple' }));
    await preencherDestino();
    await userEvent.click(screen.getByText('somar-jogador'));
    await userEvent.click(screen.getByText('somar-jogador'));
    await userEvent.click(screen.getByText('somar-jogador'));
    await userEvent.click(screen.getByRole('button', { name: 'satelliteTickets.bulkSubmit' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/satellite-tickets/bulk', expect.objectContaining({
        player_ids: ['p1', 'p2', 'p3'],
        target_tournament_id: 't1',
        target_tournament_day_id: 'd1',
        funded_by: 'Clube',
      }))
    );
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.modal')).toBeNull();
  });

  it('sem jogador escolhido o lote não é enviado', async () => {
    comoMaster();
    await montar();
    await abrir();
    await userEvent.click(screen.getByRole('button', { name: 'satelliteTickets.bulkModeMultiple' }));
    await preencherDestino();
    expect(screen.getByRole('button', { name: 'satelliteTickets.bulkSubmit' })).toBeDisabled();
  });

  it('lote parcial avisa quem ficou de fora', async () => {
    // Ignorados em silêncio viram jogador sem vaga na hora de sentar à mesa.
    comoMaster();
    api.post.mockResolvedValue({
      data: { created: [{}, {}], skipped: [{ player_id: 'p3', reason: 'jogador_nao_encontrado' }] },
    });
    await montar();
    await abrir();
    await userEvent.click(screen.getByRole('button', { name: 'satelliteTickets.bulkModeMultiple' }));
    await preencherDestino();
    await userEvent.click(screen.getByText('somar-jogador'));
    await userEvent.click(screen.getByRole('button', { name: 'satelliteTickets.bulkSubmit' }));
    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalled();
  });

  it('lote que não emitiu nada mantém o modal aberto para correção', async () => {
    comoMaster();
    api.post.mockResolvedValue({ data: { created: [], skipped: [{ player_id: 'p1', reason: 'x' }] } });
    await montar();
    await abrir();
    await userEvent.click(screen.getByRole('button', { name: 'satelliteTickets.bulkModeMultiple' }));
    await preencherDestino();
    await userEvent.click(screen.getByText('somar-jogador'));
    await userEvent.click(screen.getByRole('button', { name: 'satelliteTickets.bulkSubmit' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('satelliteTickets.bulkNoneCreated'));
    expect(document.querySelector('.modal')).not.toBeNull();
  });

  it('erro do servidor no lote mostra o motivo e não fecha o modal', async () => {
    comoMaster();
    api.post.mockRejectedValue(erroHttp('Você não tem permissão para acessar este recurso.'));
    await montar();
    await abrir();
    await userEvent.click(screen.getByRole('button', { name: 'satelliteTickets.bulkModeMultiple' }));
    await preencherDestino();
    await userEvent.click(screen.getByText('somar-jogador'));
    await userEvent.click(screen.getByRole('button', { name: 'satelliteTickets.bulkSubmit' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Você não tem permissão para acessar este recurso.')
    );
    expect(document.querySelector('.modal')).not.toBeNull();
  });
});

describe('transferir e vender ticket', () => {
  const abrir = async (nome = 'Ana') => {
    await userEvent.click(within(linhaDoTicket(nome)).getByText('satelliteTickets.transferAction'));
    await waitFor(() => expect(document.querySelector('.st-transfer-history')).toBeTruthy());
  };

  it('só ticket ainda não resgatado pode trocar de dono', async () => {
    // Resgatado já virou inscrição no dia; trocar o dono deixaria o jogador
    // antigo sentado na mesa sem ticket.
    await montar();
    expect(within(linhaDoTicket('Ana')).getByText('satelliteTickets.transferAction')).toBeInTheDocument();
    expect(within(linhaDoTicket('Beto')).queryByText('satelliteTickets.transferAction')).toBeNull();
  });

  it('o modal traz o histórico de trocas do ticket', async () => {
    await montar();
    await abrir();
    expect(api.get).toHaveBeenCalledWith('/satellite-tickets/tk1/transfers');
    expect(document.querySelector('.st-history-list')).toHaveTextContent('Ana');
    expect(document.querySelector('.st-history-list')).toHaveTextContent('R$ 200.00');
  });

  it('ticket que nunca mudou de mão diz isso', async () => {
    await montar({ trocas: [] });
    await abrir();
    expect(screen.getByText('satelliteTickets.historyEmpty')).toBeInTheDocument();
  });

  it('valor zero é transferência simples, sem forma de pagamento', async () => {
    await montar();
    await abrir();
    expect(screen.queryByText('satelliteTickets.registerInCash')).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText('jogador'), 'p1');
    await userEvent.click(screen.getByRole('button', { name: 'satelliteTickets.transferSubmit' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/satellite-tickets/tk1/transfer', expect.objectContaining({
        to_player_id: 'p1', amount: 0, register_in_cash: false,
      }))
    );
    expect(toast.success).toHaveBeenCalledWith('satelliteTickets.toastTransferred');
  });

  it('com valor, a venda leva forma de pagamento e lançamento no caixa', async () => {
    await montar();
    await abrir();
    await userEvent.selectOptions(screen.getByLabelText('jogador'), 'p1');
    await userEvent.type(screen.getByPlaceholderText('0'), '250');
    await userEvent.selectOptions(seletorComOpcao('pix'), 'pix');
    await userEvent.click(screen.getByRole('button', { name: 'satelliteTickets.transferSubmit' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/satellite-tickets/tk1/transfer', expect.objectContaining({
        to_player_id: 'p1', amount: 250, payment_method: 'pix', register_in_cash: true,
      }))
    );
    expect(toast.success).toHaveBeenCalledWith('satelliteTickets.toastSold');
  });

  it('sem destinatário não dá para confirmar', async () => {
    // Transferir sem destino perderia a vaga.
    await montar();
    await abrir();
    expect(screen.getByRole('button', { name: 'satelliteTickets.transferSubmit' })).toBeDisabled();
  });

  it('erro do servidor mostra o motivo e mantém o modal', async () => {
    api.post.mockRejectedValue(erroHttp('Selecione uma etapa para lançar a venda no caixa'));
    await montar();
    await abrir();
    await userEvent.selectOptions(screen.getByLabelText('jogador'), 'p1');
    await userEvent.type(screen.getByPlaceholderText('0'), '250');
    await userEvent.click(screen.getByRole('button', { name: 'satelliteTickets.transferSubmit' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Selecione uma etapa para lançar a venda no caixa')
    );
    expect(document.querySelector('.st-transfer-history')).not.toBeNull();
  });

  it('falha ao ler o histórico não impede a transferência', async () => {
    // Banco sem a migração: a troca de dono ainda é o que interessa.
    await montar({ trocas: new Error('500') });
    await userEvent.click(within(linhaDoTicket('Ana')).getByText('satelliteTickets.transferAction'));
    expect(await screen.findByText('satelliteTickets.historyEmpty')).toBeInTheDocument();
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
