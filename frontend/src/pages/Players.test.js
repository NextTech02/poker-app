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
 * - **Nome e sobrenome são dois campos, mas `name` continua sendo enviado.**
 *   93 arquivos do sistema leem players.name (recibo de prêmio, alocação de
 *   mesa, tela de TV) e o backend anterior ao deploy ainda o exige — o deploy
 *   não é atômico.
 * - **Documento inventado não passa** ("coloquei um monte de 0 e aceitou"),
 *   mas o cadastro ANTIGO continua editável: bloquear o jogador legado
 *   travaria o balcão com a fila esperando.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Players, { mensagemDoErro } from './Players';
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
  const t = (chave, segundo, terceiro) => {
    const padrao = typeof segundo === 'string' ? segundo : chave;
    const vars = segundo && typeof segundo === 'object' ? segundo : terceiro;
    return vars
      ? padrao.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] != null ? vars[k] : `{{${k}}}`))
      : padrao;
  };
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
// Instância própria do user-event com `delay: null`. O padrão espera um
// macrotask entre CADA tecla; este arquivo preenche 5 campos por teste (~55
// teclas), o que sozinho consumia ~1,1s dos 5s de timeout — e estourava quando
// a suíte inteira roda em paralelo e disputa CPU. `delay: null` tira só a
// espera artificial: os eventos de teclado continuam sendo disparados um a um.
let ue;

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

const abrirNovo = () => ue.click(screen.getByRole('button', { name: /players.newPlayer/ }));

// CPF real (dígitos verificadores conferem) — o formulário agora recusa
// documento inventado, então o preenchimento padrão precisa de um válido.
const CPF_VALIDO = '529.982.247-25';
const CPF_LIMPO = '52998224725';

const preencher = async ({
  nome = 'Carlos', sobrenome = 'Dias', email = 'carlos@x.com', telefone = '11777',
  nacionalidade = 'Brasil', documento = CPF_VALIDO,
} = {}) => {
  if (nome) await ue.type(screen.getByLabelText(/players.firstName|Nome/), nome);
  if (sobrenome) await ue.type(screen.getByLabelText(/Sobrenome/), sobrenome);
  if (email) await ue.type(screen.getByLabelText(/players.email/), email);
  if (telefone) await ue.type(screen.getByLabelText(/players.phone/), telefone);
  if (nacionalidade) await ue.type(screen.getByLabelText(/players.nationality/), nacionalidade);
  if (documento) await ue.type(screen.getByLabelText(/players.documentNumber/), documento);
};

const salvar = () => ue.click(document.querySelector('.pl-modal button[type="submit"]'));

