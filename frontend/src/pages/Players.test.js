/**
 * Jogadores — o cadastro que todo o resto referencia.
 *
 * O que os testes cercam:
 *
 * - **Buscar não usa cache.** A lista sem filtro é cacheada por 60s (navegar e
 *   voltar não refaz a chamada), mas a busca é uma consulta dinâmica: servir
 *   cache aqui devolveria o resultado da busca anterior.
 * - **Toda mutação invalida o cache.** Sem isso o jogador recém-criado sumiria
 *   da lista por até um minuto — e o operador o cadastraria de novo.
 * - **Criar/editar passa pela camada offline** com id gerado no cliente, para
 *   que o cadastro feito sem rede possa ser referenciado por um registro de
 *   buy-in na mesma fila.
 * - **Plural correto na contagem** (ISSUE-008): "1 jogadores" numa tela de
 *   cadastro passa a impressão de sistema mal-acabado.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Players from './Players';
import api from '../config/api';
import { cachedGet, invalidateCache } from '../utils/apiCache';
import { offlineWrite } from '../offline/apiOffline';
import { useToast } from '../contexts/ToastContext';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock('../utils/apiCache', () => ({ cachedGet: jest.fn(), invalidateCache: jest.fn() }));
jest.mock('../offline/apiOffline', () => ({ offlineWrite: jest.fn() }));
jest.mock('../offline/domainRules', () => ({ applyPlayerCreate: jest.fn() }));
jest.mock('../offline/db', () => ({
  uuid: () => 'uuid-fixo', getEntity: jest.fn(), putEntity: jest.fn(),
}));
jest.mock('../components/Sidebar', () => () => <nav data-testid="sidebar" />);
jest.mock('../components/PlayerImportModal', () => ({ onClose }) => (
  <div data-testid="importacao"><button onClick={onClose}>fechar</button></div>
));
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));
jest.mock('react-i18next', () => {
  const t = (chave, segundo) => (typeof segundo === 'string' ? segundo : chave);
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const JOGADORES = [
  { id: 'p1', name: 'Beto Silva', nickname: 'BS', email: 'beto@x.com', phone: '11999',
    nationality: 'Brasil', document_type: 'national_id', document_number: '123' },
  { id: 'p2', name: 'Ana Costa', email: 'ana@x.com', phone: '11888',
    nationality: 'Peru', document_type: 'passport', document_number: 'XY9' },
];

let toast;
let confirmar;

const responder = ({ lista = JOGADORES, busca = JOGADORES } = {}) => {
  cachedGet.mockImplementation(() =>
    lista instanceof Error ? Promise.reject(lista) : Promise.resolve(lista)
  );
  api.get.mockImplementation(() =>
    busca instanceof Error ? Promise.reject(busca) : Promise.resolve({ data: busca })
  );
};

const montar = async (opcoes) => {
  responder(opcoes);
  render(<MemoryRouter><Players /></MemoryRouter>);
  await waitFor(() => expect(cachedGet).toHaveBeenCalled());
};

const linhaDe = (nome) =>
  Array.from(document.querySelectorAll('.pl-row')).find((tr) =>
    within(tr).queryByText(nome)
  );

const abrirNovo = () => userEvent.click(screen.getByRole('button', { name: /players.newPlayer/ }));

const preencher = async ({
  nome = 'Carlos Dias', email = 'carlos@x.com', telefone = '11777',
  nacionalidade = 'Brasil', documento = '999',
} = {}) => {
  if (nome) await userEvent.type(screen.getByLabelText(/players.fullName/), nome);
  if (email) await userEvent.type(screen.getByLabelText(/players.email/), email);
  if (telefone) await userEvent.type(screen.getByLabelText(/players.phone/), telefone);
  if (nacionalidade) await userEvent.type(screen.getByLabelText(/players.nationality/), nacionalidade);
  if (documento) await userEvent.type(screen.getByLabelText(/players.documentNumber/), documento);
};

const salvar = () => userEvent.click(document.querySelector('.pl-modal button[type="submit"]'));

beforeEach(() => {
  toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn() };
  confirmar = jest.fn().mockResolvedValue(true);
  useToast.mockReturnValue({ toast, confirm: confirmar });
  offlineWrite.mockResolvedValue({ offline: false, data: { id: 'novo' } });
  api.delete.mockResolvedValue({ data: {} });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => console.error.mockRestore());

describe('lista', () => {
  it('mostra o esqueleto enquanto carrega', () => {
    cachedGet.mockReturnValue(new Promise(() => {}));
    render(<MemoryRouter><Players /></MemoryRouter>);
    expect(document.querySelector('.skeleton-row, .pl-table')).toBeTruthy();
  });

  it('lista em ordem alfabética, não na ordem que veio', async () => {
    // Procurar um nome numa lista fora de ordem é o gargalo do balcão.
    await montar();
    await waitFor(() => expect(document.querySelectorAll('.pl-row').length).toBe(2));
    const nomes = Array.from(document.querySelectorAll('.pl-player-name')).map((e) => e.textContent);
    expect(nomes).toEqual(['Ana Costa', 'Beto Silva']);
  });

  it('mostra apelido, contato e documento', async () => {
    await montar();
    await waitFor(() => expect(linhaDe('Beto Silva')).toBeDefined());
    const linha = linhaDe('Beto Silva');
    expect(within(linha).getByText('@BS')).toBeInTheDocument();
    expect(within(linha).getByText('beto@x.com')).toBeInTheDocument();
    expect(within(linha).getByText('123')).toBeInTheDocument();
  });

  it('o tipo de documento é traduzido', async () => {
    await montar();
    await waitFor(() => expect(linhaDe('Ana Costa')).toBeDefined());
    expect(within(linhaDe('Ana Costa')).getByText('players.docPassport')).toBeInTheDocument();
  });

  it('jogador sem documento mostra travessão', async () => {
    await montar({ lista: [{ id: 'p9', name: 'Sem doc' }] });
    await waitFor(() => expect(linhaDe('Sem doc')).toBeDefined());
    expect(within(linhaDe('Sem doc')).getAllByText('—').length).toBeGreaterThan(0);
  });

  it('a contagem usa o plural certo', async () => {
    // ISSUE-008: "1 jogadores" passa a impressão de sistema mal-acabado.
    await montar();
    await waitFor(() =>
      expect(document.querySelector('.pl-table-count')).toHaveTextContent('jogadores')
    );
  });

  it('com um só jogador a contagem fica no singular', async () => {
    await montar({ lista: [JOGADORES[0]] });
    await waitFor(() =>
      expect(document.querySelector('.pl-table-count')).toHaveTextContent('jogador')
    );
    expect(document.querySelector('.pl-table-count')).not.toHaveTextContent('jogadores');
  });

  it('sem jogador nenhum convida a cadastrar', async () => {
    await montar({ lista: [] });
    await waitFor(() => expect(document.querySelector('.pl-empty')).toBeInTheDocument());
    expect(screen.getByText('players.noPlayersHint')).toBeInTheDocument();
  });

  it('falha ao carregar não deixa a tela presa', async () => {
    await montar({ lista: new Error('500') });
    await waitFor(() => expect(document.querySelector('.pl-empty')).toBeInTheDocument());
  });
});

describe('busca', () => {
  it('a lista sem filtro usa o cache', async () => {
    // Navegar para cá e voltar não deve refazer a chamada.
    await montar();
    expect(cachedGet).toHaveBeenCalledWith(api, '/players', 60000);
  });

  it('buscar NÃO usa cache: a consulta é dinâmica', async () => {
    // Servir cache aqui devolveria o resultado da busca anterior.
    await montar();
    await userEvent.type(screen.getByPlaceholderText('players.searchPlaceholder'), 'ana');
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/players', { params: { search: 'ana' } })
    );
  });

  it('sem resultado a tela cita o termo procurado', async () => {
    // "Nenhum jogador" faria o operador achar que a base está vazia.
    await montar({ busca: [] });
    await userEvent.type(screen.getByPlaceholderText('players.searchPlaceholder'), 'zzz');
    await waitFor(() => expect(document.querySelector('.pl-empty')).toBeInTheDocument());
    expect(screen.getByText(/zzz/)).toBeInTheDocument();
  });

  it('limpar a busca volta para a lista cacheada', async () => {
    await montar();
    await userEvent.type(screen.getByPlaceholderText('players.searchPlaceholder'), 'ana');
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    const antes = cachedGet.mock.calls.length;
    await userEvent.click(document.querySelector('.pl-search-clear'));
    await waitFor(() => expect(cachedGet.mock.calls.length).toBeGreaterThan(antes));
  });
});

describe('cadastrar jogador', () => {
  it('cria com id gerado no cliente', async () => {
    // O id vem do cliente para que um buy-in feito offline logo depois
    // consiga referenciar este jogador na mesma fila.
    await montar();
    await abrirNovo();
    await preencher();
    await salvar();
    await waitFor(() => expect(offlineWrite).toHaveBeenCalled());
    const op = offlineWrite.mock.calls[0][0];
    expect(op.url).toBe('/players');
    expect(op.body).toMatchObject({ name: 'Carlos Dias', client_id: 'uuid-fixo' });
  });

  it('criar invalida o cache da lista', async () => {
    // Sem isso o jogador sumiria por até um minuto e seria cadastrado de novo.
    await montar();
    await abrirNovo();
    await preencher();
    await salvar();
    await waitFor(() => expect(invalidateCache).toHaveBeenCalledWith('/players'));
  });

  it('sem rede o cadastro entra na fila e a tela avisa', async () => {
    offlineWrite.mockResolvedValue({ offline: true, data: { id: 'uuid-fixo' } });
    await montar();
    await abrirNovo();
    await preencher();
    await salvar();
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Salvo offline — será enviado ao sincronizar')
    );
  });

  it('erro do servidor aparece dentro do formulário', async () => {
    // Um toast some antes de o operador achar o campo errado.
    offlineWrite.mockRejectedValue({ userMessage: 'Documento já cadastrado' });
    await montar();
    await abrirNovo();
    await preencher();
    await salvar();
    expect(await screen.findByText('Documento já cadastrado')).toBeInTheDocument();
    expect(document.querySelector('.pl-modal')).toBeInTheDocument();
  });

  it('erro que não é texto cai numa frase legível', async () => {
    offlineWrite.mockRejectedValue({ response: { data: { detail: [{ msg: 'x' }] } } });
    await montar();
    await abrirNovo();
    await preencher();
    await salvar();
    expect(await screen.findByText('players.saveError')).toBeInTheDocument();
  });

  it('fechar sem salvar não cria nada', async () => {
    await montar();
    await abrirNovo();
    await userEvent.click(document.querySelector('.pl-modal-close'));
    expect(offlineWrite).not.toHaveBeenCalled();
  });
});

describe('editar jogador', () => {
  const editar = async (nome) => {
    await waitFor(() => expect(linhaDe(nome)).toBeDefined());
    await userEvent.click(within(linhaDe(nome)).getByTitle('players.editPlayer'));
  };

  it('abre com os dados atuais', async () => {
    await montar();
    await editar('Beto Silva');
    expect(screen.getByLabelText(/players.fullName/)).toHaveValue('Beto Silva');
    expect(screen.getByLabelText(/players.documentNumber/)).toHaveValue('123');
  });

  it('campos ausentes viram vazio, não "undefined"', async () => {
    await montar({ lista: [{ id: 'p9', name: 'Sem dados' }] });
    await editar('Sem dados');
    expect(screen.getByLabelText(/players.email/)).toHaveValue('');
    expect(screen.getByLabelText(/players.nicknameLabel/)).toHaveValue('');
  });

  it('salvar envia PATCH para o jogador certo', async () => {
    await montar();
    await editar('Beto Silva');
    const nome = screen.getByLabelText(/players.fullName/);
    await userEvent.clear(nome);
    await userEvent.type(nome, 'Beto S. Silva');
    await salvar();
    await waitFor(() => expect(offlineWrite).toHaveBeenCalled());
    const op = offlineWrite.mock.calls[0][0];
    expect(op.method).toBe('patch');
    expect(op.url).toBe('/players/p1');
    expect(op.body.name).toBe('Beto S. Silva');
  });

  it('editar também invalida o cache', async () => {
    await montar();
    await editar('Beto Silva');
    await salvar();
    await waitFor(() => expect(invalidateCache).toHaveBeenCalledWith('/players'));
  });

  it('edição offline avisa que ficou na fila', async () => {
    offlineWrite.mockResolvedValue({ offline: true, data: {} });
    await montar();
    await editar('Beto Silva');
    await salvar();
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Salvo offline — será enviado ao sincronizar')
    );
  });
});

describe('excluir jogador', () => {
  const excluir = async (nome) => {
    await waitFor(() => expect(linhaDe(nome)).toBeDefined());
    await userEvent.click(within(linhaDe(nome)).getByTitle('players.deletePlayer'));
  };

  it('pede confirmação de perigo', async () => {
    await montar();
    await excluir('Beto Silva');
    expect(confirmar).toHaveBeenCalledWith(
      'players.confirmDelete',
      expect.objectContaining({ variant: 'danger' })
    );
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/players/p1'));
  });

  it('recusar não exclui', async () => {
    confirmar.mockResolvedValue(false);
    await montar();
    await excluir('Beto Silva');
    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('erro ao excluir avisa', async () => {
    api.delete.mockRejectedValue(new Error('409'));
    await montar();
    await excluir('Beto Silva');
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('players.deleteError'));
  });
});

describe('histórico e importação', () => {
  it('o nome do jogador leva ao histórico dele', async () => {
    await montar();
    await waitFor(() => expect(linhaDe('Beto Silva')).toBeDefined());
    await userEvent.click(within(linhaDe('Beto Silva')).getByText('Beto Silva'));
    expect(mockNavigate).toHaveBeenCalledWith('/jogadores/p1');
  });

  it('o histórico também abre pelo teclado', async () => {
    // A linha inteira é clicável; sem tratar Enter, quem navega por teclado
    // não chega ao histórico.
    await montar();
    await waitFor(() => expect(linhaDe('Beto Silva')).toBeDefined());
    const celula = linhaDe('Beto Silva').querySelector('.pl-player-cell-link');
    celula.focus();
    await userEvent.keyboard('{Enter}');
    expect(mockNavigate).toHaveBeenCalledWith('/jogadores/p1');
  });

  it('a importação abre sob demanda', async () => {
    // O componente é carregado só quando pedido (code-splitting).
    await montar();
    await userEvent.click(screen.getByRole('button', { name: /Importar/ }));
    expect(await screen.findByTestId('importacao')).toBeInTheDocument();
  });

  it('fechar a importação a remove da tela', async () => {
    await montar();
    await userEvent.click(screen.getByRole('button', { name: /Importar/ }));
    await screen.findByTestId('importacao');
    await userEvent.click(screen.getByText('fechar'));
    await waitFor(() => expect(screen.queryByTestId('importacao')).toBeNull());
  });
});
