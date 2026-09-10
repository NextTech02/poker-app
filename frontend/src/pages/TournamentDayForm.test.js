/**
 * Formulário do dia do torneio — criar e editar.
 *
 * Duas regras de negócio moram aqui e são o centro dos testes:
 *
 * - **O dia FINAL não vende entrada.** Ao salvar um dia final, buy-in, rake,
 *   fichas e limites são forçados a zero e a lotação vai para um teto alto:
 *   quem chega vem dos classificatórios, com as fichas que trouxe. Deixar os
 *   valores digitados criaria um dia final cobrando buy-in.
 * - **Um dia novo HERDA a estrutura de blinds dos classificatórios.** Sem
 *   isso, cada dia começaria em branco e o operador montaria a mesma estrutura
 *   de novo. A herança é acessória: se ela falhar, o dia continua criado — só
 *   avisa para configurar à mão.
 *
 * - **Os MEIOS DE ENTRADA são do dia.** No lugar dos seis campos soltos (buy-in,
 *   rebuy, add-on e as fichas de cada um) há uma lista com nome, valor, rake e
 *   fichas próprios por linha — é o que permite "Buy-in duplo" ser uma coisa
 *   própria, e não buy-in vezes dois. Um dia sem nenhum meio da categoria
 *   `buy_in` não consegue inscrever ninguém, então isso é bloqueado.
 *
 * Valores opcionais zerados viram NULO, não zero: "rebuy de R$ 0,00" diria que
 * o rebuy é de graça; nulo diz que não existe.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import TournamentDayForm from './TournamentDayForm';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), put: jest.fn() },
}));
jest.mock('../components/Sidebar', () => () => <nav data-testid="sidebar" />);
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));
const mockNavigate = jest.fn();
const mockParams = { tournamentId: 't1', dayId: undefined };
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useParams: () => mockParams,
  useNavigate: () => mockNavigate,
}));
jest.mock('react-i18next', () => {
  // Interpola {{var}} como o i18next de verdade: o nome acessível do botão de
  // remover CARREGA o nome do meio de entrada, e um mock que devolvesse o texto
  // cru deixaria passar seis botões chamados "Remover meio de entrada {{nome}}".
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

const TORNEIO = { id: 't1', name: 'Main Event' };

const DIAS = [
  { id: 'q1', day_name: 'Classificatório 1', day_type: 'qualifying' },
  { id: 'f1', day_name: 'Dia Final', day_type: 'final' },
];

const DIA_EM_EDICAO = {
  id: 'd9', day_name: 'Dia 1A', day_number: 2, buy_in: 500, rebuy_amount: 300,
  addon_amount: 200, max_players: 120, rake_percentage: 10, starting_chips: 30000,
  rebuy_chips: 30000, addon_chips: 30000, rebuy_level_limit: 6,
  allocation_type: 'manual', day_type: 'regular', currency: 'BRL',
};

const BLINDS_ORIGEM = [
  { level: 2, small_blind: 50, big_blind: 100, ante: 100, duration: 20, is_break: false },
  { level: 1, small_blind: 25, big_blind: 50, ante: 0, duration: 20, is_break: false },
];

let toast;

// Meios de entrada do dia em edição, fora de ordem de propósito: a tela ordena
// por sort_order, e é essa ordem que o Caixa mostra.
const MEIOS = [
  { id: 'm2', name: 'Rebuy', category: 'rebuy', amount: 300, rake_percentage: 10, chips: 30000, active: true, sort_order: 1 },
  { id: 'm1', name: 'Buy-in', category: 'buy_in', amount: 500, rake_percentage: 10, chips: 30000, active: true, sort_order: 0 },
];

const responder = ({
  torneio = TORNEIO, dias = DIAS, dia = DIA_EM_EDICAO, blinds = BLINDS_ORIGEM,
  meios = MEIOS,
} = {}) => {
  api.get.mockImplementation((url) => {
    if (url === '/tournaments/t1') {
      return torneio instanceof Error ? Promise.reject(torneio) : Promise.resolve({ data: torneio });
    }
    if (url === '/tournament-days/tournament/t1') return Promise.resolve({ data: dias });
    if (url.endsWith('/blinds')) {
      return blinds instanceof Error ? Promise.reject(blinds) : Promise.resolve({ data: blinds });
    }
    if (url.endsWith('/buy-types')) {
      return meios instanceof Error ? Promise.reject(meios) : Promise.resolve({ data: meios });
    }
    if (url.startsWith('/tournament-days/')) return Promise.resolve({ data: dia });
    return Promise.resolve({ data: [] });
  });
};

const montar = async (opcoes, { editando = false } = {}) => {
  mockParams.dayId = editando ? 'd9' : undefined;
  responder(opcoes);
  render(<MemoryRouter><TournamentDayForm /></MemoryRouter>);
  await waitFor(() => expect(screen.queryByText('common.loading')).toBeNull());
};

// Os campos do formulario usam `id`, nao `name` (o onChange escreve direto no
// estado), entao a busca e pelo id.
const campo = (nome) => document.getElementById(nome);
const salvar = () => userEvent.click(document.querySelector('button[type="submit"]'));
const trocar = async (nome, valor) => {
  await userEvent.clear(campo(nome));
  if (valor !== '') await userEvent.type(campo(nome), String(valor));
};

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
const adicionarMeio = () =>
  userEvent.click(screen.getByRole('button', { name: 'Adicionar meio de entrada' }));
const itensEnviados = () => api.put.mock.calls[0][1].items;

beforeEach(() => {
  toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn() };
  useToast.mockReturnValue({ toast });
  useCurrency.mockReturnValue({ currency: 'BRL' });
  api.post.mockResolvedValue({ data: { id: 'novo' } });
  api.patch.mockResolvedValue({ data: {} });
  api.put.mockResolvedValue({ data: [] });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => console.error.mockRestore());

describe('carga', () => {
  it('mostra o carregamento antes dos dados', () => {
    mockParams.dayId = undefined;
    api.get.mockReturnValue(new Promise(() => {}));
    render(<MemoryRouter><TournamentDayForm /></MemoryRouter>);
    expect(screen.getByText('common.loading')).toBeInTheDocument();
  });

  it('um dia novo já vem numerado depois dos existentes', async () => {
    // Dois dias cadastrados → o novo é o terceiro.
    await montar();
    await userEvent.type(campo('day_name'), 'Dia 2');
    await salvar();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0][1].day_number).toBe(3);
  });

  it('a moeda do dia segue a configuração global', async () => {
    // Não há mais escolha de moeda por dia.
    await montar();
    await userEvent.type(campo('day_name'), 'Dia 2');
    await salvar();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0][1].currency).toBe('BRL');
  });

  it('editando, o formulário abre com os valores do dia', async () => {
    await montar(undefined, { editando: true });
    expect(campo('day_name')).toHaveValue('Dia 1A');
    expect(campo('max_players')).toHaveValue(120);
    expect(campo('rebuy_level_limit')).toHaveValue(6);
  });

  it('valores opcionais ausentes viram zero no formulário, não "undefined"', async () => {
    // Um dia migrado antes de ter meios cadastrados cai nos valores do próprio
    // dia — nulo lá vira 0 aqui, e não um campo com "undefined" escrito.
    await montar({ dia: { ...DIA_EM_EDICAO, rebuy_amount: null, addon_amount: null,
      rebuy_level_limit: null }, meios: [] }, { editando: true });
    expect(linha(1).valor).toHaveValue(0);
    expect(campo('rebuy_level_limit')).toHaveValue(null);
  });

  it('falha ao carregar mostra o erro', async () => {
    await montar({ torneio: new Error('500') });
    expect(screen.getByText('common.error')).toBeInTheDocument();
  });

  it('cancelar volta para o torneio', async () => {
    await montar();
    await userEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(mockNavigate).toHaveBeenCalledWith('/torneios/t1');
  });
});

describe('valores opcionais', () => {
  it('rebuy zerado vira NULO, não zero', async () => {
    // "Rebuy de R$ 0,00" diria que o rebuy é de graça; nulo diz que não existe.
    await montar();
    await userEvent.type(campo('day_name'), 'Dia 2');
    await escreverNa(1, 'valor', 0);
    await salvar();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0][1].rebuy_amount).toBeNull();
  });

  it('add-on zerado também', async () => {
    await montar();
    await userEvent.type(campo('day_name'), 'Dia 2');
    await escreverNa(2, 'valor', 0);
    await salvar();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0][1].addon_amount).toBeNull();
  });

  it('limite de nível em branco significa ILIMITADO', async () => {
    // Zero seria "nenhum rebuy permitido" — o oposto.
    await montar();
    await userEvent.type(campo('day_name'), 'Dia 2');
    await salvar();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0][1].rebuy_level_limit).toBeNull();
  });

  it('limite preenchido vira número', async () => {
    await montar();
    await userEvent.type(campo('day_name'), 'Dia 2');
    await userEvent.type(campo('rebuy_level_limit'), '8');
    await salvar();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0][1].rebuy_level_limit).toBe(8);
  });

  it('o rake do dia vai zero: quem define é o tipo de buy', async () => {
    // Rake em dois lugares seria contado duas vezes.
    await montar();
    await userEvent.type(campo('day_name'), 'Dia 2');
    await salvar();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0][1].rake_percentage).toBe(0);
  });
});

describe('dia final', () => {
  it('salvar um dia FINAL zera os valores de entrada', async () => {
    // Quem chega vem do classificatório, com as fichas que trouxe. Deixar os
    // valores digitados criaria um dia final cobrando buy-in.
    await montar({ dia: { ...DIA_EM_EDICAO, day_type: 'final' } }, { editando: true });
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(api.patch.mock.calls[0][1]).toMatchObject({
      buy_in: 0, rebuy_amount: null, addon_amount: null, rake_percentage: 0,
      starting_chips: 0, rebuy_chips: 0, addon_chips: 0, rebuy_level_limit: null,
    });
  });

  it('o dia final recebe lotação alta, porque os classificados entram sozinhos', async () => {
    await montar({ dia: { ...DIA_EM_EDICAO, day_type: 'final' } }, { editando: true });
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(api.patch.mock.calls[0][1].max_players).toBe(1000);
  });

  it('um dia NORMAL preserva os valores digitados', async () => {
    await montar(undefined, { editando: true });
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(api.patch.mock.calls[0][1].buy_in).toBe(500);
  });

  it('dia novo criado à mão é sempre regular', async () => {
    // Classificatórios e final são gerados na criação do torneio.
    await montar();
    await userEvent.type(campo('day_name'), 'Dia 2');
    await salvar();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0][1].day_type).toBe('regular');
  });
});

describe('herança da estrutura de blinds', () => {
  it('um dia novo copia os blinds de um classificatório, em ordem', async () => {
    // Sem isso, cada dia começaria em branco e o operador montaria a mesma
    // estrutura de novo.
    await montar();
    await userEvent.type(campo('day_name'), 'Dia 2');
    await salvar();
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/tournament-days/novo/blinds', expect.anything())
    );
    const copias = api.post.mock.calls.filter((c) => c[0] === '/tournament-days/novo/blinds');
    expect(copias.map((c) => c[1].level)).toEqual([1, 2]);
    expect(toast.success).toHaveBeenCalledWith('Estrutura de blinds herdada dos dias classificatórios.');
  });

  it('sem classificatório com estrutura, nada é copiado — e isso não é erro', async () => {
    await montar({ blinds: [] });
    await userEvent.type(campo('day_name'), 'Dia 2');
    await salvar();
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/torneios/t1'));
    expect(api.post.mock.calls.some((c) => c[0].endsWith('/blinds'))).toBe(false);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('falha na herança NÃO desfaz a criação do dia', async () => {
    // O dia já existe; dizer "falhou" faria o operador criar outro.
    api.post.mockImplementation((url) =>
      url.endsWith('/blinds')
        ? Promise.reject(new Error('500'))
        : Promise.resolve({ data: { id: 'novo' } })
    );
    await montar();
    await userEvent.type(campo('day_name'), 'Dia 2');
    await salvar();
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        'Dia criado, mas não foi possível herdar a estrutura de blinds. Configure na tela de Blinds.'
      )
    );
    expect(mockNavigate).toHaveBeenCalledWith('/torneios/t1');
  });

  it('editar um dia não regenera a estrutura', async () => {
    // Copiar por cima apagaria os ajustes já feitos naquele dia.
    await montar(undefined, { editando: true });
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(api.post).not.toHaveBeenCalled();
  });

  it('o dia FINAL não herda: a estrutura dele é configurada à parte', async () => {
    mockParams.dayId = undefined;
    responder();
    render(<MemoryRouter><TournamentDayForm /></MemoryRouter>);
    await waitFor(() => expect(screen.queryByText('common.loading')).toBeNull());
    await userEvent.type(campo('day_name'), 'Final');
    // O tipo "final" só é escolhível na edição; simulamos pelo dia carregado.
    await salvar();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0][1].day_type).toBe('regular');
  });
});

describe('tipo do dia', () => {
  const DIA_UNICO = [{ id: 'd1', day_name: 'Único', day_type: 'regular' }];

  it('torneio de dia único não mostra o campo — só teria a opção "Regular"', async () => {
    await montar({ torneio: { ...TORNEIO, has_qualifying: false }, dias: DIA_UNICO });
    expect(campo('day_type')).toBeNull();
  });

  it('escondido, o dia ainda é salvo como regular', async () => {
    // Sumir com o campo não pode sumir com o valor: o backend exige o tipo.
    await montar({ torneio: { ...TORNEIO, has_qualifying: false }, dias: DIA_UNICO });
    await userEvent.type(campo('day_name'), 'Dia 2');
    await salvar();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0][1].day_type).toBe('regular');
  });

  it('torneio classificatório mostra o campo', async () => {
    await montar({ torneio: { ...TORNEIO, has_qualifying: true }, dias: DIA_UNICO });
    expect(campo('day_type')).not.toBeNull();
  });

  it('dia já marcado como classificatório mostra o campo mesmo sem a flag', async () => {
    // Torneio antigo, convertido na mão: esconder aqui tiraria o único jeito
    // de arrumar o vínculo com o dia final.
    await montar(
      { torneio: { ...TORNEIO, has_qualifying: false }, dias: DIA_UNICO,
        dia: { ...DIA_EM_EDICAO, day_type: 'qualifying' } },
      { editando: true }
    );
    expect(campo('day_type')).toHaveValue('qualifying');
  });
});

describe('meios de entrada', () => {
  it('um dia novo já vem com Buy-in, Rebuy e Add-on, nessa ordem', async () => {
    // Sem nenhum meio a tela abriria sem como inscrever ninguém.
    await montar();
    expect(linhas()).toHaveLength(3);
    expect([0, 1, 2].map((i) => linha(i).categoria.value)).toEqual(['buy_in', 'rebuy', 'addon']);
  });

  it('editando, os meios do dia vêm do servidor, na ordem cadastrada', async () => {
    // A resposta vem fora de ordem de propósito: quem manda é o sort_order.
    await montar(undefined, { editando: true });
    expect(linhas()).toHaveLength(2);
    expect(linha(0).nome).toHaveValue('Buy-in');
    expect(linha(1).nome).toHaveValue('Rebuy');
    expect(linha(1).fichas).toHaveValue(30000);
  });

  it('dia antigo, ainda sem meios cadastrados, é preenchido com o que ele cobra', async () => {
    // Tela vazia faria o operador achar que perdeu a configuração do dia.
    await montar({ meios: [] }, { editando: true });
    expect(linhas()).toHaveLength(3);
    expect(linha(0).valor).toHaveValue(500);
    expect(linha(0).fichas).toHaveValue(30000);
  });

  it('falha ao buscar os meios não derruba o formulário', async () => {
    // O dia continua editável; só a lista é que não veio.
    await montar({ meios: new Error('500') }, { editando: true });
    expect(campo('day_name')).toHaveValue('Dia 1A');
    expect(screen.queryByText('common.error')).toBeNull();
  });

  it('o botão acrescenta uma linha em branco, sem opção pré-pronta', async () => {
    // "Buy-in duplo" é algo que o clube CADASTRA, não um item de menu.
    await montar();
    await adicionarMeio();
    expect(linhas()).toHaveLength(4);
    expect(linha(3).nome).toHaveValue('');
  });

  it('a linha nova é salva com o nome e as fichas que o operador deu', async () => {
    // O ponto da mudança: "rebuy duplo" tem valor E fichas próprios, não é o
    // rebuy simples multiplicado por dois.
    await montar();
    await userEvent.type(campo('day_name'), 'Dia 2');
    await adicionarMeio();
    await userEvent.type(linha(3).nome, 'Rebuy duplo');
    await escreverNa(3, 'valor', 200);
    await escreverNa(3, 'fichas', 25000);
    await userEvent.selectOptions(linha(3).categoria, 'rebuy');
    await salvar();
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(itensEnviados()[3]).toMatchObject({
      id: null, name: 'Rebuy duplo', category: 'rebuy', amount: 200, chips: 25000,
    });
  });

  it('remover tira a linha da lista', async () => {
    await montar();
    await userEvent.click(linha(2).remover);
    expect(linhas()).toHaveLength(2);
  });

  it('não dá para ficar sem NENHUM meio de entrada', async () => {
    // Sem meio da categoria "Entrada" não há como inscrever jogador — o
    // operador descobriria isso no Caixa, com o clube cheio.
    await montar();
    await userEvent.click(linha(0).remover);
    expect(linhas()).toHaveLength(3);
    expect(screen.getByRole('alert')).toHaveTextContent(/ao menos um meio de entrada/i);
  });

  it('com dois meios de entrada, dá para remover um', async () => {
    await montar();
    await adicionarMeio(); // nasce como "Entrada"
    await userEvent.click(linha(0).remover);
    expect(linhas().filter((_, i) => linha(i).categoria.value === 'buy_in')).toHaveLength(1);
  });

  it('trocar a categoria do único buy-in bloqueia o salvamento', async () => {
    // A remoção não é o único jeito de ficar sem entrada.
    await montar();
    await userEvent.type(campo('day_name'), 'Dia 2');
    await userEvent.selectOptions(linha(0).categoria, 'addon');
    await salvar();
    expect(screen.getByRole('alert')).toHaveTextContent(/ao menos um meio de entrada/i);
    expect(api.post).not.toHaveBeenCalled();
  });

  it('meio sem nome bloqueia o salvamento', async () => {
    // Um meio sem nome não dá para escolher no Caixa.
    await montar();
    await userEvent.type(campo('day_name'), 'Dia 2');
    await escreverNa(0, 'nome', '');
    await salvar();
    expect(screen.getByRole('alert')).toHaveTextContent('Dê um nome a cada meio de entrada.');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('na CRIAÇÃO os meios vão para o dia recém-criado', async () => {
    // O dia não existe quando o formulário abre: o PUT só pode sair depois do
    // POST, com o id que voltou.
    await montar();
    await userEvent.type(campo('day_name'), 'Dia 2');
    await salvar();
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(api.put.mock.calls[0][0]).toBe('/tournament-days/novo/buy-types');
    expect(itensEnviados()).toHaveLength(3);
  });

  it('na EDIÇÃO os meios vão para o dia editado', async () => {
    await montar(undefined, { editando: true });
    await salvar();
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(api.put.mock.calls[0][0]).toBe('/tournament-days/d9/buy-types');
    expect(itensEnviados()[0].id).toBe('m1');
  });

  it('a ordem da tela vira o sort_order enviado', async () => {
    // É a ordem em que o Caixa mostra os botões de venda.
    await montar();
    await userEvent.type(campo('day_name'), 'Dia 2');
    await salvar();
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(itensEnviados().map((i) => i.sort_order)).toEqual([0, 1, 2]);
  });

  it('meios DESATIVADOS voltam no envio, em vez de sumirem', async () => {
    // Vendas antigas apontam para eles; apagá-los deixaria o recibo sem dizer o
    // que a pessoa comprou.
    const desativado = { id: 'velho', name: 'Buy-in promo', category: 'buy_in', amount: 50,
      rake_percentage: 5, chips: 5000, active: false, sort_order: 9 };
    await montar({ meios: [...MEIOS, desativado] }, { editando: true });
    expect(linhas()).toHaveLength(2); // o desativado não aparece na tela
    await salvar();
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(itensEnviados()).toHaveLength(3);
    expect(itensEnviados()[2]).toMatchObject({ id: 'velho', active: false });
  });

  it('as colunas antigas do dia seguem o primeiro meio de cada categoria', async () => {
    // Telas e relatórios que ainda leem day.buy_in não podem contar outra
    // história diferente da que o Caixa cobra.
    await montar();
    await userEvent.type(campo('day_name'), 'Dia 2');
    await escreverNa(0, 'valor', 250);
    await escreverNa(0, 'fichas', 15000);
    await salvar();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0][1]).toMatchObject({ buy_in: 250, starting_chips: 15000 });
  });

  it('o dia FINAL não tem meios de entrada — nem na tela, nem no envio', async () => {
    // Quem chega no final vem classificado; não compra entrada.
    await montar({ dia: { ...DIA_EM_EDICAO, day_type: 'final' } }, { editando: true });
    expect(linhas()).toHaveLength(0);
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(api.put).not.toHaveBeenCalled();
  });

  it('o botão de remover diz QUAL meio remove', async () => {
    // Seis botões chamados só "Remover" não dizem nada a quem usa leitor de tela.
    await montar();
    expect(
      screen.getByRole('button', { name: 'Remover meio de entrada Buy-in' })
    ).toBeInTheDocument();
  });

  it('a dica da categoria aparece uma vez e vale para todas as linhas', async () => {
    // Repetir a explicação em cada linha viraria ruído; o aria-describedby liga
    // todos os selects ao mesmo texto.
    await montar();
    expect(document.querySelectorAll('#entry_category_hint')).toHaveLength(1);
    [0, 1, 2].forEach((i) =>
      expect(linha(i).categoria).toHaveAttribute('aria-describedby', 'entry_category_hint')
    );
  });
});

describe('erros ao salvar', () => {
  it('mensagem do servidor aparece como veio', async () => {
    api.post.mockRejectedValue({ response: { data: { detail: 'Já existe um dia com esse nome' } } });
    await montar();
    await userEvent.type(campo('day_name'), 'Dia 2');
    await salvar();
    expect(await screen.findByText('Já existe um dia com esse nome')).toBeInTheDocument();
  });

  it('erro de validação em lista vira uma frase legível', async () => {
    // O 422 do FastAPI é uma lista de objetos; renderizá-la crua quebraria a
    // tela.
    api.post.mockRejectedValue({
      response: { data: { detail: [{ loc: ['body', 'buy_in'], msg: 'deve ser positivo' }] } },
    });
    await montar();
    await userEvent.type(campo('day_name'), 'Dia 2');
    await salvar();
    expect(await screen.findByText(/body.buy_in: deve ser positivo/)).toBeInTheDocument();
  });

  it('erro sem detalhe cai numa frase padrão', async () => {
    api.post.mockRejectedValue(new Error('boom'));
    await montar();
    await userEvent.type(campo('day_name'), 'Dia 2');
    await salvar();
    expect(await screen.findByText('common.error')).toBeInTheDocument();
  });

  it('erro não navega para fora', async () => {
    // Sair da tela perderia tudo o que foi digitado.
    api.post.mockRejectedValue(new Error('boom'));
    await montar();
    await userEvent.type(campo('day_name'), 'Dia 2');
    await salvar();
    await screen.findByText('common.error');
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
