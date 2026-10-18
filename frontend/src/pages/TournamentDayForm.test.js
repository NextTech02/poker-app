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
 * - **Os MEIOS DE ENTRADA são do TORNEIO.** No lugar dos seis campos soltos
 *   (buy-in, rebuy, add-on e as fichas de cada um) o dia mostra, só para
 *   leitura, a lista do torneio — ela vale para todos os dias e se edita no
 *   torneio. As colunas antigas do dia (buy_in, fichas...) seguem o primeiro
 *   meio de cada categoria, para telas e relatórios não contarem outra história.
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

// Meios de entrada do TORNEIO, fora de ordem de propósito: a tela ordena por
// sort_order, e é essa ordem que o Caixa mostra. O desativado não aparece.
const MEIOS = [
  { id: 'm2', name: 'Rebuy', category: 'rebuy', amount: 300, rake_percentage: 10, chips: 30000, active: true, sort_order: 1 },
  { id: 'm1', name: 'Buy-in', category: 'buy_in', amount: 500, rake_percentage: 10, chips: 30000, active: true, sort_order: 0 },
  { id: 'velho', name: 'Promo', category: 'buy_in', amount: 50, rake_percentage: 5, chips: 5000, active: false, sort_order: 9 },
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

// ── Meios de entrada (só leitura) ───────────────────────────────────────────
const linhasDaTabela = () =>
  Array.from(document.querySelectorAll('.entry-methods-table tbody tr')).map((tr) =>
    Array.from(tr.querySelectorAll('td')).map((td) => td.textContent)
  );

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

  it('torneio sem meios de entrada mantém as colunas do dia, com nulo onde não há valor', async () => {
    // Nada para copiar do torneio: o dia fica como estava. Rebuy/add-on nulos
    // continuam nulos (zero diria "de graça").
    await montar({ dia: { ...DIA_EM_EDICAO, rebuy_amount: null, addon_amount: null,
      rebuy_level_limit: null }, meios: [] }, { editando: true });
    expect(campo('rebuy_level_limit')).toHaveValue(null);
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(api.patch.mock.calls[0][1]).toMatchObject({
      buy_in: 500, starting_chips: 30000, rebuy_amount: null, addon_amount: null,
    });
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
  it('rebuy zerado no torneio vira NULO no dia, não zero', async () => {
    // "Rebuy de R$ 0,00" diria que o rebuy é de graça; nulo diz que não existe.
    await montar({ meios: [...MEIOS, { id: 'm3', name: 'Rebuy cortesia', category: 'rebuy',
      amount: 0, rake_percentage: 0, chips: 5000, active: true, sort_order: 0 }] });
    await userEvent.type(campo('day_name'), 'Dia 2');
    await salvar();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0][1].rebuy_amount).toBeNull();
    expect(api.post.mock.calls[0][1].rebuy_chips).toBe(5000);
  });

  it('sem add-on na lista do torneio, o dia fica sem add-on', async () => {
    await montar();
    await userEvent.type(campo('day_name'), 'Dia 2');
    await salvar();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0][1].addon_amount).toBeNull();
    expect(api.post.mock.calls[0][1].addon_chips).toBe(0);
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

describe('meios de entrada do torneio (somente leitura)', () => {
  it('mostra a lista do torneio, na ordem cadastrada, sem o desativado', async () => {
    // A resposta vem fora de ordem de propósito: quem manda é o sort_order.
    await montar();
    expect(linhasDaTabela().map((l) => l[0])).toEqual(['Buy-in', 'Rebuy']);
    // O separador de milhar segue o locale do ambiente (30.000 ou 30,000).
    expect(linhasDaTabela()[0].slice(0, 4)).toEqual(['Buy-in', 'Entrada', 'R$ 500.00', '10%']);
    expect(linhasDaTabela()[0][4]).toMatch(/^30[.,]000$/);
  });

  it('a lista vem do TORNEIO, não do dia — também na criação', async () => {
    // Antes o dia nascia com três linhas suas; agora ele só herda a lista.
    await montar();
    expect(api.get).toHaveBeenCalledWith('/tournaments/t1/buy-types');
    expect(document.querySelectorAll('.entry-method-row')).toHaveLength(0);
  });

  it('não há como editar aqui: o botão leva ao torneio', async () => {
    await montar();
    expect(screen.queryByRole('button', { name: /Adicionar entrada/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Editar no torneio' }));
    expect(mockNavigate).toHaveBeenCalledWith('/torneios/t1');
  });

  it('torneio sem meios cadastrados avisa, em vez de mostrar tabela vazia', async () => {
    await montar({ meios: [] });
    expect(screen.getByText('Este torneio ainda não tem meios de entrada cadastrados.')).toBeInTheDocument();
    expect(document.querySelector('.entry-methods-table')).toBeNull();
  });

  it('as colunas antigas do dia seguem o primeiro meio de cada categoria do torneio', async () => {
    // Telas e relatórios que ainda leem day.buy_in não podem contar outra
    // história diferente da que o Caixa cobra.
    await montar();
    await userEvent.type(campo('day_name'), 'Dia 2');
    await salvar();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0][1]).toMatchObject({
      buy_in: 500, starting_chips: 30000, rebuy_amount: 300, rebuy_chips: 30000,
    });
  });

  it('nenhum PUT de meios de entrada sai daqui', async () => {
    // Quem grava a lista é a tela do torneio; gravar por dia a fragmentaria.
    await montar();
    await userEvent.type(campo('day_name'), 'Dia 2');
    await salvar();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.put).not.toHaveBeenCalled();
  });

  it('na edição também não há PUT', async () => {
    await montar(undefined, { editando: true });
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(api.put).not.toHaveBeenCalled();
  });

  it('falha ao buscar os meios não derruba o formulário', async () => {
    // O dia continua editável; só a lista é que não veio, e as colunas ficam
    // com o que o dia já tinha.
    await montar({ meios: new Error('500') }, { editando: true });
    expect(campo('day_name')).toHaveValue('Dia 1A');
    expect(screen.queryByText('common.error')).toBeNull();
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(api.patch.mock.calls[0][1].buy_in).toBe(500);
  });

  it('o dia FINAL não mostra a lista: quem chega lá vem classificado', async () => {
    await montar({ dia: { ...DIA_EM_EDICAO, day_type: 'final' } }, { editando: true });
    expect(screen.queryByText('Meios de entrada do torneio')).toBeNull();
    expect(document.querySelector('.entry-methods-table')).toBeNull();
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

describe('dia extra num torneio com classificatórios', () => {
  // NSOP (18/10): o "Día 1A ONLINE", acrescentado ao Main em andamento, nascia
  // "regular" — fora da estrutura e sem o botão de fichas dos classificados.
  it('nasce classificatório e já ligado ao dia final', async () => {
    await montar({ torneio: { ...TORNEIO, has_qualifying: true } });
    expect(campo('day_type')).toHaveValue('qualifying');
    expect(campo('qualifies_to_day_id')).toHaveValue('f1');
    await userEvent.type(campo('day_name'), 'Día 1A ONLINE');
    await salvar();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0][1]).toMatchObject({ day_type: 'qualifying', qualifies_to_day_id: 'f1' });
  });

  it('dá para escolher "regular" de novo, e voltar a classificatório religa a final', async () => {
    await montar({ torneio: { ...TORNEIO, has_qualifying: true } });
    await userEvent.selectOptions(campo('day_type'), 'regular');
    expect(campo('qualifies_to_day_id')).toBeNull();
    await userEvent.selectOptions(campo('day_type'), 'qualifying');
    expect(campo('qualifies_to_day_id')).toHaveValue('f1');
  });

  it('torneio sem dia final continua criando dia regular', async () => {
    await montar({ torneio: { ...TORNEIO, has_qualifying: true }, dias: [{ id: 'd1', day_name: 'Único', day_type: 'regular' }] });
    expect(campo('day_type')).toHaveValue('regular');
  });
});
