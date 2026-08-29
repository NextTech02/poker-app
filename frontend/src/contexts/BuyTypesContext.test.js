/**
 * Meios de entrada (buy types) são por DIA do torneio.
 *
 * Cada meio de entrada define nome, categoria, VALOR, RAKE e FICHAS daquela
 * entrada — um freeroll com rake zero, um "rebuy duplo" com valor e fichas
 * próprios. Antes eles pertenciam à ETAPA e só diziam o rake; o valor e as
 * fichas vinham do dia, e por isso "rebuy duplo" só podia ser rebuy × 2 — o
 * que nunca foi verdade.
 *
 * O escopo por DIA é o que permite um torneio de seis dias cobrar seis coisas
 * diferentes (o dia final costuma ter buy-in zerado, porque quem chega lá vem
 * classificado). Sem ele, o dia final cobraria o preço do Dia 1.
 */
import { render, screen, act, waitFor } from '@testing-library/react';
import { BuyTypesProvider, useBuyTypes } from './BuyTypesContext';
import { supabase } from '../config/supabase';
import { getAllByTable } from '../offline/db';

jest.mock('../offline/db', () => ({ getAllByTable: jest.fn(async () => []) }));
jest.mock('../config/supabase', () => {
  const cadeia = {};
  ['from', 'select', 'eq', 'order', 'insert', 'update', 'delete'].forEach((m) => {
    cadeia[m] = jest.fn(() => cadeia);
  });
  return { supabase: cadeia };
});

const DIA = 'dia-1';
const TIPOS = [
  { id: 'b1', tournament_day_id: DIA, name: 'Buy-in', category: 'buy_in',
    amount: 1000, rake_percentage: 20, chips: 30000, active: true, sort_order: 1 },
  { id: 'b2', tournament_day_id: DIA, name: 'Freeroll', category: 'buy_in',
    amount: 0, rake_percentage: 0, chips: 30000, active: false, sort_order: 2 },
];

let api;

function Sonda() {
  api = useBuyTypes();
  return <span data-testid="qtd">{api.buyTypes.length}</span>;
}

/** A consulta encadeia três `.order(...)`; o último resolve a Promise. */
const responder = (dados) => {
  let restantes = 3;
  supabase.order.mockImplementation(() => {
    restantes -= 1;
    if (restantes === 0) {
      restantes = 3;
      return Promise.resolve({ data: dados });
    }
    return supabase;
  });
};

/** Renderiza sem dia nenhum — o estado em que a tela abre. */
const renderizar = async () => {
  render(<BuyTypesProvider><Sonda /></BuyTypesProvider>);
  await waitFor(() => expect(api).toBeTruthy());
};

/** Renderiza e avisa o dia escolhido, como o Caixa faz ao abrir a venda. */
const montar = async (esperado = TIPOS.length) => {
  await renderizar();
  await act(async () => api.selectDay(DIA));
  await waitFor(() => expect(screen.getByTestId('qtd')).toHaveTextContent(String(esperado)));
};

beforeEach(() => {
  api = null;
  getAllByTable.mockResolvedValue([]);
  ['from', 'select', 'eq', 'insert', 'update', 'delete'].forEach((m) => {
    supabase[m].mockImplementation(() => supabase);
  });
  responder(TIPOS);
});

