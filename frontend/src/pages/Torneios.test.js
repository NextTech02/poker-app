/**
 * Torneios — a lista e a criação.
 *
 * Duas coisas concentram o valor da tela:
 *
 * - **Todo torneio pertence a uma ETAPA.** O vínculo viaja no header
 *   `X-Stage-ID`, então sem etapa selecionada a criação nem sai do navegador —
 *   um torneio órfão não apareceria em relatório nenhum.
 * - **Torneio com classificatórios monta a estrutura inteira sozinho:** o dia
 *   final primeiro, depois N dias classificatórios JÁ APONTANDO para ele, e a
 *   estrutura de blinds aplicada a todos os classificatórios (o dia final fica
 *   em branco, para ser configurado à parte). Criar dia por dia à mão é o que
 *   essa geração evita — e a ordem importa: sem o id do dia final, os
 *   classificatórios não teriam para onde levar os sobreviventes.
 *
 * - **Os MEIOS DE ENTRADA são do torneio** e aparecem no cadastro nos dois
 *   caminhos (com e sem classificatórios): nome, valor, rake (20% por padrão)
 *   e fichas por linha, com "Adicionar entrada" e "Remover". Gravados UMA vez,
 *   no torneio, valem para todos os dias — os classificatórios nascem com as
 *   colunas antigas (buy_in, fichas) copiadas do primeiro meio de cada categoria.
 *
 * Falhas parciais dessa geração NÃO podem virar erro de criação: o torneio já
 * existe, e dizer "falhou" faria o operador criar tudo de novo.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Torneios, { rotuloDoClassificatorio } from './Torneios';
import api from '../config/api';
import { cachedGet, invalidateCache } from '../utils/apiCache';
import { getSelectedStage } from '../utils/stageUtils';
import { useToast } from '../contexts/ToastContext';
import { useStage } from '../contexts/StageContext';
import { useCurrency } from '../contexts/CurrencyContext';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), put: jest.fn(), delete: jest.fn() },
}));
jest.mock('../utils/apiCache', () => ({ cachedGet: jest.fn(), invalidateCache: jest.fn() }));
jest.mock('../utils/stageUtils', () => ({ getSelectedStage: jest.fn() }));
jest.mock('../hooks/usePolling', () => ({ usePolling: jest.fn() }));
jest.mock('../components/Sidebar', () => () => <nav data-testid="sidebar" />);
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../contexts/StageContext', () => ({ useStage: jest.fn() }));
jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));
jest.mock('react-i18next', () => {
  // Interpola {{var}} como o i18next de verdade: a confirmação de exclusão
  // existe justamente para mostrar NÚMEROS, e um mock que devolve o texto cru
  // deixaria passar uma mensagem sem número nenhum.
  const t = (chave, segundo, terceiro) => {
    const padrao = typeof segundo === 'string' ? segundo : chave;
    const vars = typeof segundo === 'string' ? terceiro : segundo;
    if (!vars) return padrao;
    return padrao.replace(/\{\{(\w+)\}\}/g, (bruto, nome) =>
      vars[nome] === undefined ? bruto : String(vars[nome])
    );
  };
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const TORNEIOS = [
  // 80 pessoas na mesa e 40 reentradas. O numero antigo somava tudo (120) e
  // mostrava ao lado de um icone de pessoas — era o que inflava a contagem.
  { id: 't1', name: 'Main Event', status: 'active', total_entries: 120, total_players: 80, total_reentries: 40, has_qualifying: true },
  { id: 't2', name: 'Turbo', status: 'PENDING', total_entries: 0, total_players: 0, total_reentries: 0 },
  { id: 't3', name: 'Antigo', status: 'completed', total_entries: 55, total_players: 55, total_reentries: 0 },
];

const MODELOS = [{ id: 'bt1', name: 'Turbo 15min' }];

const ETAPA = { id: 'e1', name: 'Etapa 1' };

let toast;
let confirmar;

const responder = ({ torneios = TORNEIOS, modelos = MODELOS } = {}) => {
  cachedGet.mockImplementation((_api, url) => {
    if (url === '/tournaments') {
      return torneios instanceof Error ? Promise.reject(torneios) : Promise.resolve(torneios);
    }
    if (url === '/blind-templates') return Promise.resolve(modelos);
    return Promise.resolve([]);
  });
};

const montar = async (opcoes) => {
  responder(opcoes);
  render(<MemoryRouter><Torneios /></MemoryRouter>);
  await waitFor(() => expect(document.querySelector('.skeleton-tournament-card')).toBeNull());
};

const cartaoDe = (nome) =>
  Array.from(document.querySelectorAll('.tr-card')).find(
    (el) => el.querySelector('.tr-card-name')?.textContent === nome
  );

const abrirNovo = () =>
  userEvent.click(screen.getByRole('button', { name: /tournaments.newTournament/ }));

const campo = (rotulo) => screen.getByLabelText(rotulo);

// ── Meios de entrada ────────────────────────────────────────────────────────
// As linhas não têm id fixo (uma linha nova ainda não existe no banco), então a
// busca é pela posição na lista, que é a ordem que o operador vê.
const linhas = () => Array.from(document.querySelectorAll('.entry-method-row'));
const linha = (indice) => {
  const raiz = linhas()[indice];
  const numeros = raiz.querySelectorAll('input[type="number"]');
  return {
    nome: raiz.querySelector('input[type="text"]'),
    valor: numeros[0],
    rake: numeros[1],
    fichas: numeros[2],
    categoria: raiz.querySelector('select'),
    remover: raiz.querySelector('button'),
  };
};
const escreverNa = async (indice, qual, valor) => {
  const alvo = linha(indice)[qual];
  await userEvent.clear(alvo);
  if (valor !== '') await userEvent.type(alvo, String(valor));
};
const enviosDeMeios = () => api.put.mock.calls.filter((c) => c[0].endsWith('/buy-types'));

beforeEach(() => {
  toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn() };
  confirmar = jest.fn().mockResolvedValue(true);
  useToast.mockReturnValue({ toast, confirm: confirmar });
  useStage.mockReturnValue({ selectedStage: ETAPA });
  useCurrency.mockReturnValue({
    currency: 'BRL',
    formatCurrency: (v) => `R$ ${Number(v || 0).toFixed(2)}`,
  });
  api.get.mockRejectedValue(new Error('sem endpoint'));
  getSelectedStage.mockReturnValue(ETAPA);
  api.post.mockResolvedValue({ data: { id: 'novo' } });
  api.patch.mockResolvedValue({ data: {} });
  api.put.mockResolvedValue({ data: [] });
  api.delete.mockResolvedValue({ data: {} });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => console.error.mockRestore());

describe('lista', () => {
  it('mostra o esqueleto enquanto carrega', () => {
    cachedGet.mockReturnValue(new Promise(() => {}));
    render(<MemoryRouter><Torneios /></MemoryRouter>);
    expect(document.querySelectorAll('.skeleton-tournament-card').length).toBeGreaterThan(0);
  });

  it('o card conta JOGADORES, nao entradas', async () => {
    // Reclamacao do dono do clube: "os rebuys e addons estao entrando como
    // sendo novos jogadores, aumentando a contagem de um torneio". Quem
    // recompra tres vezes continua sendo UMA pessoa na mesa.
    await montar();
    expect(cartaoDe('Main Event')).toHaveTextContent('80 jogadores');
  });

  it('reentradas aparecem num numero proprio, sem somar aos jogadores', async () => {
    await montar();
    expect(cartaoDe('Main Event')).toHaveTextContent('40 reentradas');
    // 120 era a soma antiga — nao pode voltar a aparecer.
    expect(cartaoDe('Main Event')).not.toHaveTextContent('120');
  });

  it('torneio sem reentrada nao mostra o campo', async () => {
    // Numero zerado na tela so faz o operador parar de ler.
    await montar();
    expect(cartaoDe('Antigo')).toHaveTextContent('55 jogadores');
    expect(cartaoDe('Antigo')).not.toHaveTextContent('reentrada');
  });

  it('torneio com classificatórios é sinalizado', async () => {
    // É o que diferencia um torneio de um dia de um circuito inteiro.
    await montar();
    expect(cartaoDe('Main Event')).toHaveTextContent('Com Classificatórias');
    expect(cartaoDe('Turbo')).not.toHaveTextContent('Com Classificatórias');
  });

  it.each([
    ['Main Event', 'Ativo'],
    ['Antigo', 'Concluído'],
  ])('%s mostra o status "%s"', async (nome, rotulo) => {
    await montar();
    expect(cartaoDe(nome)).toHaveTextContent(rotulo);
  });

  it('status em maiúsculas é normalizado', async () => {
    // O backend não garante o caixa da string; "PENDING" não pode virar
    // "Pendente" só às vezes.
    await montar();
    expect(cartaoDe('Turbo')).toHaveTextContent('Pendente');
  });

  it('status desconhecido cai em pendente, sem sumir da lista', async () => {
    await montar({ torneios: [{ id: 't9', name: 'Novo', status: 'rascunho' }] });
    expect(cartaoDe('Novo')).toHaveTextContent('Pendente');
  });

  it('status ausente também', async () => {
    await montar({ torneios: [{ id: 't9', name: 'Novo' }] });
    expect(cartaoDe('Novo')).toHaveTextContent('Pendente');
  });

  it('sem torneio nenhum convida a criar o primeiro', async () => {
    await montar({ torneios: [] });
    expect(screen.getByText('tournaments.noTournaments')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'tournaments.createFirst' }));
    expect(document.querySelector('.tr-modal, .modal')).toBeTruthy();
  });

  it('falha ao carregar não deixa a tela presa no esqueleto', async () => {
    await montar({ torneios: new Error('500') });
    expect(document.querySelector('.skeleton-tournament-card')).toBeNull();
  });

  it('o cartão leva à tela do torneio', async () => {
    await montar();
    expect(cartaoDe('Main Event')).toBeInTheDocument();
  });
});

describe('vínculo com a etapa', () => {
  it('sem etapa selecionada a criação nem chega no servidor', async () => {
    // Um torneio órfão de etapa não apareceria em relatório nenhum.
    getSelectedStage.mockReturnValue(null);
    await montar();
    await abrirNovo();
    await userEvent.type(campo(/tournaments.tournamentName/), 'Novo');
    await userEvent.click(screen.getByRole('button', { name: 'tournaments.createFirst' }));
    expect(screen.getByText('tournaments.selectStageFirst')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('com etapa selecionada a criação segue', async () => {
    await montar();
    await abrirNovo();
    await userEvent.type(campo(/tournaments.tournamentName/), 'Novo');
    await userEvent.click(screen.getByRole('button', { name: 'tournaments.createFirst' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/tournaments', {
        name: 'Novo', has_qualifying: false, elimination_mode: 'bulk', ko_format: 'none',
      })
    );
  });

  it('o diretor escolhe eliminar pelas mesas na criação', async () => {
    // "Por posição nas mesas" é mais organizado: o jogador é eliminado no
    // assento e a reentrada é dele. O padrão segue "em massa".
    await montar();
    await abrirNovo();
    await userEvent.type(campo(/tournaments.tournamentName/), 'Novo');
    await userEvent.click(screen.getByRole('radio', { name: /tournaments.eliminationModeTable/ }));
    await userEvent.click(screen.getByRole('button', { name: 'tournaments.createFirst' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/tournaments', expect.objectContaining({
        elimination_mode: 'table',
      }))
    );
  });

  it('em massa vem marcado por padrão', async () => {
    await montar();
    await abrirNovo();
    expect(screen.getByRole('radio', { name: /tournaments.eliminationModeBulk/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /tournaments.eliminationModeTable/ })).not.toBeChecked();
  });
});

describe('criar torneio simples', () => {
  const criar = async (nome = 'Novo') => {
    await abrirNovo();
    await userEvent.type(campo(/tournaments.tournamentName/), nome);
    await userEvent.click(screen.getByRole('button', { name: 'tournaments.createFirst' }));
  };

  it('não há patrocinador no torneio: o campo não existe e nada vai no payload', async () => {
    // Patrocinador é do JOGADOR (cadastro de jogadores), não do torneio.
    // Pedido do cliente, 2026-10. A lista de patrocinadores nem é buscada.
    await montar();
    await criar();
    expect(screen.queryByLabelText(/tournaments.sponsor/)).toBeNull();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0][1]).not.toHaveProperty('sponsor_id');
    expect(cachedGet.mock.calls.some(([, url]) => String(url).startsWith('/sponsors'))).toBe(false);
  });

  it('criar invalida o cache da lista', async () => {
    // Sem invalidar, o torneio recém-criado sumiria por até 30 segundos.
    await montar();
    await criar();
    await waitFor(() => expect(invalidateCache).toHaveBeenCalledWith('/tournaments'));
  });

  it('erro do servidor aparece dentro do formulário', async () => {
    // Um toast some; o erro precisa ficar ao lado do campo que causou.
    api.post.mockRejectedValue({ userMessage: 'Nome já usado nesta etapa' });
    await montar();
    await criar();
    expect(await screen.findByText('Nome já usado nesta etapa')).toBeInTheDocument();
    expect(document.querySelector('.tr-modal, form')).toBeTruthy();
  });

  it('erro de validação em lista vira uma frase legível', async () => {
    // O 422 do FastAPI é uma lista de objetos; renderizá-la crua quebraria a
    // tela.
    api.post.mockRejectedValue({
      response: { data: { detail: [{ msg: 'nome curto' }, { msg: 'etapa inválida' }] } },
    });
    await montar();
    await criar();
    expect(await screen.findByText('nome curto | etapa inválida')).toBeInTheDocument();
  });

  it('erro sem mensagem cai numa frase padrão', async () => {
    api.post.mockRejectedValue(new Error('boom'));
    await montar();
    await criar();
    expect(await screen.findByText('tournaments.createError')).toBeInTheDocument();
  });

  it('cancelar fecha sem criar', async () => {
    await montar();
    await abrirNovo();
    await userEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(api.post).not.toHaveBeenCalled();
  });

  it('o cadastro abre com Buy-in, Rebuy e Add-on, rake 20% e valor em branco', async () => {
    // Sem classificatórios TAMBÉM: a lista é do torneio, não do dia. O valor
    // fica em branco porque é o que o operador precisa digitar.
    await montar();
    await abrirNovo();
    expect(linhas()).toHaveLength(3);
    expect([0, 1, 2].map((i) => linha(i).categoria.value)).toEqual(['buy_in', 'rebuy', 'addon']);
    expect(linha(0).rake).toHaveValue(20);
    expect(linha(0).valor).toHaveValue(null);
  });

  it('o torneio simples também nasce com os meios de entrada, gravados UMA vez', async () => {
    // Antes o caminho sem classificatórios não criava nada, e o Caixa vendia
    // pela categoria com o valor do dia.
    await montar();
    await abrirNovo();
    await userEvent.type(campo(/tournaments.tournamentName/), 'Novo');
    await escreverNa(0, 'valor', 150);
    await escreverNa(0, 'rake', 15);
    await userEvent.click(screen.getByRole('button', { name: 'tournaments.createFirst' }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(enviosDeMeios()).toHaveLength(1);
    expect(enviosDeMeios()[0][0]).toBe('/tournaments/novo/buy-types');
    const itens = enviosDeMeios()[0][1].items;
    expect(itens.map((i) => i.category)).toEqual(['buy_in', 'rebuy', 'addon']);
    expect(itens[0]).toMatchObject({ amount: 150, rake_percentage: 15, chips: 10000, active: true, sort_order: 0 });
    expect(itens[1].rake_percentage).toBe(20);
  });

  it('"Adicionar entrada" acrescenta uma linha em branco com rake 20, que vai no envio', async () => {
    await montar();
    await abrirNovo();
    await userEvent.type(campo(/tournaments.tournamentName/), 'Novo');
    await userEvent.click(screen.getByRole('button', { name: 'Adicionar entrada' }));
    expect(linhas()).toHaveLength(4);
    expect(linha(3).rake).toHaveValue(20);
    await userEvent.type(linha(3).nome, 'Buy-in duplo');
    await escreverNa(3, 'valor', 300);
    await escreverNa(3, 'fichas', 25000);
    await userEvent.click(screen.getByRole('button', { name: 'tournaments.createFirst' }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(enviosDeMeios()[0][1].items[3]).toMatchObject({
      id: null, name: 'Buy-in duplo', category: 'buy_in', amount: 300, chips: 25000,
    });
  });

  it('"Remover" tira o meio de entrada da lista', async () => {
    await montar();
    await abrirNovo();
    await userEvent.type(campo(/tournaments.tournamentName/), 'Novo');
    await userEvent.click(linha(2).remover);
    expect(linhas()).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'tournaments.createFirst' }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(enviosDeMeios()[0][1].items.map((i) => i.category)).toEqual(['buy_in', 'rebuy']);
  });

  it('meio sem nome bloqueia a criação antes de chamar o servidor', async () => {
    // Um meio sem nome não dá para escolher no Caixa.
    await montar();
    await abrirNovo();
    await userEvent.type(campo(/tournaments.tournamentName/), 'Novo');
    await escreverNa(0, 'nome', '');
    await userEvent.click(screen.getByRole('button', { name: 'tournaments.createFirst' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Dê um nome a cada meio de entrada.');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('não dá para ficar sem meio de Entrada', async () => {
    await montar();
    await abrirNovo();
    await userEvent.click(linha(0).remover);
    expect(linhas()).toHaveLength(3);
    expect(screen.getByRole('alert')).toHaveTextContent(/ao menos um meio de entrada/i);
  });

  it('falha só nos meios de entrada avisa, sem desfazer o torneio', async () => {
    api.put.mockRejectedValue(new Error('500'));
    await montar();
    await criar();
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('meios de entrada'))
    );
    expect(toast.success).toHaveBeenCalledWith('tournaments.createdSuccess');
  });

  it('Esc fecha o modal — quem opera só pelo teclado não fica preso nele', async () => {
    await montar();
    await abrirNovo();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('criar torneio com classificatórios', () => {
  const ligarQualificatorias = async () =>
    userEvent.click(screen.getByRole('switch'));

  const criarComQuali = async (ajustes = async () => {}) => {
    await abrirNovo();
    await userEvent.type(campo(/tournaments.tournamentName/), 'Circuito');
    await ligarQualificatorias();
    await ajustes();
    await userEvent.click(screen.getByRole('button', { name: 'tournaments.createFirst' }));
  };

  it('os campos dos classificatórios só aparecem com a opção ligada', async () => {
    await montar();
    await abrirNovo();
    expect(screen.queryByLabelText('Dias classificatórios')).toBeNull();
    await ligarQualificatorias();
    expect(screen.getByLabelText('Dias classificatórios')).toBeInTheDocument();
  });

  it('o dia FINAL é criado primeiro, para os classificatórios apontarem para ele', async () => {
    // Sem o id do final, os classificatórios não teriam para onde levar os
    // sobreviventes.
    await montar();
    await criarComQuali();
    await waitFor(() => expect(api.post.mock.calls.length).toBeGreaterThan(2));
    const dias = api.post.mock.calls.filter((c) => c[0] === '/tournament-days');
    expect(dias[0][1]).toMatchObject({ day_type: 'final', day_name: 'Dia Final' });
  });

  it('os classificatórios se chamam Dia 1A, Dia 1B… (como o clube chama)', async () => {
    await montar();
    await criarComQuali();
    await waitFor(() => expect(api.post.mock.calls.length).toBeGreaterThan(2));
    const nomes = api.post.mock.calls
      .filter((c) => c[0] === '/tournament-days' && c[1].day_type === 'qualifying')
      .map((c) => c[1].day_name);
    expect(nomes).toEqual(['Dia 1A', 'Dia 1B']);
  });

  it('cada classificatório já nasce vinculado ao dia final', async () => {
    await montar();
    await criarComQuali();
    await waitFor(() => expect(api.post.mock.calls.length).toBeGreaterThan(2));
    const classificatorios = api.post.mock.calls
      .filter((c) => c[0] === '/tournament-days' && c[1].day_type === 'qualifying');
    expect(classificatorios).toHaveLength(2);
    classificatorios.forEach((c) => expect(c[1].qualifies_to_day_id).toBe('novo'));
  });

  it('a quantidade de dias escolhida é respeitada', async () => {
    await montar();
    await criarComQuali(async () => {
      const qtd = screen.getByLabelText('Dias classificatórios');
      await userEvent.clear(qtd);
      await userEvent.type(qtd, '4');
    });
    await waitFor(() => {
      const q = api.post.mock.calls.filter((c) => c[0] === '/tournament-days' && c[1].day_type === 'qualifying');
      expect(q).toHaveLength(4);
    });
  });

  it('quantidade em branco vira um dia, não zero', async () => {
    await montar();
    await criarComQuali(async () => {
      await userEvent.clear(screen.getByLabelText('Dias classificatórios'));
    });
    await waitFor(() => {
      const q = api.post.mock.calls.filter((c) => c[0] === '/tournament-days' && c[1].day_type === 'qualifying');
      expect(q).toHaveLength(1);
    });
  });

  it('as colunas antigas dos classificatórios seguem o primeiro meio de cada categoria', async () => {
    // Telas e relatórios que ainda leem day.buy_in não podem contar outra
    // história diferente da que o Caixa cobra.
    await montar();
    await criarComQuali(async () => {
      await escreverNa(0, 'valor', 250);
      await escreverNa(0, 'fichas', 15000);
      await escreverNa(2, 'valor', 0); // add-on zerado → nulo no dia
    });
    await waitFor(() => {
      const q = api.post.mock.calls.filter((c) => c[0] === '/tournament-days' && c[1].day_type === 'qualifying');
      expect(q).toHaveLength(2);
      q.forEach((c) => expect(c[1]).toMatchObject({ buy_in: 250, starting_chips: 15000, addon_amount: null }));
    });
  });

  it('o bloco dos classificatórios não pede mais buy-in nem fichas', async () => {
    // Vêm da lista de meios de entrada, que vale para todos os dias.
    await montar();
    await abrirNovo();
    await ligarQualificatorias();
    expect(screen.queryByLabelText(/Buy-in por dia classificatório/)).toBeNull();
    expect(screen.queryByLabelText(/Fichas iniciais/)).toBeNull();
    expect(screen.getByLabelText(/Máximo de jogadores/)).toBeInTheDocument();
  });

  it('o rake dos dias vai ZERO: quem define é o tipo de buy', async () => {
    // Rake em dois lugares seria contado duas vezes.
    await montar();
    await criarComQuali();
    await waitFor(() => {
      const q = api.post.mock.calls.filter((c) => c[0] === '/tournament-days' && c[1].day_type === 'qualifying');
      q.forEach((c) => expect(c[1].rake_percentage).toBe(0));
    });
  });

  it('a moeda segue a configuração global, sem escolha por torneio', async () => {
    await montar();
    await criarComQuali();
    await waitFor(() => {
      const q = api.post.mock.calls.filter((c) => c[0] === '/tournament-days' && c[1].day_type === 'qualifying');
      q.forEach((c) => expect(c[1].currency).toBe('BRL'));
    });
  });

  it('o dia final não vende entrada', async () => {
    // Quem chega no final vem do classificatório.
    await montar();
    await criarComQuali();
    await waitFor(() => expect(api.post.mock.calls.length).toBeGreaterThan(2));
    const final = api.post.mock.calls.find((c) => c[0] === '/tournament-days' && c[1].day_type === 'final');
    expect(final[1]).toMatchObject({ buy_in: 0, rake_percentage: 0, starting_chips: 0 });
  });

  it('o modelo de blinds é aplicado a TODOS os classificatórios', async () => {
    await montar();
    await criarComQuali(async () => {
      await userEvent.selectOptions(
        screen.getByLabelText(/tournaments.blindTemplate|Estrutura de blinds/i),
        'bt1'
      );
    });
    await waitFor(() => {
      const aplicacoes = api.post.mock.calls.filter((c) => c[0] === '/blind-templates/apply');
      expect(aplicacoes).toHaveLength(2);
    });
  });

  it('o dia FINAL fica sem estrutura, para ser configurado à parte', async () => {
    await montar();
    await criarComQuali(async () => {
      await userEvent.selectOptions(
        screen.getByLabelText(/tournaments.blindTemplate|Estrutura de blinds/i),
        'bt1'
      );
    });
    await waitFor(() => {
      const aplicacoes = api.post.mock.calls.filter((c) => c[0] === '/blind-templates/apply');
      expect(aplicacoes.every((c) => c[1].tournament_day_id === 'novo')).toBe(true);
    });
  });

  it('sem modelo escolhido nenhuma estrutura é aplicada', async () => {
    await montar();
    await criarComQuali();
    await waitFor(() => expect(api.post.mock.calls.length).toBeGreaterThan(2));
    expect(api.post.mock.calls.some((c) => c[0] === '/blind-templates/apply')).toBe(false);
  });

  it('os meios de entrada são cadastrados UMA vez, no torneio — não em cada dia', async () => {
    // A lista é do torneio e vale para todos os dias, inclusive os criados
    // depois à mão. Por dia, um torneio de três dias repetia a lista três vezes.
    await montar();
    await criarComQuali(async () => {
      await escreverNa(0, 'valor', 250);
    });
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(enviosDeMeios()).toHaveLength(1);
    expect(enviosDeMeios()[0][0]).toBe('/tournaments/novo/buy-types');
    const itens = enviosDeMeios()[0][1].items;
    expect(itens.map((i) => i.category)).toEqual(['buy_in', 'rebuy', 'addon']);
    expect(itens[0]).toMatchObject({ amount: 250, chips: 10000, rake_percentage: 20, active: true });
  });

  it('falha só nos meios de entrada avisa, e os dias são criados mesmo assim', async () => {
    api.put.mockRejectedValue(new Error('500'));
    await montar();
    await criarComQuali();
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        expect.stringContaining('meios de entrada')
      )
    );
    expect(toast.success).toHaveBeenCalledWith('tournaments.createdSuccess');
    const dias = api.post.mock.calls.filter((c) => c[0] === '/tournament-days');
    expect(dias).toHaveLength(3);
  });

  it('falha ao gerar os dias NÃO vira erro de criação do torneio', async () => {
    // O torneio já existe; dizer "falhou" faria o operador criar tudo de novo.
    api.post.mockImplementation((url) =>
      url === '/tournament-days'
        ? Promise.reject(new Error('500'))
        : Promise.resolve({ data: { id: 'novo' } })
    );
    await montar();
    await criarComQuali();
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        expect.stringContaining('erro ao gerar os dias')
      )
    );
    expect(toast.success).toHaveBeenCalledWith('tournaments.createdSuccess');
  });

  it('falha só na estrutura de blinds avisa para aplicar à mão', async () => {
    api.post.mockImplementation((url) =>
      url === '/blind-templates/apply'
        ? Promise.reject(new Error('500'))
        : Promise.resolve({ data: { id: 'novo' } })
    );
    await montar();
    await criarComQuali(async () => {
      await userEvent.selectOptions(
        screen.getByLabelText(/tournaments.blindTemplate|Estrutura de blinds/i),
        'bt1'
      );
    });
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        expect.stringContaining('estrutura de blinds')
      )
    );
    expect(toast.success).toHaveBeenCalledWith('tournaments.createdSuccess');
  });
});

describe('editar torneio', () => {
  const editar = async (nome) =>
    userEvent.click(within(cartaoDe(nome)).getByRole('button', { name: /common.edit|Editar/ }));

  it('abre com o nome atual', async () => {
    await montar();
    await editar('Main Event');
    expect(campo(/tournaments.tournamentName/)).toHaveValue('Main Event');
  });

  it('a edição não oferece gerar dias de novo', async () => {
    // Os dias já existem; regerar duplicaria a estrutura.
    await montar();
    await editar('Main Event');
    expect(screen.queryByLabelText('Dias classificatórios')).toBeNull();
  });

  const MEIOS_DO_TORNEIO = [
    { id: 'm2', name: 'Rebuy', category: 'rebuy', amount: 300, rake_percentage: 10, chips: 30000, active: true, sort_order: 1 },
    { id: 'm1', name: 'Buy-in', category: 'buy_in', amount: 500, rake_percentage: 10, chips: 30000, active: true, sort_order: 0 },
    { id: 'velho', name: 'Promo', category: 'buy_in', amount: 50, rake_percentage: 5, chips: 5000, active: false, sort_order: 9 },
  ];

  const comMeiosNoServidor = () =>
    api.get.mockImplementation((url) =>
      url === '/tournaments/t1/buy-types'
        ? Promise.resolve({ data: MEIOS_DO_TORNEIO })
        : Promise.reject(new Error('sem endpoint'))
    );

  it('a edição carrega os meios do torneio, na ordem cadastrada, e os salva junto', async () => {
    // É aqui que o clube EXCLUI um meio já cadastrado ou acrescenta outro.
    comMeiosNoServidor();
    await montar();
    await editar('Main Event');
    await waitFor(() => expect(linhas()).toHaveLength(2)); // o desativado não aparece
    expect(linha(0).nome).toHaveValue('Buy-in');
    expect(linha(1).nome).toHaveValue('Rebuy');
    expect(linha(0).rake).toHaveValue(10); // o rake gravado fica; 20 é só para linha nova
    await userEvent.click(linha(1).remover);
    await userEvent.click(screen.getByRole('button', { name: 'tournaments.saveChanges' }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(api.patch).toHaveBeenCalled();
    expect(enviosDeMeios()[0][0]).toBe('/tournaments/t1/buy-types');
    const itens = enviosDeMeios()[0][1].items;
    // Só o Buy-in ativo ficou; o desativado volta intocado, no fim.
    expect(itens.map((i) => i.id)).toEqual(['m1', 'velho']);
    expect(itens[1]).toMatchObject({ active: false });
  });

  it('sem conseguir carregar os meios, a edição NÃO os sobrescreve', async () => {
    // Uma carga falhada virando lista vazia apagaria o cadastro do torneio.
    await montar(); // api.get rejeita por padrão
    await editar('Main Event');
    expect(await screen.findByRole('alert')).toHaveTextContent(/Não foi possível carregar os meios de entrada/);
    expect(screen.getByRole('button', { name: 'Adicionar entrada' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'tournaments.saveChanges' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(api.put).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('tournaments.updatedSuccess');
  });

  it('falha ao salvar os meios mantém o modal aberto com o erro', async () => {
    comMeiosNoServidor();
    api.put.mockRejectedValue({ userMessage: 'Meio de entrada não pertence a este torneio' });
    await montar();
    await editar('Main Event');
    await waitFor(() => expect(linhas()).toHaveLength(2));
    await userEvent.click(screen.getByRole('button', { name: 'tournaments.saveChanges' }));
    expect(await screen.findByText('Meio de entrada não pertence a este torneio')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('salvar envia PATCH e invalida o cache', async () => {
    await montar();
    await editar('Main Event');
    const nome = campo(/tournaments.tournamentName/);
    await userEvent.clear(nome);
    await userEvent.type(nome, 'Main Event 2026');
    await userEvent.click(screen.getByRole('button', { name: 'tournaments.saveChanges' }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/tournaments/t1', {
        name: 'Main Event 2026', has_qualifying: true, elimination_mode: 'bulk',
      })
    );
    expect(invalidateCache).toHaveBeenCalledWith('/tournaments');
  });

  it('erro ao salvar aparece no formulário', async () => {
    api.patch.mockRejectedValue({ userMessage: 'Torneio em andamento' });
    await montar();
    await editar('Main Event');
    await userEvent.click(screen.getByRole('button', { name: 'tournaments.saveChanges' }));
    expect(await screen.findByText('Torneio em andamento')).toBeInTheDocument();
  });
});

/**
 * Excluir torneio.
 *
 * Apagar um torneio é ON DELETE CASCADE em tudo o que pendura nele: vendas,
 * inscrições, dias, premiação, blinds e assentos. Some o dinheiro recebido e o
 * registro de quem pagou — e o caixa da etapa NÃO é estornado (os gatilhos são
 * só de INSERT), então o saldo passa a apontar dinheiro sem origem e a etapa
 * deixa de fechar.
 *
 * Daí as duas regras que estes testes fixam: a confirmação mostra NÚMEROS
 * REAIS antes do clique, e torneio com dinheiro em cima nem chega a perguntar.
 */
