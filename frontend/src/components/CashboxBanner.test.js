/**
 * Banner do caixa do operador.
 *
 * É a peça que decide se o operador PODE registrar dinheiro. Três estados
 * são deliberadamente diferentes e não podem se confundir:
 *
 * - **Caixa fechado** → mostra o aviso de bloqueio. O operador precisa
 *   abrir antes de cobrar qualquer coisa, senão o dinheiro entra sem dono e
 *   não bate com ninguém no fechamento.
 * - **Sem vínculo de funcionário** (super-admin) → não renderiza nada e
 *   reporta `null`, para a tela NÃO bloquear. Bloquear o admin travaria o
 *   suporte.
 * - **Sem etapa selecionada** → o caixa é por etapa; a pergunta não tem
 *   resposta ainda.
 *
 * No fechamento, sobra e falta viram avisos distintos: um caixa que fecha
 * "certo" e um que fecha com 200 a menos não podem produzir a mesma
 * mensagem verde.
 */
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CashboxBanner from './CashboxBanner';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useStage } from '../contexts/StageContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { avisarQueOCaixaMudou } from '../utils/eventosDoCaixa';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() },
}));
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../contexts/StageContext', () => ({ useStage: jest.fn() }));
jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (chave, arg) => {
      const vars = typeof arg === 'object' ? arg : null;
      let texto = typeof arg === 'string' ? arg : chave;
      if (vars) Object.entries(vars).forEach(([k, v]) => { texto += ` ${v}`; });
      return texto;
    },
  }),
}));

const CAIXA = {
  id: 'cb1',
  status: 'closed',
  current_balance: 500,
  staff_name: 'Ana',
};

let toast;
let aoMudar;
let renderResultado;

const montar = async (dados = CAIXA) => {
  api.get.mockResolvedValue({ data: dados });
  aoMudar = jest.fn();
  renderResultado = render(<CashboxBanner onStateChange={aoMudar} />);
  // Esperar so a chamada nao basta: o componente nao renderiza nada enquanto
  // o estado ainda e `undefined` (carregando).
  await waitFor(() => expect(aoMudar).toHaveBeenCalled());
};

beforeEach(() => {
  toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn() };
  useToast.mockReturnValue({ toast });
  useStage.mockReturnValue({ selectedStage: { id: 'e1' } });
  useCurrency.mockReturnValue({ formatCurrency: (v) => `R$ ${Number(v).toFixed(2)}` });
  api.post.mockResolvedValue({ data: { difference: 0 } });
});

describe('estados', () => {
  it('sem vínculo de funcionário não aparece e não bloqueia', async () => {
    // Bloquear o super-admin travaria o suporte.
    await montar(null);
    expect(screen.queryByText(/cashbox.myCashbox/)).toBeNull();
    await waitFor(() => expect(aoMudar).toHaveBeenCalledWith(null));
  });

  it('sem etapa selecionada mostra a dica em vez do caixa', async () => {
    api.get.mockRejectedValue({ response: { status: 400 } });
    render(<CashboxBanner onStateChange={jest.fn()} />);
    expect(await screen.findByText('cashbox.selectStageHint')).toBeInTheDocument();
  });

  it('falha inesperada não bloqueia a tela', async () => {
    // Uma leitura que falhou não pode impedir o clube de operar.
    api.get.mockRejectedValue(new Error('sem rede'));
    aoMudar = jest.fn();
    render(<CashboxBanner onStateChange={aoMudar} />);
    await waitFor(() => expect(aoMudar).toHaveBeenCalledWith(null));
  });

  it('caixa fechado mostra o aviso de bloqueio e o botão de abrir', async () => {
    // Registrar dinheiro com o caixa fechado deixaria o valor sem dono.
    await montar();
    expect(screen.getByText('cashbox.blockedHint')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'cashbox.openCashbox' })).toBeInTheDocument();
  });

  it('caixa aberto mostra o botão de fechar e nenhum bloqueio', async () => {
    await montar({ ...CAIXA, status: 'open' });
    expect(screen.getByRole('button', { name: 'cashbox.closeCashbox' })).toBeInTheDocument();
    expect(screen.queryByText('cashbox.blockedHint')).toBeNull();
  });

  it('caixa arquivado não oferece abrir nem fechar', async () => {
    // Etapa encerrada: reabrir criaria movimento num evento já conferido.
    await montar({ ...CAIXA, status: 'archived' });
    expect(screen.queryByRole('button', { name: 'cashbox.openCashbox' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'cashbox.closeCashbox' })).toBeNull();
    expect(screen.queryByText('cashbox.blockedHint')).toBeNull();
  });

  it('mostra saldo e nome do operador', async () => {
    await montar({ ...CAIXA, status: 'open', current_balance: 1250.5 });
    expect(screen.getByText('R$ 1250.50')).toBeInTheDocument();
    expect(screen.getByText(/Ana/)).toBeInTheDocument();
  });

  it('caixa sem nome de operador não mostra separador solto', async () => {
    await montar({ ...CAIXA, staff_name: null });
    expect(screen.getByText('cashbox.myCashbox')).toBeInTheDocument();
  });

  it('avisa o pai sobre o caixa atual', async () => {
    // É o que a tela do Caixa usa para liberar ou bloquear o registro.
    await montar({ ...CAIXA, status: 'open' });
    await waitFor(() =>
      expect(aoMudar).toHaveBeenCalledWith(expect.objectContaining({ status: 'open' }))
    );
  });

  it('trocar de etapa recarrega o caixa', async () => {
    // O caixa é POR ETAPA: manter o anterior mostraria o saldo do evento errado.
    api.get.mockResolvedValue({ data: CAIXA });
    const { rerender } = render(<CashboxBanner onStateChange={jest.fn()} />);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    useStage.mockReturnValue({ selectedStage: { id: 'e2' } });
    rerender(<CashboxBanner onStateChange={jest.fn()} />);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  });
});

