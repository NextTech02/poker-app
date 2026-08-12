/**
 * Tipos de compra (buy types) são por ETAPA.
 *
 * Cada tipo define nome, categoria e o RAKE próprio daquela entrada — um
 * freeroll com rake zero, uma entrada promocional com rake reduzido. Sem
 * escopo por etapa, o tipo criado num circuito apareceria em outro, e o rake
 * aplicado seria o do evento errado.
 *
 * O `amount` fica sempre em zero de propósito: o valor da entrada vem da
 * configuração do DIA. Um valor no tipo criaria duas fontes para a mesma
 * informação, e a primeira divergência apareceria como caixa que não fecha.
 */
import { render, screen, act, waitFor } from '@testing-library/react';
import { BuyTypesProvider, useBuyTypes } from './BuyTypesContext';
import { useStage } from './StageContext';
import { supabase } from '../config/supabase';

jest.mock('./StageContext', () => ({ useStage: jest.fn() }));
jest.mock('../config/supabase', () => {
  const cadeia = {};
  ['from', 'select', 'eq', 'order', 'insert', 'update', 'delete'].forEach((m) => {
    cadeia[m] = jest.fn(() => cadeia);
  });
  return { supabase: cadeia };
});

const ETAPA = 'etapa-1';
const TIPOS = [
  { id: 'b1', stage_id: ETAPA, name: 'Buy-in', category: 'buy_in',
    rake_percentage: 20, active: true, sort_order: 1 },
  { id: 'b2', stage_id: ETAPA, name: 'Freeroll', category: 'buy_in',
    rake_percentage: 0, active: false, sort_order: 2 },
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

const montar = async (esperado = TIPOS.length) => {
  render(<BuyTypesProvider><Sonda /></BuyTypesProvider>);
  await waitFor(() => expect(screen.getByTestId('qtd')).toHaveTextContent(String(esperado)));
};

beforeEach(() => {
  api = null;
  useStage.mockReturnValue({ selectedStage: { id: ETAPA } });
  ['from', 'select', 'eq', 'insert', 'update', 'delete'].forEach((m) => {
    supabase[m].mockImplementation(() => supabase);
  });
  responder(TIPOS);
});

describe('escopo por etapa', () => {
  it('carrega os tipos da etapa selecionada', async () => {
    await montar();
    expect(supabase.eq).toHaveBeenCalledWith('stage_id', ETAPA);
    expect(api.stageId).toBe(ETAPA);
  });

  it('sem etapa selecionada a lista fica vazia e nada é consultado', async () => {
    // Mostrar os tipos de outra etapa aplicaria o rake do evento errado.
    useStage.mockReturnValue({ selectedStage: null });
    render(<BuyTypesProvider><Sonda /></BuyTypesProvider>);
    await waitFor(() => expect(screen.getByTestId('qtd')).toHaveTextContent('0'));
    expect(supabase.from).not.toHaveBeenCalled();
    expect(api.stageId).toBeNull();
  });

  it('resposta vazia vira lista vazia', async () => {
    responder(null);
    await montar(0);
    expect(api.buyTypes).toEqual([]);
  });

  it('falha de rede mantém a tela utilizável', async () => {
    supabase.order.mockImplementation(() => ({
      order: () => ({ order: () => Promise.reject(new Error('sem sessão')) }),
    }));
    render(<BuyTypesProvider><Sonda /></BuyTypesProvider>);
    await waitFor(() => expect(api.loading).toBe(false));
    expect(api.buyTypes).toEqual([]);
  });
});

describe('consulta', () => {
  it('o caixa só vê os tipos ativos', async () => {
    await montar();
    expect(api.activeBuyTypes.map((b) => b.name)).toEqual(['Buy-in']);
  });

  it('busca por id inclui os inativos', async () => {
    // Transações antigas apontam para tipos que podem ter sido desativados;
    // sem isso o relatório perderia o nome e o rake da entrada.
    await montar();
    expect(api.byId('b2').name).toBe('Freeroll');
  });

  it('id desconhecido devolve null', async () => {
    await montar();
    expect(api.byId('nao-existe')).toBeNull();
  });
});

describe('criação', () => {
  it('grava com a etapa, ativo e no fim da ordem', async () => {
    await montar();
    await act(async () => {
      await api.createBuyType({ name: 'Turbo', category: 'buy_in', rake_percentage: 15 });
    });
    expect(supabase.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        stage_id: ETAPA,
        name: 'Turbo',
        rake_percentage: 15,
        active: true,
        sort_order: 3,
      })
    );
  });

  it('o valor fica zerado — quem define é o dia', async () => {
    // Duas fontes para o valor da entrada apareceriam como caixa que não
    // fecha na primeira divergência.
    await montar();
    await act(async () => {
      await api.createBuyType({ name: 'X', category: 'buy_in', rake_percentage: 0 });
    });
    expect(supabase.insert).toHaveBeenCalledWith(expect.objectContaining({ amount: 0 }));
  });

  it('rake não numérico vira zero em vez de NaN', async () => {
    // NaN gravado no rake contaminaria todo cálculo de prêmio da etapa.
    await montar();
    await act(async () => {
      await api.createBuyType({ name: 'X', category: 'buy_in', rake_percentage: 'abc' });
    });
    expect(supabase.insert).toHaveBeenCalledWith(
      expect.objectContaining({ rake_percentage: 0 })
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

  it('sem etapa não cria', async () => {
    useStage.mockReturnValue({ selectedStage: null });
    render(<BuyTypesProvider><Sonda /></BuyTypesProvider>);
    await waitFor(() => expect(api).toBeTruthy());
    await expect(api.createBuyType({ name: 'X' })).rejects.toThrow('no-stage');
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
    // Tipo já usado em transações não pode sumir em silêncio.
    await montar();
    supabase.delete.mockImplementation(() => ({
      eq: () => Promise.resolve({ error: new Error('em uso') }),
    }));
    await expect(api.deleteBuyType('b1')).rejects.toBeTruthy();
  });
});
