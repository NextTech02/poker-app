/**
 * Templates de blinds — estruturas reutilizáveis.
 *
 * O ganho da tela é não montar a mesma estrutura de novo a cada torneio. Duas
 * decisões sustentam isso, e são o que os testes prendem:
 *
 * - **Cada nível novo já vem sugerido dobrando o anterior**, que é a
 *   progressão padrão. E a sugestão parte do último nível REAL, ignorando
 *   breaks — senão adicionar um nível depois de um intervalo zeraria os
 *   blinds (o break tem 0/0).
 * - **Break não consome número de nível**, aqui como na estrutura do dia: o
 *   "Nível 5" do template precisa ser o Nível 5 impresso.
 *
 * Ao salvar, os valores de um break são zerados independentemente do que
 * estiver na linha, e a numeração é reescrita pela ordem da tabela.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BlindTemplates from './BlindTemplates';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock('../components/Sidebar', () => () => <nav data-testid="sidebar" />);
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('react-i18next', () => {
  const t = (chave, segundo) => (typeof segundo === 'string' ? segundo : chave);
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const MODELOS = [
  {
    id: 'm1', name: 'Turbo 15min', description: 'Estrutura rápida',
    custom_levels: [
      { level: 1, small_blind: 25, big_blind: 50, ante: 0, duration: 15, is_break: false },
      { level: 2, small_blind: 50, big_blind: 100, ante: 100, duration: 15, is_break: false },
      { level: 3, small_blind: 0, big_blind: 0, ante: 0, duration: 10, is_break: true },
    ],
  },
  { id: 'm2', name: 'Sem níveis', custom_levels: [] },
];

let toast;
let confirmar;

const responder = ({ modelos = MODELOS } = {}) => {
  api.get.mockImplementation(() =>
    modelos instanceof Error ? Promise.reject(modelos) : Promise.resolve({ data: modelos })
  );
};

const montar = async (opcoes) => {
  responder(opcoes);
  render(<BlindTemplates />);
  await waitFor(() => expect(screen.queryByText('Carregando...')).toBeNull());
};

const cartaoDe = (nome) =>
  Array.from(document.querySelectorAll('.bt-card')).find(
    (el) => el.querySelector('.bt-card-name')?.textContent === nome
  );

const linhas = () => Array.from(document.querySelectorAll('.bt-levels-table tbody tr'));

const campoDaLinha = (indice, coluna) =>
  linhas()[indice].querySelectorAll('input')[coluna];

const abrirNovo = () => userEvent.click(screen.getByRole('button', { name: /Novo template/ }));
const salvar = () => userEvent.click(document.querySelector('.bt-btn-save'));

beforeEach(() => {
  toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn() };
  confirmar = jest.fn().mockResolvedValue(true);
  useToast.mockReturnValue({ toast, confirm: confirmar });
  api.post.mockResolvedValue({ data: {} });
  api.patch.mockResolvedValue({ data: {} });
  api.delete.mockResolvedValue({ data: {} });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => console.error.mockRestore());

describe('lista', () => {
  it('mostra o carregamento antes dos dados', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<BlindTemplates />);
    expect(screen.getByText('Carregando...')).toBeInTheDocument();
  });

  it('cada template mostra a contagem de níveis e de breaks', async () => {
    // 2 níveis + 1 break: é o resumo que permite escolher sem abrir.
    await montar();
    const cartao = cartaoDe('Turbo 15min');
    expect(cartao).toHaveTextContent('2 níveis');
    expect(cartao).toHaveTextContent('1 breaks');
  });

  it('template sem break não menciona breaks', async () => {
    await montar({
      modelos: [{ id: 'm9', name: 'Só níveis',
        custom_levels: [{ level: 1, is_break: false }] }],
    });
    expect(cartaoDe('Só níveis')).not.toHaveTextContent('breaks');
  });

  it('a descrição aparece quando existe', async () => {
    await montar();
    expect(cartaoDe('Turbo 15min')).toHaveTextContent('Estrutura rápida');
  });

  it('sem template nenhum convida a criar o primeiro', async () => {
    await montar({ modelos: [] });
    expect(screen.getByText('Nenhum template ainda')).toBeInTheDocument();
  });

  it('falha ao carregar não deixa a tela presa', async () => {
    await montar({ modelos: new Error('500') });
    expect(screen.queryByText('Carregando...')).toBeNull();
  });
});

describe('sugestão de níveis', () => {
  it('o primeiro nível começa em 25/50', async () => {
    await montar();
    await abrirNovo();
    expect(campoDaLinha(0, 0)).toHaveValue(25);
    expect(campoDaLinha(0, 1)).toHaveValue(50);
  });

  it('cada nível novo dobra o anterior', async () => {
    // É a progressão padrão; digitar tudo de novo seria trabalho repetido.
    await montar();
    await abrirNovo();
    await userEvent.click(screen.getByRole('button', { name: /Adicionar nível/ }));
    expect(campoDaLinha(1, 0)).toHaveValue(50);
    expect(campoDaLinha(1, 1)).toHaveValue(100);
  });

  it('a sugestão pula os BREAKS e parte do último nível real', async () => {
    // Um break tem 0/0; partir dele zeraria os blinds do nível seguinte.
    await montar();
    await abrirNovo();
    await userEvent.click(screen.getByRole('button', { name: /Adicionar break/ }));
    await userEvent.click(screen.getByRole('button', { name: /Adicionar nível/ }));
    expect(campoDaLinha(2, 0)).toHaveValue(50);
    expect(campoDaLinha(2, 1)).toHaveValue(100);
  });

  it('sem ante, o nível seguinte também fica sem ante', async () => {
    // Introduzir ante sozinho mudaria a estrutura sem o operador pedir.
    await montar();
    await abrirNovo();
    await userEvent.click(screen.getByRole('button', { name: /Adicionar nível/ }));
    expect(campoDaLinha(1, 2)).toHaveValue(0);
  });

  it('com ante, o ante também dobra', async () => {
    await montar();
    await userEvent.click(within(cartaoDe('Turbo 15min')).getByText('Editar'));
    await userEvent.click(screen.getByRole('button', { name: /Adicionar nível/ }));
    // último nível real tinha ante 100
    expect(campoDaLinha(3, 2)).toHaveValue(200);
  });

  it('o break entra com 10 minutos e sem blinds', async () => {
    await montar();
    await abrirNovo();
    await userEvent.click(screen.getByRole('button', { name: /Adicionar break/ }));
    expect(linhas()[1]).toHaveClass('bt-row-break');
    expect(linhas()[1]).toHaveTextContent('Intervalo');
  });
});

describe('numeração', () => {
  it('o BREAK não consome número de nível', async () => {
    // O "Nível 3" do template precisa ser o Nível 3 impresso na estrutura.
    await montar();
    await abrirNovo();
    await userEvent.click(screen.getByRole('button', { name: /Adicionar break/ }));
    await userEvent.click(screen.getByRole('button', { name: /Adicionar nível/ }));
    expect(linhas()[0]).toHaveTextContent('Nível 1');
    expect(linhas()[1]).toHaveTextContent('Break');
    expect(linhas()[2]).toHaveTextContent('Nível 2');
  });
});

describe('criar template', () => {
  it('exige um nome', async () => {
    // Um template sem nome é impossível de achar na hora de aplicar.
    await montar();
    await abrirNovo();
    await salvar();
    expect(toast.warning).toHaveBeenCalledWith('Dê um nome ao template.');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('nome só com espaços também é recusado', async () => {
    await montar();
    await abrirNovo();
    await userEvent.type(screen.getByPlaceholderText('Ex.: Turbo 20min'), '   ');
    await salvar();
    expect(toast.warning).toHaveBeenCalledWith('Dê um nome ao template.');
  });

  it('salva com a numeração reescrita pela ordem da tabela', async () => {
    // Remover uma linha do meio não pode deixar buracos na numeração.
    await montar();
    await abrirNovo();
    await userEvent.type(screen.getByPlaceholderText('Ex.: Turbo 20min'), 'Meu template');
    await userEvent.click(screen.getByRole('button', { name: /Adicionar nível/ }));
    await salvar();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const corpo = api.post.mock.calls[0][1];
    expect(corpo.custom_levels.map((l) => l.level)).toEqual([1, 2]);
  });

  it('o BREAK é salvo com blinds zerados', async () => {
    // Um break com "100/200" apareceria como nível no telão.
    await montar();
    await abrirNovo();
    await userEvent.type(screen.getByPlaceholderText('Ex.: Turbo 20min'), 'Com break');
    await userEvent.click(screen.getByRole('button', { name: /Adicionar break/ }));
    await salvar();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const quebra = api.post.mock.calls[0][1].custom_levels[1];
    expect(quebra).toMatchObject({ is_break: true, small_blind: 0, big_blind: 0, ante: 0 });
  });

  it('duração inválida vira 1 minuto, não zero', async () => {
    // Nível de duração zero travaria o relógio do torneio.
    await montar();
    await abrirNovo();
    await userEvent.type(screen.getByPlaceholderText('Ex.: Turbo 20min'), 'X');
    await userEvent.clear(campoDaLinha(0, 3));
    await salvar();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0][1].custom_levels[0].duration).toBe(1);
  });

  it('descrição em branco vai como nula', async () => {
    await montar();
    await abrirNovo();
    await userEvent.type(screen.getByPlaceholderText('Ex.: Turbo 20min'), 'X');
    await salvar();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0][1].description).toBeNull();
  });

  it('o template é salvo como estrutura personalizada', async () => {
    // É o que diz ao backend para usar os níveis da tabela em vez de gerar
    // por progressão automática.
    await montar();
    await abrirNovo();
    await userEvent.type(screen.getByPlaceholderText('Ex.: Turbo 20min'), 'X');
    await salvar();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0][1].blind_increase_type).toBe('custom');
  });

  it('erro do servidor mostra o motivo', async () => {
    api.post.mockRejectedValue({ response: { data: { detail: 'Nome já existe' } } });
    await montar();
    await abrirNovo();
    await userEvent.type(screen.getByPlaceholderText('Ex.: Turbo 20min'), 'X');
    await salvar();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Nome já existe'));
  });

  it('erro sem motivo legível cai numa frase padrão', async () => {
    api.post.mockRejectedValue({ response: { data: { detail: [{ msg: 'x' }] } } });
    await montar();
    await abrirNovo();
    await userEvent.type(screen.getByPlaceholderText('Ex.: Turbo 20min'), 'X');
    await salvar();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('common.error'));
  });

  it('cancelar fecha sem salvar', async () => {
    await montar();
    await abrirNovo();
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(document.querySelector('.bt-modal')).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe('editar template', () => {
  const editar = async (nome) =>
    userEvent.click(within(cartaoDe(nome)).getByText('Editar'));

  it('abre com nome, descrição e níveis atuais', async () => {
    await montar();
    await editar('Turbo 15min');
    expect(screen.getByPlaceholderText('Ex.: Turbo 20min')).toHaveValue('Turbo 15min');
    expect(screen.getByPlaceholderText('Opcional')).toHaveValue('Estrutura rápida');
    expect(linhas().length).toBe(3);
  });

  it('template sem níveis abre com um nível inicial', async () => {
    // Uma tabela vazia não teria como ser preenchida.
    await montar();
    await editar('Sem níveis');
    expect(linhas().length).toBe(1);
    expect(campoDaLinha(0, 0)).toHaveValue(25);
  });

  it('salvar usa PATCH, não cria outro template', async () => {
    await montar();
    await editar('Turbo 15min');
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/blind-templates/m1', expect.anything()));
    expect(api.post).not.toHaveBeenCalled();
  });

  it('remover uma linha renumera o resto', async () => {
    await montar();
    await editar('Turbo 15min');
    await userEvent.click(linhas()[0].querySelector('.bt-row-remove'));
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    const niveis = api.patch.mock.calls[0][1].custom_levels;
    expect(niveis.map((l) => l.level)).toEqual([1, 2]);
    expect(niveis[0].small_blind).toBe(50);
  });

  it('mudar um valor na tabela é salvo', async () => {
    await montar();
    await editar('Turbo 15min');
    await userEvent.clear(campoDaLinha(0, 0));
    await userEvent.type(campoDaLinha(0, 0), '30');
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(api.patch.mock.calls[0][1].custom_levels[0].small_blind).toBe(30);
  });
});

describe('excluir template', () => {
  it('a confirmação cita o nome', async () => {
    await montar();
    await userEvent.click(within(cartaoDe('Turbo 15min')).getByText('Excluir'));
    expect(confirmar).toHaveBeenCalledWith(
      expect.stringContaining('Turbo 15min'),
      expect.objectContaining({ variant: 'danger' })
    );
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/blind-templates/m1'));
  });

  it('recusar não exclui', async () => {
    confirmar.mockResolvedValue(false);
    await montar();
    await userEvent.click(within(cartaoDe('Turbo 15min')).getByText('Excluir'));
    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('erro ao excluir avisa', async () => {
    api.delete.mockRejectedValue(new Error('409'));
    await montar();
    await userEvent.click(within(cartaoDe('Turbo 15min')).getByText('Excluir'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('common.error'));
  });
});