beforeEach(() => {
  ue = userEvent.setup({ delay: null });
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
    await ue.type(screen.getByPlaceholderText('players.searchPlaceholder'), 'ana');
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/players', { params: { search: 'ana' } })
    );
  });

  it('sem resultado a tela cita o termo procurado', async () => {
    // "Nenhum jogador" faria o operador achar que a base está vazia.
    await montar({ busca: [] });
    await ue.type(screen.getByPlaceholderText('players.searchPlaceholder'), 'zzz');
    await waitFor(() => expect(document.querySelector('.pl-empty')).toBeInTheDocument());
    expect(screen.getByText(/zzz/)).toBeInTheDocument();
  });

  it('limpar a busca volta para a lista cacheada', async () => {
    await montar();
    await ue.type(screen.getByPlaceholderText('players.searchPlaceholder'), 'ana');
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    const antes = cachedGet.mock.calls.length;
    await ue.click(document.querySelector('.pl-search-clear'));
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

  it('grava nome e sobrenome separados, e o nome completo junto', async () => {
    // Os dois campos são o pedido do dono do clube; `name` continua indo no
    // mesmo envio porque 93 telas leem players.name (recibo de prêmio, mesa,
    // TV) e o backend anterior ao deploy ainda exige o nome completo.
    await montar();
    await abrirNovo();
    await preencher({ nome: 'Maria', sobrenome: 'Silva Costa' });
    await salvar();
    await waitFor(() => expect(offlineWrite).toHaveBeenCalled());
    expect(offlineWrite.mock.calls[0][0].body).toMatchObject({
      first_name: 'Maria', last_name: 'Silva Costa', name: 'Maria Silva Costa',
    });
  });

  it('jogador de nome só, sem sobrenome, é aceito', async () => {
    // O sobrenome não pode ser obrigatório: 1 dos cadastros de hoje tem uma
    // palavra só, e o balcão não vai inventar sobrenome para vender a ficha.
    await montar();
    await abrirNovo();
    await preencher({ nome: 'Madonna', sobrenome: '' });
    await salvar();
    await waitFor(() => expect(offlineWrite).toHaveBeenCalled());
    expect(offlineWrite.mock.calls[0][0].body).toMatchObject({
      first_name: 'Madonna', last_name: '', name: 'Madonna',
    });
  });

  it('espaço sobrando não vira nome torto', async () => {
    await montar();
    await abrirNovo();
    await preencher({ nome: '  Ana ', sobrenome: ' Costa  Lima ' });
    await salvar();
    await waitFor(() => expect(offlineWrite).toHaveBeenCalled());
    expect(offlineWrite.mock.calls[0][0].body.name).toBe('Ana Costa Lima');
  });

  it('só espaço no nome não cria jogador', async () => {
    await montar();
    await abrirNovo();
    await preencher({ nome: '   ', sobrenome: 'Dias' });
    await salvar();
    expect(await screen.findByText('Informe o nome do jogador.')).toBeInTheDocument();
    expect(offlineWrite).not.toHaveBeenCalled();
  });

  it('um monte de 0 no documento não sai da tela', async () => {
    // O achado do dono do clube: recibo de prêmio com documento 00000000000
    // não vale nada na prestação de contas.
    await montar();
    await abrirNovo();
    await preencher({ documento: '00000000000' });
    await salvar();
    await waitFor(() =>
      expect(document.querySelector('.pl-form-error')).toBeInTheDocument()
    );
    expect(offlineWrite).not.toHaveBeenCalled();
  });

  it('CPF com dígito errado é barrado', async () => {
    await montar();
    await abrirNovo();
    await preencher({ documento: '529.982.247-26' });
    await salvar();
    await waitFor(() =>
      expect(document.querySelector('.pl-form-error')).toBeInTheDocument()
    );
    expect(offlineWrite).not.toHaveBeenCalled();
  });

  it('o documento é enviado sem pontuação', async () => {
    // Guardar normalizado é o que impede "529.982.247-25" e "52998224725"
    // virarem dois cadastros do mesmo jogador.
    await montar();
    await abrirNovo();
    await preencher();
    await salvar();
    await waitFor(() => expect(offlineWrite).toHaveBeenCalled());
    expect(offlineWrite.mock.calls[0][0].body.document_number).toBe(CPF_LIMPO);
  });

  it('o tipo de documento oferece os países onde o clube opera', async () => {
    await montar();
    await abrirNovo();
    const tipos = Array.from(
      screen.getByLabelText(/players.documentType/).querySelectorAll('option')
    ).map((o) => o.value);
    expect(tipos).toEqual(expect.arrayContaining(['cpf', 'dni', 'cedula', 'passport']));
    // O tipo genérico antigo não é oferecido em cadastro novo.
    expect(tipos).not.toContain('national_id');
  });

  it('DNI do Peru com 8 dígitos passa', async () => {
    await montar();
    await abrirNovo();
    await ue.selectOptions(screen.getByLabelText(/players.documentType/), 'dni');
    await preencher({ documento: '10293847' });
    await salvar();
    await waitFor(() => expect(offlineWrite).toHaveBeenCalled());
    expect(offlineWrite.mock.calls[0][0].body).toMatchObject({
      document_type: 'dni', document_number: '10293847',
    });
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
    // O padrão inline passou a existir nesta chamada (regra do projeto), então
    // é a frase que aparece — e não o nome da chave.
    expect(await screen.findByText('Não foi possível salvar o jogador.')).toBeInTheDocument();
  });

  it('fechar sem salvar não cria nada', async () => {
    await montar();
    await abrirNovo();
    await ue.click(document.querySelector('.pl-modal-close'));
    expect(offlineWrite).not.toHaveBeenCalled();
  });
});

