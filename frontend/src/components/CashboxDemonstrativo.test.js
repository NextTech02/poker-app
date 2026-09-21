/**
 * Demonstrativo de conferência dos caixas.
 *
 * É o relatório que o clube usa para fechar o período, e a coluna que
 * importa é a DIFERENÇA — o que estava previsto contra o que foi contado.
 * Ela é marcada visualmente: zero é uma coisa, qualquer outro valor é outra.
 * Sobra e falta são igualmente sinais de que algo escapou.
 *
 * Duas escolhas de leitura merecem teste:
 *
 * - **Sessão ainda aberta não tem "contado"** — ninguém contou o dinheiro
 *   ainda. Mostrar zero ali seria mentira: pareceria um caixa vazio.
 * - **O período cobre o dia inteiro.** O filtro pega `00:00:00` a
 *   `23:59:59`; cortar à meia-noite deixaria de fora tudo que aconteceu no
 *   último dia — justamente o dia do fechamento.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CashboxDemonstrativo from './CashboxDemonstrativo';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useStage } from '../contexts/StageContext';
import { useCurrency } from '../contexts/CurrencyContext';
import useRealtimeRefresh from '../hooks/useRealtimeRefresh';
import { avisarQueOCaixaMudou } from '../utils/eventosDoCaixa';

jest.mock('../config/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../contexts/StageContext', () => ({ useStage: jest.fn() }));
jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));
jest.mock('../hooks/useRealtimeRefresh', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (chave) => chave }),
}));

const SESSAO_FECHADA = {
  session_id: 'ses1',
  staff_name: 'Ana',
  opened_at: '2026-06-08T10:00:00Z',
  closed_at: '2026-06-08T22:00:00Z',
  is_open: false,
  initial_balance: 200,
  total_supply: 300,
  total_sangria: 100,
  total_buy_ins: 900,
  total_rebuys: 300,
  total_addons: 150,
  total_prizes_paid: 800,
  expected_balance: 950,
  actual_balance: 930,
  difference: -20,
};

const SESSAO_ABERTA = {
  session_id: 'ses2',
  staff_name: 'Beto',
  opened_at: '2026-06-08T11:00:00Z',
  closed_at: null,
  is_open: true,
  initial_balance: 100,
  total_supply: 100,
  total_sangria: 0,
  total_buy_ins: 300,
  total_rebuys: 0,
  total_addons: 0,
  total_prizes_paid: 0,
  expected_balance: 400,
  actual_balance: 400,
  difference: 0,
};

const RELATORIO = {
  sessions: [SESSAO_FECHADA, SESSAO_ABERTA],
  grand_initial: 300,
  grand_supply: 400,
  grand_sangria: 100,
  grand_buy_ins: 1650,
  grand_prizes: 800,
  grand_expected: 1350,
  grand_actual: 1330,
  grand_difference: -20,
};

let toast;

const responder = (relatorio = RELATORIO, caixas = [
  { staff_id: 's1', staff_name: 'Ana' },
  { staff_id: 's2', staff_name: 'Beto' },
]) => {
  api.get.mockImplementation((url) =>
    url === '/cashboxes'
      ? Promise.resolve({ data: caixas })
      : Promise.resolve({ data: relatorio })
  );
};

const montar = async (relatorio, caixas) => {
  responder(relatorio, caixas);
  render(<CashboxDemonstrativo />);
  await waitFor(() =>
    expect(api.get).toHaveBeenCalledWith('/cashboxes/demonstrativo', expect.any(Object))
  );
};

/** O nome do operador aparece na tabela E no filtro; aqui so a tabela conta. */
const naTabela = (texto) =>
  Array.from(document.querySelectorAll('tbody td')).find(
    (c) => c.textContent === texto
  );

/** Valores formatados aparecem em varios lugares (cards, tabela, rodape). */
const temValor = (texto) =>
  Array.from(document.querySelectorAll('td, h3')).some(
    (c) => c.textContent === texto
  );

beforeEach(() => {
  toast = { error: jest.fn() };
  useToast.mockReturnValue({ toast });
  useStage.mockReturnValue({ selectedStage: { id: 'e1', name: 'Etapa Rio' } });
  useCurrency.mockReturnValue({ formatCurrency: (v) => `R$ ${Number(v || 0).toFixed(2)}` });
});