describe('abertura', () => {
  const abrir = async () => {
    await montar();
    await userEvent.click(screen.getByRole('button', { name: 'cashbox.openCashbox' }));
  };

  it('abre com o saldo informado', async () => {
    await abrir();
    const campo = screen.getByLabelText('cashbox.initialBalance');
    await userEvent.clear(campo);
    await userEvent.type(campo, '200');
    await userEvent.click(
      screen.getAllByRole('button', { name: 'cashbox.openCashbox' })[1]
    );
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/cashboxes/cb1/open', {
        initial_balance: 200,
        notes: null,
      })
    );
  });

  it('saldo em branco vira zero em vez de NaN', async () => {
    // NaN gravado como saldo inicial contaminaria toda a conferência.
    await abrir();
    await userEvent.clear(screen.getByLabelText('cashbox.initialBalance'));
    await userEvent.click(
      screen.getAllByRole('button', { name: 'cashbox.openCashbox' })[1]
    );
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        '/cashboxes/cb1/open',
        expect.objectContaining({ initial_balance: 0 })
      )
    );
  });

  it('a observação é enviada quando preenchida', async () => {
    await abrir();
    await userEvent.type(screen.getByLabelText('cashbox.notes'), 'troco do cofre');
    await userEvent.click(
      screen.getAllByRole('button', { name: 'cashbox.openCashbox' })[1]
    );
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        '/cashboxes/cb1/open',
        expect.objectContaining({ notes: 'troco do cofre' })
      )
    );
  });

  it('recarrega o estado depois de abrir', async () => {
    await abrir();
    api.get.mockClear();
    await userEvent.click(
      screen.getAllByRole('button', { name: 'cashbox.openCashbox' })[1]
    );
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalled();
  });

  it('erro do servidor aparece e o formulário continua aberto', async () => {
    // "Caixa já está aberto" precisa chegar ao operador.
    api.post.mockRejectedValue({ userMessage: 'Caixa já está aberto' });
    await abrir();
    await userEvent.click(
      screen.getAllByRole('button', { name: 'cashbox.openCashbox' })[1]
    );
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Caixa já está aberto'));
    expect(screen.getByLabelText('cashbox.initialBalance')).toBeInTheDocument();
  });

  it('cancelar fecha sem gravar', async () => {
    await abrir();
    await userEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(api.post).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('cashbox.initialBalance')).toBeNull();
  });

  it('clicar fora fecha', async () => {
    await abrir();
    await userEvent.click(document.querySelector('.modal-overlay'));
    expect(screen.queryByLabelText('cashbox.initialBalance')).toBeNull();
  });

  it('clicar dentro não fecha', async () => {
    await abrir();
    await userEvent.click(document.querySelector('.modal'));
    expect(screen.getByLabelText('cashbox.initialBalance')).toBeInTheDocument();
  });
});