describe('editar jogador', () => {
  const editar = async (nome) => {
    await waitFor(() => expect(linhaDe(nome)).toBeDefined());
    await ue.click(within(linhaDe(nome)).getByTitle('players.editPlayer'));
  };

  it('abre com os dados atuais', async () => {
    await montar();
    await editar('Beto Silva');
    expect(screen.getByLabelText(/players.documentNumber/)).toHaveValue('123');
  });

  it('cadastro antigo abre com o nome já dividido', async () => {
    // A linha só tem `name` enquanto a migração não roda. Sem dividir, o
    // operador teria de redigitar o nome inteiro só para corrigir o telefone.
    await montar();
    await editar('Beto Silva');
    expect(screen.getByLabelText(/players.firstName|Nome/)).toHaveValue('Beto');
    expect(screen.getByLabelText(/Sobrenome/)).toHaveValue('Silva');
  });

  it('o tipo antigo continua no select de quem já está com ele', async () => {
    // Se sumisse, o select abriria vazio e o cadastro legado só salvaria
    // depois de escolher outro documento — com a fila esperando.
    await montar();
    await editar('Beto Silva');
    const tipo = screen.getByLabelText(/players.documentType/);
    expect(tipo).toHaveValue('national_id');
    expect(within(tipo).getByText(/cadastro antigo/i)).toBeInTheDocument();
  });

  it('documento legado inválido não impede corrigir outro campo', async () => {
    // Há 1 jogador na base com documento inválido: bloquear a edição dele
    // travaria o balcão por causa de cadastro antigo.
    await montar({ lista: [{ ...JOGADORES[0], document_number: '00000000000' }] });
    await editar('Beto Silva');
    const telefone = screen.getByLabelText(/players.phone/);
    await ue.clear(telefone);
    await ue.type(telefone, '11912345678');
    await salvar();
    await waitFor(() => expect(offlineWrite).toHaveBeenCalled());
    expect(offlineWrite.mock.calls[0][0].body.phone).toBe('11912345678');
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
    const sobrenome = screen.getByLabelText(/Sobrenome/);
    await ue.clear(sobrenome);
    await ue.type(sobrenome, 'Andrade');
    await salvar();
    await waitFor(() => expect(offlineWrite).toHaveBeenCalled());
    const op = offlineWrite.mock.calls[0][0];
    expect(op.method).toBe('patch');
    expect(op.url).toBe('/players/p1');
    // Trocar o sobrenome tem de remontar o nome completo: é ele que a tela de
    // TV e o recibo do prêmio mostram.
    expect(op.body).toMatchObject({ last_name: 'Andrade', name: 'Beto Andrade' });
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
    await ue.click(within(linhaDe(nome)).getByTitle('players.deletePlayer'));
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
    await ue.click(within(linhaDe('Beto Silva')).getByText('Beto Silva'));
    expect(mockNavigate).toHaveBeenCalledWith('/jogadores/p1');
  });

  it('o histórico também abre pelo teclado', async () => {
    // A linha inteira é clicável; sem tratar Enter, quem navega por teclado
    // não chega ao histórico.
    await montar();
    await waitFor(() => expect(linhaDe('Beto Silva')).toBeDefined());
    const celula = linhaDe('Beto Silva').querySelector('.pl-player-cell-link');
    celula.focus();
    await ue.keyboard('{Enter}');
    expect(mockNavigate).toHaveBeenCalledWith('/jogadores/p1');
  });

  it('a importação abre sob demanda', async () => {
    // O componente é carregado só quando pedido (code-splitting).
    await montar();
    await ue.click(screen.getByRole('button', { name: /Importar/ }));
    expect(await screen.findByTestId('importacao')).toBeInTheDocument();
  });

  it('fechar a importação a remove da tela', async () => {
    await montar();
    await ue.click(screen.getByRole('button', { name: /Importar/ }));
    await screen.findByTestId('importacao');
    await ue.click(screen.getByText('fechar'));
    await waitFor(() => expect(screen.queryByTestId('importacao')).toBeNull());
  });
});

