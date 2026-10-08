/**
 * Meios de entrada (buy types) são do TORNEIO.
 *
 * Cada meio de entrada define nome, categoria, VALOR, RAKE e FICHAS daquela
 * entrada — um freeroll com rake zero, um "rebuy duplo" com valor e fichas
 * próprios. Já foram da etapa (só diziam o rake) e do dia (um torneio de três
 * dias repetia a mesma lista três vezes). Agora a lista é UMA por torneio e
 * vale para todos os dias dele.
 *
 * O contexto é SÓ LEITURA: quem grava é o backend, que sabe não apagar um
 * meio já vendido.
 */
import { render, screen, act, waitFor } from '@testing-library/react';
import { BuyTypesProvider, useBuyTypes } from './BuyTypesContext';
import { supabase } from '../config/supabase';
import { getAllByTable } from '../offline/db';

jest.mock('../offline/db', () => ({ getAllByTable: jest.fn(async () => []) }));
jest.mock('../config/supabase', () => {
  const cadeia = {};
  ['from', 'select', 'eq', 'order'].forEach((m) => {
    cadeia[m] = jest.fn(() => cadeia);
  });
  return { supabase: cadeia };
});

const TORNEIO = 'torneio-1';
const TIPOS = [
  { id: 'b1', tournament_id: TORNEIO, name: 'Buy-in', category: 'buy_in',
    amount: 1000, rake_percentage: 20, chips: 30000, active: true, sort_order: 1 },
  { id: 'b2', tournament_id: TORNEIO, name: 'Freeroll', category: 'buy_in',
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

/** Renderiza sem torneio nenhum — o estado em que a tela abre. */
const renderizar = async () => {
  render(<BuyTypesProvider><Sonda /></BuyTypesProvider>);
  await waitFor(() => expect(api).toBeTruthy());
};

/** Renderiza e avisa o torneio escolhido, como o Caixa faz ao abrir a venda. */
const montar = async (esperado = TIPOS.length) => {
  await renderizar();
  await act(async () => api.selectTournament(TORNEIO));
  await waitFor(() => expect(screen.getByTestId('qtd')).toHaveTextContent(String(esperado)));
};

beforeEach(() => {
  api = null;
  getAllByTable.mockResolvedValue([]);
  ['from', 'select', 'eq'].forEach((m) => {
    supabase[m].mockImplementation(() => supabase);
  });
  responder(TIPOS);
});

describe('escopo por torneio', () => {
  it('carrega os meios de entrada do torneio informado', async () => {
    await montar();
    expect(supabase.eq).toHaveBeenCalledWith('tournament_id', TORNEIO);
    expect(api.tournamentId).toBe(TORNEIO);
  });

  it('sem torneio escolhido a lista fica vazia e nada é consultado', async () => {
    // Mostrar os meios de entrada de outro torneio cobraria o preço errado.
    await renderizar();
    expect(screen.getByTestId('qtd')).toHaveTextContent('0');
    expect(supabase.from).not.toHaveBeenCalled();
    expect(api.tournamentId).toBeNull();
  });

  it('trocar de torneio recarrega a lista', async () => {
    // O operador troca o torneio dentro do próprio formulário de venda; a
    // lista precisa acompanhar, senão ele vende o preço do torneio anterior.
    await montar();
    await act(async () => api.selectTournament('torneio-2'));
    await waitFor(() => expect(api.tournamentId).toBe('torneio-2'));
    expect(supabase.eq).toHaveBeenCalledWith('tournament_id', 'torneio-2');
  });

  it('limpar o torneio esvazia a lista', async () => {
    await montar();
    await act(async () => api.selectTournament(''));
    await waitFor(() => expect(screen.getByTestId('qtd')).toHaveTextContent('0'));
    expect(api.origem).toBeNull();
  });

  it('resposta vazia vira lista vazia', async () => {
    responder(null);
    await montar(0);
    expect(api.buyTypes).toEqual([]);
    // Veio do servidor: aí sim dá para afirmar "este torneio não cadastrou nada".
    expect(api.tiposCarregados).toBe(true);
  });

  it('falha de rede mantém a tela utilizável', async () => {
    supabase.order.mockImplementation(() => ({
      order: () => ({ order: () => Promise.reject(new Error('sem sessão')) }),
    }));
    await renderizar();
    await act(async () => api.selectTournament(TORNEIO));
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
    await act(async () => api.selectTournament(TORNEIO));
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

  it('a réplica é filtrada pelo torneio', async () => {
    // Meio de entrada de outro torneio cobraria o preço errado.
    getAllByTable.mockResolvedValue([
      ...TIPOS,
      { id: 'b9', tournament_id: 'outro-torneio', name: 'Outro', category: 'buy_in', active: true },
      // Linha da réplica gravada ANTES da mudança (ainda por dia): não tem
      // torneio, então não entra — melhor lista vazia do que preço de outro.
      { id: 'b8', tournament_day_id: 'dia-1', name: 'Velho', category: 'buy_in', active: true },
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
    await act(async () => api.selectTournament(TORNEIO));
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

  it('o contexto não grava nada: quem salva a lista é o backend', async () => {
    // O PUT do torneio sabe não apagar um meio já vendido; um insert/delete
    // direto daqui passaria por cima dessa regra.
    await montar();
    expect(api.createBuyType).toBeUndefined();
    expect(api.updateBuyType).toBeUndefined();
    expect(api.deleteBuyType).toBeUndefined();
  });
});
