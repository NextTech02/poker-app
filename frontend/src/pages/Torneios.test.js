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
 * Falhas parciais dessa geração NÃO podem virar erro de criação: o torneio já
 * existe, e dizer "falhou" faria o operador criar tudo de novo.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Torneios from './Torneios';
import api from '../config/api';
import { cachedGet, invalidateCache } from '../utils/apiCache';
import { getSelectedStage } from '../utils/stageUtils';
import { useToast } from '../contexts/ToastContext';
import { useStage } from '../contexts/StageContext';
import { useCurrency } from '../contexts/CurrencyContext';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
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

const PATROCINADORES = [{ id: 'sp1', name: 'Cerveja X' }];
const MODELOS = [{ id: 'bt1', name: 'Turbo 15min' }];

const ETAPA = { id: 'e1', name: 'Etapa 1' };

let toast;
let confirmar;

const responder = ({ torneios = TORNEIOS, patrocinadores = PATROCINADORES, modelos = MODELOS } = {}) => {
  cachedGet.mockImplementation((_api, url) => {
    if (url === '/tournaments') {
      return torneios instanceof Error ? Promise.reject(torneios) : Promise.resolve(torneios);
    }
    if (url.startsWith('/sponsors')) return Promise.resolve(patrocinadores);
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
        name: 'Novo', has_qualifying: false, sponsor_id: null,
      })
    );
  });
});

describe('criar torneio simples', () => {
  const criar = async (nome = 'Novo') => {
    await abrirNovo();
    await userEvent.type(campo(/tournaments.tournamentName/), nome);
    await userEvent.click(screen.getByRole('button', { name: 'tournaments.createFirst' }));
  };

  it('o patrocinador escolhido acompanha o torneio', async () => {
    await montar();
    await abrirNovo();
    await userEvent.type(campo(/tournaments.tournamentName/), 'Novo');
    await userEvent.selectOptions(campo('tournaments.sponsor'), 'sp1');
    await userEvent.click(screen.getByRole('button', { name: 'tournaments.createFirst' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/tournaments', expect.objectContaining({ sponsor_id: 'sp1' }))
    );
  });

  it('sem patrocinador o campo vai nulo, não string vazia', async () => {
    await montar();
    await criar();
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/tournaments', expect.objectContaining({ sponsor_id: null }))
    );
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

  it('o buy-in informado vale para todos os classificatórios', async () => {
    await montar();
    await criarComQuali(async () => {
      await userEvent.type(screen.getByLabelText(/Buy-in por dia classificatório/), '250');
    });
    await waitFor(() => {
      const q = api.post.mock.calls.filter((c) => c[0] === '/tournament-days' && c[1].day_type === 'qualifying');
      q.forEach((c) => expect(c[1].buy_in).toBe(250));
    });
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

  it('salvar envia PATCH e invalida o cache', async () => {
    await montar();
    await editar('Main Event');
    const nome = campo(/tournaments.tournamentName/);
    await userEvent.clear(nome);
    await userEvent.type(nome, 'Main Event 2026');
    await userEvent.click(screen.getByRole('button', { name: 'tournaments.saveChanges' }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/tournaments/t1', {
        name: 'Main Event 2026', has_qualifying: true, sponsor_id: null,
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