describe('excluir torneio', () => {
  const excluir = async (nome) =>
    userEvent.click(within(cartaoDe(nome)).getByRole('button', { name: /common.delete|Excluir/ }));

  const impacto = (extra = {}) =>
    api.get.mockResolvedValue({
      data: {
        tournament_id: 't2', tournament_name: 'Turbo',
        days: 0, players: 0, paying_players: 0,
        entries: 0, entries_amount: 0, prizes: 0, prizes_amount: 0,
        cancelled_entries: 0, blocked: false, ...extra,
      },
    });

  it('pede confirmação de perigo', async () => {
    await montar();
    await excluir('Turbo');
    expect(confirmar).toHaveBeenCalledWith(
      'tournaments.confirmDelete',
      expect.objectContaining({ variant: 'danger' })
    );
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/tournaments/t2'));
  });

  it('a confirmação diz o que será destruído, com números reais', async () => {
    // "Tem certeza?" não distingue um torneio vazio de uma noite inteira de
    // operação. O operador precisa ler o tamanho do estrago ANTES de confirmar.
    impacto({ days: 3, players: 12, cancelled_entries: 4 });
    await montar();
    await excluir('Turbo');
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/tournaments/t2/delete-impact'));
    const [mensagem] = confirmar.mock.calls[0];
    expect(mensagem).toContain('3');
    expect(mensagem).toContain('12');
    expect(mensagem).toContain('4');
    expect(mensagem).toContain('Turbo');
  });

  it('torneio vazio é anunciado como vazio', async () => {
    impacto();
    await montar();
    await excluir('Turbo');
    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    expect(confirmar.mock.calls[0][0]).toContain('não tem nenhum dia');
  });

  it('torneio com movimento financeiro nem chega a perguntar', async () => {
    // O caso que o cliente NÃO testou: confirmar aqui apagaria a venda, o
    // dinheiro recebido e quem pagou, deixando o caixa da etapa impossível de
    // fechar. Nada de "tem certeza?" — a exclusão simplesmente não acontece.
    impacto({ blocked: true, entries: 77, entries_amount: 7700, paying_players: 60 });
    await montar();
    await excluir('Turbo');
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(confirmar).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
    const [mensagem] = toast.error.mock.calls[0];
    expect(mensagem).toContain('77');
    expect(mensagem).toContain('R$ 7700.00');
  });

  it('409 do servidor vira aviso com os números, e não erro genérico', async () => {
    // Entre medir o impacto e clicar, outro operador pode ter vendido. Quem
    // recusa de verdade é o servidor — a tela precisa saber traduzir isso.
    impacto();
    api.delete.mockRejectedValue({
      response: { status: 409, data: { detail: { message: 'recusado', impact: { entries: 5, entries_amount: 500, paying_players: 5 } } } },
      userMessage: 'recusado',
    });
    await montar();
    await excluir('Turbo');
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error.mock.calls[0][0]).toContain('5');
    expect(toast.error.mock.calls[0][0]).not.toBe('tournaments.deleteError');
  });

  it('sem o endpoint de impacto, cai na confirmação genérica', async () => {
    // O deploy não é atômico: frontend novo com backend antigo devolve 404 no
    // /delete-impact. A tela não pode travar — a guarda de verdade é do servidor.
    api.get.mockRejectedValue({ response: { status: 404 } });
    await montar();
    await excluir('Turbo');
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/tournaments/t2'));
    expect(confirmar.mock.calls[0][0]).toBe('tournaments.confirmDelete');
  });

  it('recusar não exclui', async () => {
    confirmar.mockResolvedValue(false);
    await montar();
    await excluir('Turbo');
    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('excluir invalida o cache', async () => {
    await montar();
    await excluir('Turbo');
    await waitFor(() => expect(invalidateCache).toHaveBeenCalledWith('/tournaments'));
  });

  it('erro ao excluir avisa', async () => {
    api.delete.mockRejectedValue(new Error('409'));
    await montar();
    await excluir('Turbo');
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('tournaments.deleteError'));
  });
});

