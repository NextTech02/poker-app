/**
 * Avisos e confirmações.
 *
 * Dois comportamentos carregam a intenção do produto:
 *
 * 1. **Deduplicação.** No caixa, o operador clica várias vezes num botão que
 *    está falhando. Sem deduplicar, a tela vira uma pilha de seis toasts
 *    idênticos que cobre o formulário. Aviso repetido REINICIA o tempo do que
 *    já está na tela, em vez de empilhar.
 * 2. **Erro fica mais tempo.** Sucesso o operador só confirma de relance;
 *    erro ele precisa ler — e às vezes anotar.
 *
 * `confirm` devolve uma Promise porque a chamada é feita dentro de um fluxo
 * (`if (await confirm(...)) apagar()`), e não por callback espalhado.
 */
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider, useToast } from './ToastContext';
import { registerToast } from '../utils/toastEmitter';

jest.mock('../utils/toastEmitter', () => ({ registerToast: jest.fn() }));
jest.mock('../components/Toast.css', () => ({}), { virtual: true });

let api;

function Sonda() {
  api = useToast();
  return null;
}

const montar = () => render(<ToastProvider><Sonda /></ToastProvider>);

beforeEach(() => {
  api = null;
});

describe('exibição', () => {
  it.each(['success', 'error', 'warning', 'info'])('mostra um aviso de %s', (tipo) => {
    montar();
    act(() => api[tipo]?.call?.(api, 'mensagem') ?? api.toast[tipo]('mensagem'));
    expect(screen.getByText('mensagem')).toBeInTheDocument();
  });

  it('mostra o título quando informado', () => {
    montar();
    act(() => api.toast.error('Saldo insuficiente', { title: 'Sangria' }));
    expect(screen.getByText('Sangria')).toBeInTheDocument();
    expect(screen.getByText('Saldo insuficiente')).toBeInTheDocument();
  });

  it('sem aviso nenhum não renderiza o contêiner', () => {
    const { container } = montar();
    expect(container.querySelector('.toast-container')).toBeNull();
  });

  it('avisos diferentes se acumulam', () => {
    montar();
    act(() => {
      api.toast.success('primeiro');
      api.toast.error('segundo');
    });
    expect(screen.getByText('primeiro')).toBeInTheDocument();
    expect(screen.getByText('segundo')).toBeInTheDocument();
  });

  it('a mesma mensagem com tipos diferentes não é deduplicada', () => {
    montar();
    act(() => {
      api.toast.success('feito');
      api.toast.error('feito');
    });
    expect(screen.getAllByText('feito')).toHaveLength(2);
  });
});

describe('deduplicação', () => {
  it('aviso idêntico não empilha', () => {
    // O operador clica três vezes num botão que está falhando; três toasts
    // iguais cobririam o formulário. Os três avisos no MESMO lote são o caso
    // difícil: a busca precisa enxergar o que acabou de ser enfileirado, e
    // não o estado que o React ainda vai aplicar na renderização.
    montar();
    act(() => {
      api.toast.error('Falha ao registrar');
      api.toast.error('Falha ao registrar');
      api.toast.error('Falha ao registrar');
    });
    expect(screen.getAllByText('Falha ao registrar')).toHaveLength(1);
  });

  it('o repetido devolve o mesmo identificador', () => {
    montar();
    let a;
    let b;
    act(() => {
      a = api.toast.error('igual');
      b = api.toast.error('igual');
    });
    expect(b).toBe(a);
  });

  it('títulos diferentes contam como avisos diferentes', () => {
    montar();
    act(() => {
      api.toast.error('mesma', { title: 'A' });
      api.toast.error('mesma', { title: 'B' });
    });
    expect(screen.getAllByText('mesma')).toHaveLength(2);
  });

  it('o repetido reinicia o tempo em vez de deixar sumir', async () => {
    jest.useFakeTimers();
    montar();
    act(() => api.toast.error('persistente'));
    act(() => jest.advanceTimersByTime(5000)); // quase no fim dos 6s
    act(() => api.toast.error('persistente')); // renova
    act(() => jest.advanceTimersByTime(5000));
    expect(screen.getByText('persistente')).toBeInTheDocument();
    jest.useRealTimers();
  });
});

