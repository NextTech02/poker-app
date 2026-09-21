/**
 * Painel do administrador sobre os caixas dos operadores.
 *
 * Aqui há duas sangrias diferentes com nomes parecidos, e confundi-las
 * moveria dinheiro do lugar errado:
 *
 * - **Sangria do caixa** tira do caixa modular do operador (o dinheiro sai
 *   da gaveta dele).
 * - **Sangria para o Caixa Geral** move o caixa da ETAPA para o geral,
 *   descontando rake, e NÃO toca no saldo do operador.
 *
 * A segunda calcula o rake automaticamente, proporcional ao rake pendente da
 * etapa — a mesma conta do servidor. Tirar o rake inteiro na primeira
 * sangria deixaria as seguintes sem rake nenhum.
 *
 * O painel também só oferece criar caixa para quem ainda não tem um na
 * etapa: dois caixas do mesmo operador dividiriam o dinheiro dele entre
 * duas linhas.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CashboxAdminPanel from './CashboxAdminPanel';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useStage } from '../contexts/StageContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { CAIXA_MUDOU } from '../utils/eventosDoCaixa';
import useRealtimeRefresh from '../hooks/useRealtimeRefresh';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() },
}));
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../contexts/StageContext', () => ({ useStage: jest.fn() }));
jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));
jest.mock('../hooks/useRealtimeRefresh', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (chave, arg) => {
      if (arg && typeof arg === 'object') {
        return `${chave} ${Object.values(arg).join(' ')}`;
      }
      return typeof arg === 'string' ? arg : chave;
    },
  }),
}));

const CAIXA_ABERTO = {
  id: 'cb1',
  staff_id: 's1',
  staff_name: 'Ana',
  staff_email: 'ana@clube.com',
  status: 'open',
  current_balance: 800,
};
const CAIXA_FECHADO = {
  id: 'cb2',
  staff_id: 's2',
  staff_name: 'Beto',
  status: 'closed',
  current_balance: 0,
};

const FUNCIONARIOS = [
  { id: 's1', name: 'Ana', active: true },
  { id: 's2', name: 'Beto', active: true },
  { id: 's3', name: 'Carla', active: true },
  { id: 's4', name: 'Antigo', active: false },
];

let toast;

const responder = ({ caixas = [CAIXA_ABERTO, CAIXA_FECHADO], staff = FUNCIONARIOS,
                    etapaCaixa = { current_balance: 2000 }, rake = 400 } = {}) => {
  api.get.mockImplementation((url) => {
    if (url === '/cashboxes') return Promise.resolve({ data: caixas });
    if (url === '/staff') return Promise.resolve({ data: staff });
    if (url.endsWith('/pending-rake')) return Promise.resolve({ data: { pending_rake: rake } });
    if (url.startsWith('/cash/stage/')) return Promise.resolve({ data: etapaCaixa });
    return Promise.resolve({ data: [] });
  });
};

const montar = async (opcoes) => {
  responder(opcoes);
  render(<CashboxAdminPanel />);
  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/cashboxes', expect.any(Object)));
};

beforeEach(() => {
  toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn() };
  useToast.mockReturnValue({ toast });
  useStage.mockReturnValue({ selectedStage: { id: 'e1', name: 'Etapa Rio' } });
  useCurrency.mockReturnValue({ formatCurrency: (v) => `R$ ${Number(v || 0).toFixed(2)}` });
  api.post.mockResolvedValue({ data: {} });
});

describe('listagem', () => {
  it('mostra cada caixa com operador e saldo', async () => {
    await montar();
    expect(await screen.findByText('Ana')).toBeInTheDocument();
    expect(screen.getByText('ana@clube.com')).toBeInTheDocument();
    // o mesmo valor aparece no total de caixas abertos; a celula da linha e
    // a que interessa aqui
    expect(document.querySelector('td.amount')).toHaveTextContent('R$ 800.00');
  });

  it('soma só os caixas ABERTOS no total', async () => {
    // O saldo de um caixa fechado já foi conferido e recolhido; somá-lo
    // faria o admin achar que há mais dinheiro no salão do que existe.
    await montar({
      caixas: [
        CAIXA_ABERTO,
        { ...CAIXA_FECHADO, current_balance: 5000 },
        { ...CAIXA_ABERTO, id: 'cb3', staff_id: 's3', current_balance: 200 },
      ],
    });
    expect(await screen.findByText('R$ 1000.00')).toBeInTheDocument();
  });

  it('caixa sem operador mostra travessão', async () => {
    await montar({ caixas: [{ ...CAIXA_ABERTO, staff_name: null }] });
    expect(await screen.findByText('—')).toBeInTheDocument();
  });

  it('sem caixa nenhum mostra o estado vazio', async () => {
    await montar({ caixas: [] });
    expect(await screen.findByText('cashbox.noCashboxes')).toBeInTheDocument();
  });

  it('falha ao carregar não quebra a tela', async () => {
    api.get.mockRejectedValue(new Error('sem rede'));
    render(<CashboxAdminPanel />);
    expect(await screen.findByText('cashbox.noCashboxes')).toBeInTheDocument();
  });

  it('mostra a etapa em que se está trabalhando', async () => {
    await montar();
    expect(await screen.findByText(/Etapa Rio/)).toBeInTheDocument();
  });

  it('sem etapa avisa que a visão é de todas', async () => {
    useStage.mockReturnValue({ selectedStage: null });
    await montar();
    expect(await screen.findByText('cashbox.allStagesContext')).toBeInTheDocument();
  });
});

describe('ações disponíveis por estado', () => {
  it('caixa aberto oferece suprimento, sangria e fechamento', async () => {
    await montar({ caixas: [CAIXA_ABERTO] });
    expect(await screen.findByRole('button', { name: 'cashbox.supply' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'cashbox.sangria' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'cashbox.sangriaToGeneral' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'cashbox.closeCashbox' })).toBeInTheDocument();
  });

  it('caixa fechado só oferece abrir', async () => {
    await montar({ caixas: [CAIXA_FECHADO] });
    expect(await screen.findByRole('button', { name: 'cashbox.openCashbox' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'cashbox.supply' })).toBeNull();
  });

  it('caixa arquivado não oferece nada', async () => {
    // Etapa encerrada: qualquer movimento reescreveria um evento conferido.
    await montar({ caixas: [{ ...CAIXA_ABERTO, status: 'archived' }] });
    await screen.findByText('Ana');
    expect(screen.queryByRole('button', { name: 'cashbox.openCashbox' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'cashbox.supply' })).toBeNull();
  });
});

describe('criar caixa', () => {
  const abrirCriacao = async () => {
    await montar();
    await screen.findByText('Ana');
    await userEvent.click(screen.getByRole('button', { name: /cashbox.newCashbox/ }));
  };

  it('só oferece quem ainda não tem caixa na etapa', async () => {
    // Dois caixas do mesmo operador dividiriam o dinheiro dele entre duas
    // linhas, e nenhuma bateria no fechamento.
    await abrirCriacao();
    const opcoes = screen.getAllByRole('option').map((o) => o.textContent);
    expect(opcoes).toContain('Carla');
    expect(opcoes).not.toContain('Ana');
    expect(opcoes).not.toContain('Beto');
  });

  it('funcionário desativado não entra na lista', async () => {
    await abrirCriacao();
    expect(screen.getAllByRole('option').map((o) => o.textContent)).not.toContain('Antigo');
  });

  it('cria o caixa do funcionário escolhido', async () => {
    await abrirCriacao();
    await userEvent.selectOptions(screen.getByRole('combobox'), 's3');
    await userEvent.click(screen.getByRole('button', { name: 'cashbox.create' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/cashboxes', { staff_id: 's3' })
    );
    expect(toast.success).toHaveBeenCalled();
  });

  it('erro do servidor aparece', async () => {
    api.post.mockRejectedValue({ userMessage: 'já possui caixa nesta etapa' });
    await abrirCriacao();
    await userEvent.selectOptions(screen.getByRole('combobox'), 's3');
    await userEvent.click(screen.getByRole('button', { name: 'cashbox.create' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('já possui caixa nesta etapa')
    );
  });

  it('falha ao carregar funcionários deixa a lista vazia sem quebrar', async () => {
    api.get.mockImplementation((url) =>
      url === '/staff'
        ? Promise.reject(new Error('403'))
        : Promise.resolve({ data: [CAIXA_ABERTO] })
    );
    render(<CashboxAdminPanel />);
    await screen.findByText('Ana');
    await userEvent.click(screen.getByRole('button', { name: /cashbox.newCashbox/ }));
    // Sem lista, o formulário explica o motivo em vez de mostrar um seletor
    // vazio — e o botão de criar fica travado.
    expect(screen.getByText('cashbox.allStaffHaveCashbox')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'cashbox.create' })).toBeDisabled();
  });
});

describe('movimentos no caixa do operador', () => {
  const abrirAcao = async (nome) => {
    await montar({ caixas: [CAIXA_ABERTO] });
    await screen.findByText('Ana');
    await userEvent.click(screen.getByRole('button', { name: nome }));
  };

  const confirmar = () =>
    userEvent.click(document.querySelector('.modal-actions button[type="submit"]'));

  it('suprimento avisa que o caixa mudou', async () => {
    // Se o operador estiver com a tela de vendas aberta no mesmo navegador, o
    // saldo dele muda agora — e o banner precisa ser avisado.
    const avisos = jest.fn();
    window.addEventListener(CAIXA_MUDOU, avisos);
    try {
      await abrirAcao('cashbox.supply');
      await userEvent.type(screen.getByLabelText('cashbox.supplyAmount'), '300');
      await confirmar();
      await waitFor(() => expect(avisos).toHaveBeenCalled());
    } finally {
      window.removeEventListener(CAIXA_MUDOU, avisos);
    }
  });

  it('suprimento envia o valor', async () => {
    await abrirAcao('cashbox.supply');
    await userEvent.type(screen.getByLabelText('cashbox.supplyAmount'), '300');
    await confirmar();
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/cashboxes/cb1/supply', {
        amount: 300,
        notes: null,
      })
    );
  });

  it('sangria do caixa usa o endpoint do CAIXA, não o da etapa', async () => {
    // Confundir os dois tiraria dinheiro do lugar errado.
    await abrirAcao('cashbox.sangria');
    await userEvent.type(screen.getByLabelText('cashbox.sangriaAmount'), '200');
    await confirmar();
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/cashboxes/cb1/sangria', {
        amount: 200,
        notes: null,
      })
    );
  });

  it('fechar já vem com o saldo do sistema preenchido', async () => {
    await abrirAcao('cashbox.closeCashbox');
    expect(screen.getByLabelText('cashbox.countedBalance')).toHaveValue(800);
  });

  it('fechamento com falta vira aviso, não sucesso', async () => {
    api.post.mockResolvedValue({ data: { difference: -50 } });
    await abrirAcao('cashbox.closeCashbox');
    await confirmar();
    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('fechamento com sobra também vira aviso', async () => {
    api.post.mockResolvedValue({ data: { difference: 30 } });
    await abrirAcao('cashbox.closeCashbox');
    await confirmar();
    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
  });

  it('fechamento que bate vira sucesso', async () => {
    api.post.mockResolvedValue({ data: { difference: 0 } });
    await abrirAcao('cashbox.closeCashbox');
    await confirmar();
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it('abrir manda o saldo inicial', async () => {
    await montar({ caixas: [CAIXA_FECHADO] });
    await screen.findByText('Beto');
    await userEvent.click(screen.getByRole('button', { name: 'cashbox.openCashbox' }));
    const campo = screen.getByLabelText('cashbox.initialBalance');
    await userEvent.clear(campo);
    await userEvent.type(campo, '150');
    await confirmar();
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/cashboxes/cb2/open', {
        initial_balance: 150,
        notes: null,
      })
    );
  });

  it('erro do servidor aparece e o formulário fica', async () => {
    api.post.mockRejectedValue({ userMessage: 'Caixa fechado' });
    await abrirAcao('cashbox.supply');
    await userEvent.type(screen.getByLabelText('cashbox.supplyAmount'), '10');
    await confirmar();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Caixa fechado'));
  });
});

describe('sangria da etapa para o caixa geral', () => {
  const abrirSangriaDaEtapa = async (opcoes) => {
    await montar({ caixas: [CAIXA_ABERTO], ...opcoes });
    await screen.findByText('Ana');
    await userEvent.click(screen.getByRole('button', { name: 'cashbox.sangriaToGeneral' }));
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/cash/stage/e1', expect.any(Object))
    );
  };

  const confirmar = () =>
    userEvent.click(document.querySelector('.modal-actions button[type="submit"]'));

  it('move o caixa da ETAPA, não o do operador', async () => {
    await abrirSangriaDaEtapa();
    await userEvent.type(screen.getByLabelText('generalCash.sangriaAmountLabel'), '500');
    await confirmar();
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        '/cash/sangria',
        expect.objectContaining({ stage_id: 'e1', amount: 500 })
      )
    );
  });

  it('o rake sai proporcional ao pendente da etapa', async () => {
    // 400 de rake pendente sobre 2000 de caixa: tirando 500 (um quarto),
    // sai um quarto do rake. Tirar o rake inteiro na primeira sangria
    // deixaria as seguintes sem rake nenhum.
    await abrirSangriaDaEtapa();
    await userEvent.type(screen.getByLabelText('generalCash.sangriaAmountLabel'), '500');
    await confirmar();
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        '/cash/sangria',
        expect.objectContaining({ rake_percentage: 20 })
      )
    );
  });

  it('identifica de qual caixa partiu a sangria', async () => {
    // Sem a etiqueta, o histórico do caixa geral não diz quem trouxe o
    // dinheiro.
    await abrirSangriaDaEtapa();
    await userEvent.type(screen.getByLabelText('generalCash.sangriaAmountLabel'), '100');
    await confirmar();
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        '/cash/sangria',
        expect.objectContaining({ notes: expect.stringContaining('Ana') })
      )
    );
  });

  it('valor zero é recusado antes de sair da tela', async () => {
    await abrirSangriaDaEtapa();
    await confirmar();
    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    expect(api.post).not.toHaveBeenCalled();
  });

  it('valor acima do caixa da etapa é recusado com o saldo disponível', async () => {
    // Deixaria o caixa da etapa negativo — sinal de digitação errada.
    await abrirSangriaDaEtapa();
    await userEvent.type(screen.getByLabelText('generalCash.sangriaAmountLabel'), '9999');
    await confirmar();
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('2000.00'))
    );
    expect(api.post).not.toHaveBeenCalled();
  });

  it('sem conseguir ler o caixa da etapa, o rake fica zero em vez de errado', async () => {
    // Melhor sangrar sem rake e acertar depois do que aplicar um percentual
    // inventado.
    api.get.mockImplementation((url) => {
      if (url === '/cashboxes') return Promise.resolve({ data: [CAIXA_ABERTO] });
      if (url === '/staff') return Promise.resolve({ data: FUNCIONARIOS });
      return Promise.reject(new Error('sem rede'));
    });
    render(<CashboxAdminPanel />);
    await screen.findByText('Ana');
    await userEvent.click(screen.getByRole('button', { name: 'cashbox.sangriaToGeneral' }));
    await userEvent.type(screen.getByLabelText('generalCash.sangriaAmountLabel'), '100');
    await confirmar();
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        '/cash/sangria',
        expect.objectContaining({ rake_percentage: 0 })
      )
    );
  });
});

/**
 * Ancorado num turno do bar, o painel lista as gavetas do TURNO — e só pode
 * falar de turno. "Nenhum caixa nesta etapa" ali faz o admin achar que o
 * sistema misturou os módulos (o bar não tem etapa).
 */