describe('premiação por eliminação (KO)', () => {
  /** Parte do pool vira prêmio para quem elimina. O formato exige eliminar
   *  pelas mesas (é lá que o floor diz quem eliminou) e, por enquanto, só
   *  vale em torneio sem dias classificatórios. */
  const formatoKo = () => document.getElementById('tr-ko-format');
  const pctKo = () => document.getElementById('tr-ko-pct');
  const parteKo = () => document.getElementById('tr-ko-cash');

  it('PKO: troca para eliminação por mesa e manda formato, % do pool e % em dinheiro', async () => {
    await montar();
    await abrirNovo();
    await userEvent.type(campo(/tournaments.tournamentName/), 'START UP PKO');
    await userEvent.selectOptions(formatoKo(), 'pko');
    expect(screen.getByRole('radio', { name: /tournaments.eliminationModeTable/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /tournaments.eliminationModeBulk/ })).toBeDisabled();
    await userEvent.type(pctKo(), '40');
    expect(parteKo()).toHaveValue(50);
    await userEvent.click(screen.getByRole('button', { name: 'tournaments.createFirst' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/tournaments', {
        name: 'START UP PKO', has_qualifying: false, elimination_mode: 'table',
        ko_format: 'pko', ko_percentage: 40, ko_cash_share: 50,
      })
    );
  });

  it('no Mystery o campo se chama "% do buy-in para Mystery"', async () => {
    await montar();
    await abrirNovo();
    await userEvent.selectOptions(formatoKo(), 'ko');
    expect(screen.getByLabelText('% do buy-in para KO')).toBe(pctKo());
    await userEvent.selectOptions(formatoKo(), 'mystery');
    expect(screen.getByLabelText('% do buy-in para Mystery')).toBe(pctKo());
  });

  it('sem KO o campo de porcentagem nem aparece', async () => {
    await montar();
    await abrirNovo();
    expect(formatoKo()).toHaveValue('none');
    expect(pctKo()).toBeNull();
    expect(screen.getByText(/todo o pool vai para as posições/)).toBeInTheDocument();
  });

  it('ligar os classificatórios desliga o KO e explica por quê', async () => {
    await montar();
    await abrirNovo();
    await userEvent.selectOptions(formatoKo(), 'ko');
    await userEvent.click(screen.getByRole('switch'));
    expect(formatoKo()).toHaveValue('none');
    expect(formatoKo()).toBeDisabled();
    expect(screen.getByText(/só em torneio sem dias classificatórios/)).toBeInTheDocument();
  });

  // A lista de torneios (função do banco) NÃO traz o KO: a edição lê o
  // torneio completo. Os cartões abaixo vêm sem os campos, como em produção.
  const comTorneioCompleto = (torneio) =>
    api.get.mockImplementation((url) =>
      url === `/tournaments/${torneio.id}`
        ? Promise.resolve({ data: torneio })
        : Promise.reject(new Error('sem endpoint'))
    );

  it('a edição carrega o formato gravado e salva junto', async () => {
    const torneios = [{
      id: 't2', name: 'Mystery Night', status: 'PENDING', total_entries: 0, total_players: 0, total_reentries: 0,
      elimination_mode: 'table',
    }];
    comTorneioCompleto({ id: 't2', ko_format: 'mystery', ko_percentage: '25.00', ko_cash_share: '100' });
    await montar({ torneios });
    await userEvent.click(within(cartaoDe('Mystery Night')).getByRole('button', { name: /common.edit|Editar/ }));
    await waitFor(() => expect(formatoKo()).toHaveValue('mystery'));
    expect(formatoKo()).toBeEnabled();
    expect(pctKo()).toHaveValue(25);
    await userEvent.click(screen.getByRole('button', { name: 'tournaments.saveChanges' }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/tournaments/t2', expect.objectContaining({
        elimination_mode: 'table', ko_format: 'mystery', ko_percentage: 25, ko_cash_share: 100,
      }))
    );
  });

  it('sem conseguir ler o torneio completo, o KO fica travado e o salvar não mexe nele', async () => {
    // Era o caso do MISTERY: a lista não trazia o formato, o modal mostrava
    // "Nenhuma" e salvar mandaria "Nenhuma" por cima do Mystery.
    const torneios = [{
      id: 't2', name: 'MISTERY', status: 'active', total_entries: 9, total_players: 7, total_reentries: 1,
      elimination_mode: 'table',
    }];
    await montar({ torneios }); // api.get rejeita por padrão
    await userEvent.click(within(cartaoDe('MISTERY')).getByRole('button', { name: /common.edit|Editar/ }));
    expect(formatoKo()).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'tournaments.saveChanges' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(api.patch.mock.calls[0][1]).not.toHaveProperty('ko_format');
  });

  it('recusa do servidor (torneio já com vendas) aparece no modal', async () => {
    const torneios = [{
      id: 't2', name: 'PKO', status: 'active', total_entries: 5, total_players: 5, total_reentries: 0,
      elimination_mode: 'table',
    }];
    comTorneioCompleto({ id: 't2', ko_format: 'pko', ko_percentage: '40', ko_cash_share: '50' });
    api.patch.mockRejectedValue({ userMessage: 'O torneio já tem vendas: o formato e as porcentagens do KO não podem mais mudar.' });
    await montar({ torneios });
    await userEvent.click(within(cartaoDe('PKO')).getByRole('button', { name: /common.edit|Editar/ }));
    await waitFor(() => expect(pctKo()).not.toBeNull());
    await userEvent.clear(pctKo());
    await userEvent.type(pctKo(), '30');
    await userEvent.click(screen.getByRole('button', { name: 'tournaments.saveChanges' }));
    expect(await screen.findByText(/já tem vendas/)).toBeInTheDocument();
  });
});