describe('escopo por dia', () => {
  it('carrega os meios de entrada do dia informado', async () => {
    await montar();
    expect(supabase.eq).toHaveBeenCalledWith('tournament_day_id', DIA);
    expect(api.dayId).toBe(DIA);
  });

  it('sem dia escolhido a lista fica vazia e nada é consultado', async () => {
    // Mostrar os meios de entrada de outro dia cobraria o preço do dia errado.
    await renderizar();
    expect(screen.getByTestId('qtd')).toHaveTextContent('0');
    expect(supabase.from).not.toHaveBeenCalled();
    expect(api.dayId).toBeNull();
  });

  it('trocar de dia recarrega a lista', async () => {
    // O operador troca o dia dentro do próprio formulário de venda; a lista
    // precisa acompanhar, senão ele vende o preço do dia anterior.
    await montar();
    await act(async () => api.selectDay('dia-2'));
    await waitFor(() => expect(api.dayId).toBe('dia-2'));
    expect(supabase.eq).toHaveBeenCalledWith('tournament_day_id', 'dia-2');
  });

  it('limpar o dia esvazia a lista', async () => {
    await montar();
    await act(async () => api.selectDay(''));
    await waitFor(() => expect(screen.getByTestId('qtd')).toHaveTextContent('0'));
    expect(api.origem).toBeNull();
  });

  it('resposta vazia vira lista vazia', async () => {
    responder(null);
    await montar(0);
    expect(api.buyTypes).toEqual([]);
    // Veio do servidor: aí sim dá para afirmar "este dia não cadastrou nada".
    expect(api.tiposCarregados).toBe(true);
  });

  it('falha de rede mantém a tela utilizável', async () => {
    supabase.order.mockImplementation(() => ({
      order: () => ({ order: () => Promise.reject(new Error('sem sessão')) }),
    }));
    await renderizar();
    await act(async () => api.selectDay(DIA));
    await waitFor(() => expect(api.loading).toBe(false));
    expect(api.buyTypes).toEqual([]);
  });
});

describe('quando a consulta não volta', () => {
  /**
   * Lista vazia por falha NÃO é "nenhum meio de entrada cadastrado". O Caixa
   * usa essa diferença para decidir entre avisar o cadastro faltando e apenas
   * vender pela categoria — confundir os dois deixa o operador sem vender no
   * meio do evento, mandado cadastrar o que já existe.
   */
  const falharAConsulta = (erro = new Error('Failed to fetch')) => {
    supabase.order.mockImplementation(() => ({
      order: () => ({ order: () => Promise.reject(erro) }),
    }));
  };

  const montarComFalha = async () => {
    await renderizar();
    await act(async () => api.selectDay(DIA));
    await waitFor(() => expect(api.loading).toBe(false));
  };

  it('offline, cai para os últimos meios de entrada vistos na réplica local', async () => {
    // É o que faz o modo offline do Caixa continuar vendendo com o valor certo.
    getAllByTable.mockResolvedValue(TIPOS);
    falharAConsulta();
    await montarComFalha();
    expect(api.buyTypes.map((b) => b.id)).toEqual(['b1', 'b2']);
    expect(api.origem).toBe('replica');
    expect(api.tiposCarregados).toBe(false);
  });

  it('a réplica é filtrada pelo dia', async () => {
    // Meio de entrada de outro dia cobraria o preço do dia errado.
    getAllByTable.mockResolvedValue([
      ...TIPOS,
      { id: 'b9', tournament_day_id: 'outro-dia', name: 'Outro', category: 'buy_in', active: true },
    ]);
    falharAConsulta();
    await montarComFalha();
    expect(api.buyTypes.map((b) => b.id)).toEqual(['b1', 'b2']);
  });

  it('sem réplica, a origem é erro — e não "cadastro vazio"', async () => {
    falharAConsulta();
    await montarComFalha();
    expect(api.origem).toBe('erro');
    expect(api.tiposCarregados).toBe(false);
  });

  it('erro de RLS/sessão não passa por resposta vazia', async () => {
    // O supabase-js NÃO lança nesse caso: devolve { data: null, error }. Sem
    // olhar o `error`, uma sessão expirada virava "nenhum meio de entrada".
    getAllByTable.mockResolvedValue(TIPOS);
    let restantes = 3;
    supabase.order.mockImplementation(() => {
      restantes -= 1;
      if (restantes === 0) {
        restantes = 3;
        return Promise.resolve({ data: null, error: { message: 'JWT expired' } });
      }
      return supabase;
    });
    await renderizar();
    await act(async () => api.selectDay(DIA));
    await waitFor(() => expect(api.loading).toBe(false));
    expect(api.tiposCarregados).toBe(false);
    expect(api.buyTypes.map((b) => b.id)).toEqual(['b1', 'b2']);
  });
});