describe('totais', () => {
  it('mostra entradas, prêmios, esperado e diferença', async () => {
    await montar();
    await waitFor(() => expect(temValor('R$ 1650.00')).toBe(true));
    expect(temValor('R$ 800.00')).toBe(true);
    expect(temValor('R$ 1350.00')).toBe(true);
  });

  it('diferença diferente de zero é marcada como problema', async () => {
    // Sobra e falta são igualmente sinais de que algo escapou.
    await montar();
    await waitFor(() => expect(naTabela('Ana')).toBeTruthy());
    expect(document.querySelector('.cb-demo__bad')).toBeInTheDocument();
  });

  it('diferença zero é marcada como certo', async () => {
    await montar({ ...RELATORIO, grand_difference: 0, sessions: [SESSAO_ABERTA] });
    await waitFor(() => expect(naTabela('Beto')).toBeTruthy());
    expect(document.querySelector('.cb-demo__ok')).toBeInTheDocument();
  });

  it('diferença ausente não é marcada de nenhum jeito', async () => {
    await montar({ ...RELATORIO, grand_difference: null, sessions: [] });
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(document.querySelector('.cb-demo__bad')).toBeNull();
    expect(document.querySelector('.cb-demo__ok')).toBeNull();
  });
});

describe('linhas por sessão', () => {
  it('cada ciclo abre→fecha é uma linha', async () => {
    // Somar o período inteiro esconderia um furo compensado por uma sobra.
    await montar();
    await waitFor(() => expect(naTabela('Ana')).toBeTruthy());
    expect(naTabela('Beto')).toBeTruthy();
  });

  it('as entradas somam buy-in, rebuy e add-on', async () => {
    await montar({ ...RELATORIO, sessions: [SESSAO_FECHADA] });
    // 900 + 300 + 150
    await waitFor(() => expect(temValor('R$ 1350.00')).toBe(true));
  });

  it('sessão aberta não mostra valor contado', async () => {
    // Ninguém contou ainda; um zero ali pareceria um caixa vazio.
    await montar({ ...RELATORIO, sessions: [{ ...SESSAO_ABERTA, actual_balance: null, difference: null }] });
    await waitFor(() => expect(naTabela('Beto')).toBeTruthy());
    const celulas = Array.from(document.querySelectorAll('tbody td')).map((c) => c.textContent);
    expect(celulas.filter((c) => c === '—').length).toBeGreaterThanOrEqual(2);
  });

  it('sessão aberta aparece marcada como aberta', async () => {
    await montar({ ...RELATORIO, sessions: [SESSAO_ABERTA] });
    expect(await screen.findByText('cashbox.statusOpen')).toBeInTheDocument();
  });

  it('sessão sem operador mostra travessão', async () => {
    await montar({ ...RELATORIO, sessions: [{ ...SESSAO_FECHADA, staff_name: null }] });
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(document.querySelector('tbody td').textContent).toBe('—');
  });

  it('sessão fechada sem horário de fechamento não quebra', async () => {
    // Dado antigo, anterior à conferência.
    await montar({
      ...RELATORIO,
      sessions: [{ ...SESSAO_FECHADA, is_open: false, closed_at: null }],
    });
    await waitFor(() => expect(naTabela('Ana')).toBeTruthy());
  });

  it('mostra a linha de totais no rodapé', async () => {
    await montar();
    await waitFor(() => expect(naTabela('Ana')).toBeTruthy());
    expect(document.querySelector('.cb-demo__totals-row')).toBeInTheDocument();
  });

  it('sem sessão no período mostra o estado vazio', async () => {
    await montar({ ...RELATORIO, sessions: [] });
    expect(await screen.findByText('cashbox.noSessions')).toBeInTheDocument();
  });
});