describe('fechamento', () => {
  const fechar = async (diferenca = 0) => {
    api.post.mockResolvedValue({ data: { difference: diferenca } });
    await montar({ ...CAIXA, status: 'open', current_balance: 500 });
    await userEvent.click(screen.getByRole('button', { name: 'cashbox.closeCashbox' }));
  };

  const confirmar = () =>
    userEvent.click(screen.getAllByRole('button', { name: 'cashbox.closeCashbox' })[1]);

  it('mostra o esperado e já sugere o mesmo valor como contado', async () => {
    // Ponto de partida realista: na maioria das vezes bate.
    await fechar();
    // O rótulo e o valor ficam em nós irmãos; a busca é pelo bloco.
    expect(document.querySelector('.cashbox-banner__expected')).toHaveTextContent(
      'R$ 500.00'
    );
    expect(screen.getByLabelText('cashbox.countedBalance')).toHaveValue(500);
  });

  it('caixa que bate dá aviso de sucesso', async () => {
    await fechar(0);
    await confirmar();
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it('sobra vira aviso próprio, não sucesso', async () => {
    // Sobra também é divergência: alguém pagou a mais ou faltou registrar.
    await fechar(30);
    await confirmar();
    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('falta vira aviso próprio com o valor em positivo', async () => {
    // O operador lê "faltaram R$ 20", não "-20".
    await fechar(-20);
    await confirmar();
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('20.00'))
    );
  });

  it('envia o valor contado', async () => {
    await fechar();
    const campo = screen.getByLabelText('cashbox.countedBalance');
    await userEvent.clear(campo);
    await userEvent.type(campo, '480');
    await confirmar();
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/cashboxes/cb1/close', {
        actual_final_balance: 480,
        notes: null,
      })
    );
  });

  it('contado em branco vira zero', async () => {
    await fechar();
    await userEvent.clear(screen.getByLabelText('cashbox.countedBalance'));
    await confirmar();
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        '/cashboxes/cb1/close',
        expect.objectContaining({ actual_final_balance: 0 })
      )
    );
  });

  it('resposta sem diferença é tratada como caixa certo', async () => {
    api.post.mockResolvedValue({ data: {} });
    await montar({ ...CAIXA, status: 'open' });
    await userEvent.click(screen.getByRole('button', { name: 'cashbox.closeCashbox' }));
    await confirmar();
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it('erro do servidor aparece', async () => {
    api.post.mockRejectedValue({ userMessage: 'Nenhuma sessão aberta' });
    await montar({ ...CAIXA, status: 'open' });
    await userEvent.click(screen.getByRole('button', { name: 'cashbox.closeCashbox' }));
    await confirmar();
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Nenhuma sessão aberta')
    );
  });

  it('cancelar não fecha o caixa', async () => {
    await fechar();
    await userEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(api.post).not.toHaveBeenCalled();
  });
});

/**
 * O saldo é a única coisa nesta tela que muda sozinha enquanto o operador
 * trabalha: cada venda registrada no formulário ao lado altera o número aqui.
 * O banner não é filho de quem vende, então precisa ser avisado — antes disso
 * o operador passava a noite olhando o saldo da abertura e só o F5 corrigia.
 */
describe('saldo em dia', () => {
  const ABERTO = { ...CAIXA, status: 'open' };

  it('venda registrada em outra tela atualiza o saldo sem F5', async () => {
    await montar(ABERTO);
    expect(screen.getByText('R$ 500.00')).toBeInTheDocument();

    api.get.mockResolvedValue({ data: { ...ABERTO, current_balance: 620 } });
    act(() => { avisarQueOCaixaMudou(); });

    expect(await screen.findByText('R$ 620.00')).toBeInTheDocument();
  });

  it('o aviso não apaga o saldo enquanto a nova busca não volta', async () => {
    // O estado "carregando" some com o banner inteiro. Usá-lo a cada venda
    // faria a barra piscar no meio da operação — e o operador leria um
    // instante de nada no lugar do dinheiro dele.
    await montar(ABERTO);
    api.get.mockReturnValue(new Promise(() => {})); // busca que nunca volta
    act(() => { avisarQueOCaixaMudou(); });

    expect(screen.getByText('R$ 500.00')).toBeInTheDocument();
  });

  it('alcança sozinho o que mudou em outro aparelho', async () => {
    // Suprimento e sangria lançados pelo supervisor, de outra máquina, não
    // disparam evento nenhum aqui dentro.
    // Os timers falsos precisam valer ANTES de montar: o intervalo nasce no
    // efeito de montagem e um `setInterval` já criado com timer real não
    // responde a `advanceTimersByTime`.
    jest.useFakeTimers();
    try {
      await montar(ABERTO);
      const buscasAteAgora = api.get.mock.calls.length;
      api.get.mockResolvedValue({ data: { ...ABERTO, current_balance: 900 } });

      await act(async () => { jest.advanceTimersByTime(15000); });
      expect(api.get.mock.calls.length).toBeGreaterThan(buscasAteAgora);
      expect(screen.getByText('R$ 900.00')).toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });

  it('deixa de escutar depois de sair da tela', async () => {
    await montar(ABERTO);
    const { unmount } = renderResultado;
    unmount();
    const buscasAteAgora = api.get.mock.calls.length;

    act(() => { avisarQueOCaixaMudou(); });

    expect(api.get.mock.calls.length).toBe(buscasAteAgora);
  });
});