describe('consulta', () => {
  it('o caixa só vê os meios de entrada ativos', async () => {
    await montar();
    expect(api.activeBuyTypes.map((b) => b.name)).toEqual(['Buy-in']);
  });

  it('busca por id inclui os inativos', async () => {
    // Transações antigas apontam para meios de entrada que podem ter sido
    // desativados; sem isso o relatório perderia o nome e o rake da entrada.
    await montar();
    expect(api.byId('b2').name).toBe('Freeroll');
  });

  it('id desconhecido devolve null', async () => {
    await montar();
    expect(api.byId('nao-existe')).toBeNull();
  });
});

describe('criação', () => {
  it('grava com o dia, ativo e no fim da ordem', async () => {
    await montar();
    await act(async () => {
      await api.createBuyType({
        name: 'Turbo', category: 'buy_in', amount: 500, rake_percentage: 15, chips: 20000,
      });
    });
    expect(supabase.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        tournament_day_id: DIA,
        name: 'Turbo',
        amount: 500,
        rake_percentage: 15,
        chips: 20000,
        active: true,
        sort_order: 3,
      })
    );
  });

  it('valor e fichas ficam NO meio de entrada', async () => {
    // É o que permite "rebuy duplo" ser uma venda própria, e não rebuy × 2.
    await montar();
    await act(async () => {
      await api.createBuyType({
        name: 'Rebuy duplo', category: 'rebuy', amount: 1200, chips: 60000,
      });
    });
    expect(supabase.insert).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 1200, chips: 60000 })
    );
  });

  it('números não numéricos viram zero em vez de NaN', async () => {
    // NaN gravado no rake contaminaria todo cálculo de prêmio do dia.
    await montar();
    await act(async () => {
      await api.createBuyType({
        name: 'X', category: 'buy_in', rake_percentage: 'abc', amount: 'abc', chips: 'abc',
      });
    });
    expect(supabase.insert).toHaveBeenCalledWith(
      expect.objectContaining({ rake_percentage: 0, amount: 0, chips: 0 })
    );
  });

  it('espaços em volta do nome são removidos', async () => {
    await montar();
    await act(async () => {
      await api.createBuyType({ name: '  Turbo  ', category: 'buy_in' });
    });
    expect(supabase.insert).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Turbo' })
    );
  });

  it('sem dia não cria', async () => {
    await renderizar();
    await expect(api.createBuyType({ name: 'X' })).rejects.toThrow('no-day');
  });

  it('erro do banco sobe para a tela', async () => {
    await montar();
    supabase.insert.mockImplementation(() =>
      Promise.resolve({ error: new Error('nome duplicado') })
    );
    await expect(
      api.createBuyType({ name: 'X', category: 'buy_in' })
    ).rejects.toBeTruthy();
  });
});

describe('edição e exclusão', () => {
  it('atualiza carimbando o horário', async () => {
    await montar();
    await act(async () => {
      await api.updateBuyType('b1', { rake_percentage: 10 });
    });
    expect(supabase.update).toHaveBeenCalledWith(
      expect.objectContaining({ rake_percentage: 10, updated_at: expect.any(String) })
    );
  });

  it('erro ao atualizar sobe', async () => {
    await montar();
    supabase.update.mockImplementation(() => ({
      eq: () => Promise.resolve({ error: new Error('sem permissão') }),
    }));
    await expect(api.updateBuyType('b1', {})).rejects.toBeTruthy();
  });

  it('exclui', async () => {
    await montar();
    await act(async () => {
      await api.deleteBuyType('b1');
    });
    expect(supabase.delete).toHaveBeenCalled();
  });

  it('erro ao excluir sobe', async () => {
    // Meio de entrada já usado em transações não pode sumir em silêncio.
    await montar();
    supabase.delete.mockImplementation(() => ({
      eq: () => Promise.resolve({ error: new Error('em uso') }),
    }));
    await expect(api.deleteBuyType('b1')).rejects.toBeTruthy();
  });
});
