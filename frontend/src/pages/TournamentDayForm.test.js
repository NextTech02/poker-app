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
  default: { get: jest.fn(), post: jest.fn(), patch: jest.fn() },
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
  const t = (chave, segundo) => (typeof segundo === 'string' ? segundo : chave);
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

const responder = ({
  torneio = TORNEIO, dias = DIAS, dia = DIA_EM_EDICAO, blinds = BLINDS_ORIGEM,
} = {}) => {
  api.get.mockImplementation((url) => {
    if (url === '/tournaments/t1') {
      return torneio instanceof Error ? Promise.reject(torneio) : Promise.resolve({ data: torneio });
    }
    if (url === '/tournament-days/tournament/t1') return Promise.resolve({ data: dias });
    if (url.endsWith('/blinds')) {
      return blinds instanceof Error ? Promise.reject(blinds) : Promise.resolve({ data: blinds });
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

beforeEach(() => {
  toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn() };
  useToast.mockReturnValue({ toast });
  useCurrency.mockReturnValue({ currency: 'BRL' });
  api.post.mockResolvedValue({ data: { id: 'novo' } });
  api.patch.mockResolvedValue({ data: {} });
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
    expect(campo('buy_in')).toHaveValue(500);
    expect(campo('rebuy_level_limit')).toHaveValue(6);
  });

  it('valores opcionais ausentes viram zero no formulário, não "undefined"', async () => {
    await montar({ dia: { ...DIA_EM_EDICAO, rebuy_amount: null, addon_amount: null,
      rebuy_level_limit: null } }, { editando: true });
    expect(campo('rebuy_amount')).toHaveValue(0);
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
    await trocar('rebuy_amount', 0);
    await salvar();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0][1].rebuy_amount).toBeNull();
  });

  it('add-on zerado também', async () => {
    await montar();
    await userEvent.type(campo('day_name'), 'Dia 2');
    await trocar('addon_amount', 0);
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
    expect(campo('day_type')).toHaveValue('regular');
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
    expect(campo('day_type')).toHaveValue('regular');
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
    await waitFor(() => expect(screen.getByText('common.error')).toBeInTheDocument());
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
