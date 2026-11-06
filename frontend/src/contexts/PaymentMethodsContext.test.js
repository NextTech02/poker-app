/**
 * Formas de pagamento configuráveis pelo clube.
 *
 * Duas decisões carregam o peso:
 *
 * 1. **O código é derivado do rótulo e nunca se repete.** O código é o que
 *    fica gravado em cada transação; dois métodos com o mesmo código
 *    tornariam impossível dizer, no fechamento, qual dos dois recebeu o
 *    dinheiro.
 * 2. **A lista de leitura inclui inativos.** Desativar "Yape" não pode
 *    apagar o rótulo das transações antigas — o extrato da semana passada
 *    passaria a mostrar um código cru no lugar do nome.
 * 3. **A lista acompanha a sessão.** O provider fica acima das rotas e não
 *    desmonta no login. Lista vazia depois de entrar faz o Caixa oferecer só
 *    dinheiro e gravar como dinheiro o que foi pago de outro jeito.
 */
import { render, screen, act, waitFor } from '@testing-library/react';
import { PaymentMethodsProvider, usePaymentMethods } from './PaymentMethodsContext';
import { useAuth } from './AuthContext';
import { supabase } from '../config/supabase';

jest.mock('./AuthContext', () => ({ useAuth: jest.fn() }));
jest.mock('../config/supabase', () => {
  const cadeia = {};
  ['from', 'select', 'order', 'insert', 'update', 'delete', 'eq'].forEach((m) => {
    cadeia[m] = jest.fn(() => cadeia);
  });
  cadeia.then = undefined;
  return { supabase: cadeia };
});

const METODOS = [
  { id: 'm1', code: 'cash', label: 'Dinheiro', active: true, sort_order: 1 },
  { id: 'm2', code: 'yape', label: 'Yape', active: false, sort_order: 2 },
];

let api;

function Sonda() {
  api = usePaymentMethods();
  return <span data-testid="loading">{String(api.loading)}</span>;
}

const responder = (dados) => {
  // A cadeia termina no último `.order(...)`, que precisa virar a resposta.
  supabase.order.mockImplementation(() => {
    const proximo = { ...supabase };
    proximo.order = () => Promise.resolve({ data: dados });
    return proximo;
  });
};

// Elemento novo a cada chamada: com o mesmo, o `rerender` não refaz o provider.
const arvore = () => <PaymentMethodsProvider><Sonda /></PaymentMethodsProvider>;

const carregou = () =>
  waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));

const montar = async () => {
  const tela = render(arvore());
  await carregou();
  return tela;
};

beforeEach(() => {
  api = null;
  ['from', 'select', 'insert', 'update', 'delete', 'eq'].forEach((m) => {
    supabase[m].mockImplementation(() => supabase);
  });
  responder(METODOS);
  useAuth.mockReturnValue({ user: { id: 'u1' }, loading: false });
});

describe('carga', () => {
  it('carrega a lista', async () => {
    await montar();
    expect(api.methods).toHaveLength(2);
  });

  it('o dropdown do caixa só recebe os ativos', async () => {
    // Método desativado não deve aparecer para o operador escolher.
    await montar();
    expect(api.activeMethods.map((m) => m.code)).toEqual(['cash']);
  });

  it('falha de rede mantém a tela utilizável', async () => {
    responder(undefined);
    supabase.order.mockImplementation(() => {
      const proximo = { ...supabase };
      proximo.order = () => Promise.reject(new Error('sem sessão'));
      return proximo;
    });
    await montar();
    expect(api.methods).toEqual([]);
  });

  it('resposta vazia vira lista vazia', async () => {
    responder(null);
    await montar();
    expect(api.methods).toEqual([]);
  });

  it('leitura recusada não apaga a lista que já estava na tela', async () => {
    // O supabase-js não lança: devolve `error` com `data` nulo. Lido como
    // resposta vazia, uma falha passageira deixava o Caixa só com dinheiro.
    await montar();
    supabase.order.mockImplementation(() => {
      const proximo = { ...supabase };
      proximo.order = () => Promise.resolve({ data: null, error: { message: 'JWT expired' } });
      return proximo;
    });
    await act(async () => {
      await api.reload();
    });
    expect(api.methods).toHaveLength(2);
  });
});

describe('login e logout', () => {
  it('quem abriu o app deslogado vê os métodos depois de entrar', async () => {
    // Clube em produção, 2026-11-06: a tela abriu no login, o RLS devolveu lista
    // vazia, e o login troca de rota sem recarregar a página. O Caixa ficou só
    // com dinheiro, e cadastrar USDT batia no método que já existia.
    useAuth.mockReturnValue({ user: null, loading: false });
    responder([]);
    const { rerender } = await montar();
    expect(api.activeMethods).toEqual([]);

    responder(METODOS);
    useAuth.mockReturnValue({ user: { id: 'u1' }, loading: false });
    rerender(arvore());
    await waitFor(() => expect(api.methods).toHaveLength(2));
  });

  it('sair limpa a lista: o próximo a entrar pode ser de outro clube', async () => {
    const { rerender } = await montar();
    responder([]);
    useAuth.mockReturnValue({ user: null, loading: false });
    rerender(arvore());
    await waitFor(() => expect(api.methods).toEqual([]));
  });

  it('espera a sessão: abrir o app logado faz uma consulta só', async () => {
    useAuth.mockReturnValue({ user: null, loading: true });
    const { rerender } = render(arvore());
    expect(supabase.from).not.toHaveBeenCalled();

    useAuth.mockReturnValue({ user: { id: 'u1' }, loading: false });
    rerender(arvore());
    await carregou();
    expect(supabase.from).toHaveBeenCalledTimes(1);
  });

  it('renovar o token não recarrega: é a mesma pessoa', async () => {
    const { rerender } = await montar();
    supabase.from.mockClear();
    useAuth.mockReturnValue({ user: { id: 'u1' }, loading: false });
    rerender(arvore());
    await act(async () => {});
    expect(supabase.from).not.toHaveBeenCalled();
  });
});