describe('tempo em tela', () => {
  it('erro fica mais tempo que sucesso', () => {
    // Sucesso o operador confirma de relance; erro ele precisa ler.
    jest.useFakeTimers();
    montar();
    act(() => {
      api.toast.success('ok');
      api.toast.error('falhou');
    });
    act(() => jest.advanceTimersByTime(4300)); // 4s + animação
    expect(screen.queryByText('ok')).not.toBeInTheDocument();
    expect(screen.getByText('falhou')).toBeInTheDocument();
    jest.useRealTimers();
  });

  it('some sozinho ao fim do tempo', () => {
    jest.useFakeTimers();
    montar();
    act(() => api.toast.info('passageiro'));
    act(() => jest.advanceTimersByTime(4300));
    expect(screen.queryByText('passageiro')).not.toBeInTheDocument();
    jest.useRealTimers();
  });

  it('a duração pode ser definida por chamada', () => {
    jest.useFakeTimers();
    montar();
    act(() => api.toast.info('rápido', { duration: 1000 }));
    act(() => jest.advanceTimersByTime(1300));
    expect(screen.queryByText('rápido')).not.toBeInTheDocument();
    jest.useRealTimers();
  });

  it('pode ser fechado à mão antes do tempo', async () => {
    const usuario = userEvent.setup();
    montar();
    act(() => api.toast.info('fechável'));
    await usuario.click(screen.getByRole('button', { name: '×' }));
    await waitFor(() => expect(screen.queryByText('fechável')).not.toBeInTheDocument());
  });
});

describe('confirmação', () => {
  it('mostra a pergunta e os dois botões', async () => {
    montar();
    act(() => {
      api.confirm('Apagar o torneio?');
    });
    expect(screen.getByText('Apagar o torneio?')).toBeInTheDocument();
    // O titulo padrao tambem e "Confirmar", entao o botao precisa ser
    // encontrado pelo papel, nao pelo texto solto.
    expect(screen.getByRole('button', { name: 'Confirmar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeInTheDocument();
  });

  it('confirmar resolve verdadeiro e fecha', async () => {
    const usuario = userEvent.setup();
    montar();
    let resultado;
    act(() => {
      api.confirm('Apagar?').then((r) => {
        resultado = r;
      });
    });
    await usuario.click(screen.getByRole('button', { name: 'Confirmar' }));
    await waitFor(() => expect(resultado).toBe(true));
    expect(screen.queryByText('Apagar?')).not.toBeInTheDocument();
  });

  it('cancelar resolve falso', async () => {
    // A Promise SEMPRE resolve — deixá-la pendente travaria o fluxo do
    // operador sem nenhuma pista do motivo.
    const usuario = userEvent.setup();
    montar();
    let resultado;
    act(() => {
      api.confirm('Apagar?').then((r) => {
        resultado = r;
      });
    });
    await usuario.click(screen.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(resultado).toBe(false));
  });

  it('clicar fora cancela', async () => {
    const usuario = userEvent.setup();
    const { container } = montar();
    let resultado;
    act(() => {
      api.confirm('Apagar?').then((r) => {
        resultado = r;
      });
    });
    await usuario.click(container.querySelector('.confirm-overlay'));
    await waitFor(() => expect(resultado).toBe(false));
  });

  it('clicar dentro do diálogo não cancela', async () => {
    // Selecionar o texto da pergunta não pode fechar o diálogo.
    const usuario = userEvent.setup();
    const { container } = montar();
    act(() => {
      api.confirm('Apagar?');
    });
    await usuario.click(container.querySelector('.confirm-dialog'));
    expect(screen.getByText('Apagar?')).toBeInTheDocument();
  });

  it('os textos dos botões podem ser trocados', () => {
    montar();
    act(() => {
      api.confirm('Excluir o clube?', {
        title: 'Ação irreversível',
        confirmText: 'Excluir',
        cancelText: 'Voltar',
        variant: 'danger',
      });
    });
    expect(screen.getByText('Ação irreversível')).toBeInTheDocument();
    expect(screen.getByText('Excluir')).toBeInTheDocument();
    expect(screen.getByText('Voltar')).toBeInTheDocument();
  });

  it('a variante perigosa marca o botão de confirmar', () => {
    // Exclusão definitiva não pode ter o mesmo peso visual de um "salvar".
    const { container } = montar();
    act(() => {
      api.confirm('Excluir?', { variant: 'danger' });
    });
    expect(container.querySelector('.confirm-btn-danger')).toBeInTheDocument();
  });
});

describe('uso fora do React', () => {
  it('registra a API para o interceptor do axios', () => {
    // É o que faz um 401 no interceptor virar um aviso na tela, mesmo o
    // interceptor rodando fora da árvore de componentes.
    montar();
    expect(registerToast).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Function) })
    );
  });

  it('usar o hook fora do provedor é um erro explícito', () => {
    // Falhar em silêncio esconderia um provedor esquecido até alguém reparar
    // que nenhum aviso aparece mais.
    const erro = jest.spyOn(console, 'error').mockImplementation(() => {});
    function Solto() {
      useToast();
      return null;
    }
    expect(() => render(<Solto />)).toThrow('ToastProvider');
    erro.mockRestore();
  });
});