describe('filtros', () => {
  it('o período cobre o dia inteiro nas duas pontas', async () => {
    // Cortar à meia-noite deixaria de fora tudo do último dia — justamente o
    // do fechamento.
    await montar();
    const params = api.get.mock.calls.find(
      (c) => c[0] === '/cashboxes/demonstrativo'
    )[1].params;
    expect(params.date_from).toMatch(/T00:00:00$/);
    expect(params.date_to).toMatch(/T23:59:59$/);
  });

  it('filtra por funcionário', async () => {
    await montar();
    await waitFor(() => expect(naTabela('Ana')).toBeTruthy());
    await userEvent.selectOptions(screen.getByRole('combobox'), 's2');
    await userEvent.click(screen.getByRole('button', { name: 'cashbox.generate' }));
    await waitFor(() => {
      const ultima = api.get.mock.calls[api.get.mock.calls.length - 1];
      expect(ultima[1].params.staff_id).toBe('s2');
    });
  });

  it('a lista de funcionários vem dos caixas da etapa, sem repetir', async () => {
    // O mesmo operador pode ter várias sessões; repeti-lo no filtro seria
    // ruído.
    await montar(RELATORIO, [
      { staff_id: 's1', staff_name: 'Ana' },
      { staff_id: 's1', staff_name: 'Ana' },
      { staff_id: 's2', staff_name: 'Beto' },
    ]);
    await waitFor(() => expect(naTabela('Ana')).toBeTruthy());
    const opcoes = screen.getAllByRole('option').map((o) => o.textContent);
    expect(opcoes.filter((o) => o === 'Ana')).toHaveLength(1);
  });

  it('operador sem nome cai no e-mail', async () => {
    await montar(RELATORIO, [
      { staff_id: 's1', staff_name: null, staff_email: 'ana@clube.com' },
    ]);
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toContain(
      'ana@clube.com'
    );
  });

  it('falha ao carregar os funcionários deixa só a opção "todos"', async () => {
    api.get.mockImplementation((url) =>
      url === '/cashboxes'
        ? Promise.reject(new Error('403'))
        : Promise.resolve({ data: RELATORIO })
    );
    render(<CashboxDemonstrativo />);
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });

  it('trocar de etapa recarrega o relatório', async () => {
    // O demonstrativo é por etapa; manter o anterior mostraria outro evento.
    responder();
    const { rerender } = render(<CashboxDemonstrativo />);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    useStage.mockReturnValue({ selectedStage: { id: 'e2', name: 'Etapa 2' } });
    rerender(<CashboxDemonstrativo />);
    await waitFor(() => expect(api.get.mock.calls.length).toBeGreaterThan(2));
  });
});

describe('falhas', () => {
  it('erro ao gerar avisa e limpa a tela', async () => {
    // Deixar os números da consulta anterior faria o clube fechar o caixa com
    // o relatório errado.
    api.get.mockImplementation((url) =>
      url === '/cashboxes'
        ? Promise.resolve({ data: [] })
        : Promise.reject(Object.assign(new Error('403'), { userMessage: 'sem permissão' }))
    );
    render(<CashboxDemonstrativo />);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('sem permissão'));
    expect(await screen.findByText('cashbox.noSessions')).toBeInTheDocument();
  });
});

/**
 * Ancorado num turno do bar, o demonstrativo é a MESMA infraestrutura de
 * gaveta — mas a tela só pode falar de bar. "Entradas (jogo)" e "prêmios" ali
 * fazem o conferente achar que o sistema misturou os módulos.
 */