describe('ancorado no turno do bar', () => {
  const ANCORA = { barShiftId: 't-2' };

  const montarNoTurno = async (opcoes) => {
    responder(opcoes);
    const resultado = render(<CashboxAdminPanel anchor={ANCORA} />);
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith(
        '/cashboxes',
        expect.objectContaining({ params: { bar_shift_id: 't-2' } })
      )
    );
    return resultado;
  };

  it('sem caixa nenhum fala do TURNO, não da etapa', async () => {
    await montarNoTurno({ caixas: [] });
    expect(await screen.findByText('cashbox.noCashboxesShift')).toBeInTheDocument();
    expect(screen.queryByText('cashbox.noCashboxes')).toBeNull();
  });

  it('trocar a etapa do header não recarrega: a âncora vence', async () => {
    const { rerender } = await montarNoTurno();
    await screen.findByText('Ana');
    const antes = api.get.mock.calls.length;
    useStage.mockReturnValue({ selectedStage: { id: 'e2', name: 'Etapa 2' } });
    rerender(<CashboxAdminPanel anchor={ANCORA} />);
    expect(api.get.mock.calls.length).toBe(antes);
  });

  it('não oferece a sangria da ETAPA', async () => {
    await montarNoTurno({ caixas: [CAIXA_ABERTO] });
    await screen.findByText('Ana');
    expect(screen.queryByRole('button', { name: 'cashbox.sangriaToGeneral' })).toBeNull();
    expect(screen.getByRole('button', { name: 'cashbox.sangria' })).toBeInTheDocument();
  });

  it('cria o caixa novo já ancorado no turno', async () => {
    await montarNoTurno();
    await screen.findByText('Ana');
    await userEvent.click(screen.getByRole('button', { name: /cashbox.newCashbox/ }));
    await userEvent.selectOptions(screen.getByRole('combobox'), 's3');
    await userEvent.click(screen.getByRole('button', { name: 'cashbox.create' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/cashboxes', { staff_id: 's3', bar_shift_id: 't-2' })
    );
  });

  it('todos com caixa: a mensagem fala do turno', async () => {
    // Só Ana e Beto ativos, e os dois já têm gaveta neste turno.
    await montarNoTurno({ staff: FUNCIONARIOS.slice(0, 2) });
    await screen.findByText('Ana');
    await userEvent.click(screen.getByRole('button', { name: /cashbox.newCashbox/ }));
    expect(screen.getByText('cashbox.allStaffHaveCashboxShift')).toBeInTheDocument();
    expect(screen.queryByText('cashbox.allStaffHaveCashbox')).toBeNull();
  });

  it('acompanha as gavetas do turno em tempo real, sem piscar; sem âncora, não', async () => {
    // O barman abre e fecha a gaveta dele no tablet: o status aqui precisa
    // acompanhar. A recarga vem do realtime, então não pode trocar a tabela
    // por esqueleto a cada venda.
    await montarNoTurno();
    await screen.findByText('Ana');
    const chamada = useRealtimeRefresh.mock.calls.find(
      ([opts]) => opts.ativo && opts.tabelas[0].filter === 'bar_shift_id=eq.t-2'
    );
    expect(chamada).toBeTruthy();
    const antes = api.get.mock.calls.length;
    await act(async () => { await chamada[0].aoMudar(); });
    expect(api.get.mock.calls.length).toBeGreaterThan(antes);
    expect(screen.getByText('Ana')).toBeInTheDocument();

    useRealtimeRefresh.mockClear();
    render(<CashboxAdminPanel />);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/cashboxes', expect.any(Object)));
    expect(useRealtimeRefresh).toHaveBeenCalledWith(expect.objectContaining({ ativo: false }));
  });
});