describe('mensagem de erro do cadastro', () => {
  /* O que chegava na tela era o texto cru do Postgres, precedido de "Internal
     server error" — ilegível, e dizendo a coisa errada: não é erro interno, é
     cadastro repetido, que o balcão resolve em segundos se souber disso.

     Testado como função pura porque é o que ela é. O sistema atende clubes no
     Brasil, no Peru e na Colômbia: a frase sai pelo `code`, no idioma de quem
     está na tela, e não pronta do servidor. */
  // Espelha o mock do i18n deste arquivo: sem padrão inline, devolve a chave.
  const t = (chave, padrao, vars) => {
    const base = typeof padrao === 'string' ? padrao : chave;
    return vars ? base.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k]) : base;
  };

  const erroCom = (detail) => ({ response: { data: { detail } } });

  it('e-mail repetido diz de quem é', () => {
    const msg = mensagemDoErro(erroCom({
      code: 'email_duplicado', name: 'Beto Silva',
      message: 'Este e-mail já está cadastrado para Beto Silva.',
    }), t);
    expect(msg).toBe('Este e-mail já está cadastrado para Beto Silva.');
  });

  it('documento repetido diz de quem é', () => {
    const msg = mensagemDoErro(erroCom({
      code: 'documento_duplicado', name: 'Ana Costa', message: 'x',
    }), t);
    expect(msg).toContain('Ana Costa');
  });

  it('sem o nome, a frase ainda serve', () => {
    const msg = mensagemDoErro(erroCom({ code: 'email_duplicado', message: 'x' }), t);
    expect(msg).toBe('Este e-mail já está cadastrado para outro jogador.');
  });

  it('limite do plano diz o que fazer', () => {
    const msg = mensagemDoErro(erroCom({ code: 'limite_de_jogadores', message: 'x' }), t);
    expect(msg).toMatch(/Troque de plano/);
  });

  it('código novo do servidor cai na frase que ele mandou', () => {
    /* Reserva: se o backend ganhar um código antes desta tela conhecê-lo, a
       frase dele é melhor que o genérico "não foi possível salvar". */
    const msg = mensagemDoErro(erroCom({
      code: 'coisa_nova', message: 'Explicação vinda do servidor.',
    }), t);
    expect(msg).toBe('Explicação vinda do servidor.');
  });

  it('detail em texto continua funcionando', () => {
    // As outras recusas do backend (documento inválido, por exemplo) mandam
    // string, e não podem parar de aparecer.
    expect(mensagemDoErro(erroCom('CPF inválido.'), t)).toBe('CPF inválido.');
  });

  it('erro sem detail nenhum cai no genérico', () => {
    expect(mensagemDoErro(new Error('rede'), t)).toBe('Não foi possível salvar o jogador.');
  });

  it('a mensagem da camada offline tem prioridade', () => {
    // Ela já vem pronta e explica a fila; sobrepô-la confundiria.
    const e = { userMessage: 'Salvo no aparelho, sincroniza depois.', response: { data: { detail: 'x' } } };
    expect(mensagemDoErro(e, t)).toBe('Salvo no aparelho, sincroniza depois.');
  });
});