describe('rótulo dos classificatórios', () => {
  it('1A, 1B… até 1Z; depois o número puro', () => {
    expect(rotuloDoClassificatorio(1)).toBe('1A');
    expect(rotuloDoClassificatorio(4)).toBe('1D');
    expect(rotuloDoClassificatorio(7)).toBe('1G');
    expect(rotuloDoClassificatorio(26)).toBe('1Z');
    expect(rotuloDoClassificatorio(27)).toBe('27');
  });
});

describe('Mystery: garantido e nível no cadastro', () => {
  it('com Mystery aparecem os campos e vão para a API', async () => {
    await montar();
    await abrirNovo();
    await userEvent.type(campo(/tournaments.tournamentName/), 'Mystery Night');
    await userEvent.selectOptions(document.getElementById('tr-ko-format'), 'mystery');
    await userEvent.type(document.getElementById('tr-ko-pct'), '30');
    await userEvent.type(document.getElementById('tr-ko-guarantee'), '10000');
    await userEvent.type(document.getElementById('tr-ko-level'), '13');
    await userEvent.click(screen.getByRole('button', { name: 'tournaments.createFirst' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/tournaments', expect.objectContaining({
        ko_format: 'mystery', ko_percentage: 30, mystery_guarantee: 10000, mystery_start_level: 13,
      }))
    );
  });

  it('em PKO os campos do Mystery não aparecem', async () => {
    await montar();
    await abrirNovo();
    await userEvent.selectOptions(document.getElementById('tr-ko-format'), 'pko');
    expect(document.getElementById('tr-ko-guarantee')).toBeNull();
    expect(document.getElementById('tr-ko-level')).toBeNull();
  });
});