describe('ancorado no turno do bar', () => {
  // A gaveta do turno só recebe vendas, estornos, suprimento e retirada. Se um
  // buy-in caísse aqui por engano, a tela do bar NÃO pode somá-lo.
  const SESSAO_BAR = {
    ...SESSAO_FECHADA,
    total_buy_ins: 900,
    total_rebuys: 0,
    total_addons: 0,
    total_prizes_paid: 800,
    total_bar_sales: 640,
    total_refunds: 40,
  };
  const RELATORIO_BAR = {
    ...RELATORIO,
    sessions: [SESSAO_BAR],
    grand_buy_ins: 900,
    grand_prizes: 800,
    grand_bar_sales: 640,
    grand_refunds: 40,
  };
  const ANCORA = { barShiftId: 't-2' };

  const montarNoTurno = async (relatorio = RELATORIO_BAR) => {
    responder(relatorio);
    const resultado = render(<CashboxDemonstrativo anchor={ANCORA} />);
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/cashboxes/demonstrativo', expect.any(Object))
    );
    return resultado;
  };

  it('fala de vendas e estornos, não de jogo e prêmios', async () => {
    await montarNoTurno();
    expect(await screen.findByText('cashbox.barSalesTotal')).toBeInTheDocument();
    expect(screen.getByText('cashbox.barRefundsTotal')).toBeInTheDocument();
    expect(screen.getAllByText('cashbox.barSales').length).toBeGreaterThan(0);
    expect(screen.getAllByText('cashbox.barRefunds').length).toBeGreaterThan(0);
    expect(screen.queryByText('cashbox.totalEntries')).toBeNull();
    expect(screen.queryByText('cashbox.totalOutflows')).toBeNull();
    expect(screen.queryByText('cashbox.entries')).toBeNull();
    expect(screen.queryByText('cashbox.outflows')).toBeNull();
  });

  it('entradas são só as vendas do bar; saídas, só os estornos', async () => {
    await montarNoTurno();
    await waitFor(() => expect(temValor('R$ 640.00')).toBe(true));
    expect(temValor('R$ 40.00')).toBe(true);
    expect(temValor('R$ 1540.00')).toBe(false); // 640 + 900 de buy-in
    expect(temValor('R$ 840.00')).toBe(false); // 40 + 800 de prêmio
  });

  it('pede o turno inteiro: sem período nem funcionário', async () => {
    // "Início do mês até hoje" por cima do turno escondia o turno da virada do
    // mês — e todo turno antigo.
    await montarNoTurno();
    const params = api.get.mock.calls.find((c) => c[0] === '/cashboxes/demonstrativo')[1].params;
    expect(params).toEqual({ bar_shift_id: 't-2' });
  });

  it('não mostra filtros nem botão de gerar, e não busca a lista de funcionários', async () => {
    await montarNoTurno();
    await waitFor(() => expect(naTabela('Ana')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'cashbox.generate' })).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(api.get).not.toHaveBeenCalledWith('/cashboxes', expect.anything());
  });

  it('recarrega, sem piscar, quando o painel de caixas avisa que a gaveta mudou', async () => {
    // Não há botão "Gerar" aqui: o painel logo acima abre/fecha/supre e avisa.
    await montarNoTurno();
    await waitFor(() => expect(naTabela('Ana')).toBeTruthy());
    const antes = api.get.mock.calls.length;
    act(() => { avisarQueOCaixaMudou(); });
    await waitFor(() => expect(api.get.mock.calls.length).toBeGreaterThan(antes));
    // Recarga silenciosa: a linha continua na tela, sem esqueleto no lugar.
    expect(naTabela('Ana')).toBeTruthy();
  });

  it('deixa de escutar depois de sair da tela', async () => {
    const { unmount } = await montarNoTurno();
    await waitFor(() => expect(naTabela('Ana')).toBeTruthy());
    unmount();
    const antes = api.get.mock.calls.length;
    act(() => { avisarQueOCaixaMudou(); });
    expect(api.get.mock.calls.length).toBe(antes);
  });

  it('trocar a etapa do header NÃO recarrega: o turno não tem etapa', async () => {
    responder(RELATORIO_BAR);
    const { rerender } = render(<CashboxDemonstrativo anchor={ANCORA} />);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    useStage.mockReturnValue({ selectedStage: { id: 'e2', name: 'Etapa 2' } });
    rerender(<CashboxDemonstrativo anchor={ANCORA} />);
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('sem sessão fala do turno, não do período', async () => {
    await montarNoTurno({ ...RELATORIO_BAR, sessions: [] });
    expect(await screen.findByText('cashbox.noSessionsShift')).toBeInTheDocument();
    expect(screen.queryByText('cashbox.noSessions')).toBeNull();
  });

  it('acompanha as gavetas do turno em tempo real; sem âncora, não', async () => {
    // O aviso local só cobre este navegador; o barman fecha a gaveta no tablet.
    await montarNoTurno();
    expect(useRealtimeRefresh).toHaveBeenCalledWith(expect.objectContaining({
      ativo: true,
      tabelas: [{ table: 'cashboxes', filter: 'bar_shift_id=eq.t-2' }],
    }));
    useRealtimeRefresh.mockClear();
    responder();
    render(<CashboxDemonstrativo />);
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(useRealtimeRefresh).toHaveBeenCalledWith(expect.objectContaining({ ativo: false }));
  });
});

describe('ancorado no dia de cash', () => {
  it('entradas são as compras de fichas; saídas, cash-outs e estornos', async () => {
    responder({
      ...RELATORIO,
      sessions: [{
        ...SESSAO_FECHADA,
        total_buy_ins: 900,
        total_cash_buy_ins: 500,
        total_cash_outs: 120,
        total_refunds: 30,
      }],
      grand_buy_ins: 900,
      grand_cash_buy_ins: 500,
      grand_cash_outs: 120,
      grand_refunds: 30,
    });
    render(<CashboxDemonstrativo anchor={{ cashDayId: 'd-1' }} />);
    await waitFor(() => expect(temValor('R$ 500.00')).toBe(true));
    expect(temValor('R$ 150.00')).toBe(true);
    expect(temValor('R$ 1400.00')).toBe(false); // 500 + 900 de buy-in de torneio
    expect(screen.getAllByText('cash.turnover').length).toBeGreaterThan(0);
  });
});