describe('rótulo de uma transação', () => {
  it('resolve o rótulo pelo código', async () => {
    await montar();
    expect(api.labelFor('cash')).toBe('Dinheiro');
  });

  it('rótulo de método DESATIVADO continua resolvendo', async () => {
    // O extrato da semana passada não pode passar a mostrar "yape" cru só
    // porque o clube desativou o método hoje.
    await montar();
    expect(api.labelFor('yape')).toBe('Yape');
  });

  it('código desconhecido devolve null', async () => {
    await montar();
    expect(api.labelFor('nao-existe')).toBeNull();
  });

  it('sem código devolve null', async () => {
    await montar();
    expect(api.labelFor(null)).toBeNull();
  });
});

describe('criação', () => {
  it('deriva o código do rótulo', async () => {
    await montar();
    await act(async () => {
      await api.createMethod('Transferência Bancária');
    });
    expect(supabase.insert).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'transferencia-bancaria', label: 'Transferência Bancária' })
    );
  });

  it('rótulo repetido gera um código distinto', async () => {
    // O código é o que fica na transação; repetir tornaria impossível dizer
    // qual dos dois métodos recebeu o dinheiro no fechamento.
    responder([{ id: 'm1', code: 'pix', label: 'Pix', active: true, sort_order: 1 }]);
    await montar();
    await act(async () => {
      await api.createMethod('Pix');
    });
    expect(supabase.insert).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'pix-2' })
    );
  });

  it('rótulo só com símbolos ainda gera um código válido', async () => {
    // Sem o fallback, o código sairia vazio e a transação ficaria sem forma
    // de pagamento identificável.
    responder([]);
    await montar();
    await act(async () => {
      await api.createMethod('$$$');
    });
    expect(supabase.insert).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'metodo' })
    );
  });

  it('nasce ativo e no fim da ordem', async () => {
    await montar();
    await act(async () => {
      await api.createMethod('Novo');
    });
    expect(supabase.insert).toHaveBeenCalledWith(
      expect.objectContaining({ active: true, sort_order: 3 })
    );
  });

  it('rótulo vazio é recusado', async () => {
    await montar();
    await expect(api.createMethod('   ')).rejects.toThrow('empty-label');
    expect(supabase.insert).not.toHaveBeenCalled();
  });

  it('erro do banco sobe para a tela', async () => {
    // Sem propagar, o operador acharia que criou e a lista voltaria sem o
    // método novo, sem explicação.
    await montar();
    supabase.insert.mockImplementation(() =>
      Promise.resolve({ error: new Error('duplicado') })
    );
    await expect(api.createMethod('X')).rejects.toBeTruthy();
  });

  it('método que já existia aparece na lista, e a recusa sobe com o código', async () => {
    // Código repetido quer dizer que a lista da tela estava atrasada: recarregar
    // mostra o método, em vez de deixar o operador tentando de novo.
    responder([]);
    await montar();
    responder(METODOS);
    supabase.insert.mockImplementation(() => Promise.resolve({ error: { code: '23505' } }));
    await act(async () => {
      await expect(api.createMethod('Yape')).rejects.toMatchObject({ code: '23505' });
    });
    expect(api.methods).toHaveLength(2);
  });
});

describe('edição e exclusão', () => {
  it('atualiza carimbando o horário', async () => {
    await montar();
    await act(async () => {
      await api.updateMethod('m1', { label: 'Dinheiro (espécie)' });
    });
    expect(supabase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'Dinheiro (espécie)',
        updated_at: expect.any(String),
      })
    );
  });

  it('erro ao atualizar sobe', async () => {
    await montar();
    supabase.update.mockImplementation(() => ({
      eq: () => Promise.resolve({ error: new Error('sem permissão') }),
    }));
    await expect(api.updateMethod('m1', {})).rejects.toBeTruthy();
  });

  it('exclui', async () => {
    await montar();
    await act(async () => {
      await api.deleteMethod('m1');
    });
    expect(supabase.delete).toHaveBeenCalled();
  });

  it('erro ao excluir sobe', async () => {
    await montar();
    supabase.delete.mockImplementation(() => ({
      eq: () => Promise.resolve({ error: new Error('em uso') }),
    }));
    await expect(api.deleteMethod('m1')).rejects.toBeTruthy();
  });
});
