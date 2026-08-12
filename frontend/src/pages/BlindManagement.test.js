/**
 * Estrutura de blinds — a espinha do torneio.
 *
 * Duas regras dominam a tela e são o centro dos testes:
 *
 * - **Intervalo NÃO consome número de nível.** Ele existe na lista só para
 *   ocupar uma posição na ordem; se contasse como nível, o "Nível 5" da tela
 *   deixaria de ser o Nível 5 da estrutura impressa, e o dealer anunciaria o
 *   número errado no salão.
 * - **Intervalo não tem blind.** As colunas de valor não são editáveis num
 *   intervalo, e qualquer gravação zera small/big/ante — senão um intervalo
 *   com "100/200" apareceria no telão.
 *
 * A reordenação por arrasto renumera na hora (a tela responde antes da rede) e
 * grava só as posições que mudaram; se a gravação falhar, a tela volta para a
 * verdade do servidor em vez de manter uma ordem que não existe no banco.
 */
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import BlindManagement from './BlindManagement';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock('../components/Sidebar', () => () => <nav data-testid="sidebar" />);
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useParams: () => ({ dayId: 'd1' }),
  useNavigate: () => mockNavigate,
}));
jest.mock('react-i18next', () => {
  const t = (chave, segundo, terceiro) => {
    const vars = segundo && typeof segundo === 'object' ? segundo : terceiro;
    if (vars) return `${chave}:${Object.values(vars).join(',')}`;
    return typeof segundo === 'string' ? segundo : chave;
  };
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const DIA = { id: 'd1', day_name: 'Dia 1A', tournament_id: 't1' };
const TORNEIO = { id: 't1', name: 'Main Event' };

// Nível 1, nível 2, INTERVALO, nível 3 — a ordem que expõe a regra de
// numeração: o intervalo ocupa o `level` 3, mas o blind seguinte é o "Nível 3".
const BLINDS = [
  { id: 'b1', level: 1, small_blind: 100, big_blind: 200, ante: 0, duration: 20, is_break: false },
  { id: 'b2', level: 2, small_blind: 200, big_blind: 400, ante: 400, duration: 20, is_break: false },
  { id: 'b3', level: 3, small_blind: 0, big_blind: 0, ante: 0, duration: 10, is_break: true },
  { id: 'b4', level: 4, small_blind: 300, big_blind: 600, ante: 600, duration: 20, is_break: false },
];

const MODELOS = [
  { id: 'm1', name: 'Turbo', description: '15 níveis rápidos',
    initial_small_blind: 25, initial_big_blind: 50, blind_duration: 10,
    custom_levels: [{}, {}, {}] },
  { id: 'm2', name: 'Regular', initial_small_blind: 100, initial_big_blind: 200, blind_duration: 30 },
];

let toast;
let confirmar;

const responder = ({ dia = DIA, blinds = BLINDS, modelos = MODELOS, torneio = TORNEIO } = {}) => {
  api.get.mockImplementation((url) => {
    if (url === '/tournament-days/d1') {
      return dia instanceof Error ? Promise.reject(dia) : Promise.resolve({ data: dia });
    }
    if (url === '/tournament-days/d1/blinds') {
      return blinds instanceof Error ? Promise.reject(blinds) : Promise.resolve({ data: [...blinds] });
    }
    if (url === '/blind-templates') return Promise.resolve({ data: modelos });
    if (url === '/tournaments/t1') {
      return torneio instanceof Error ? Promise.reject(torneio) : Promise.resolve({ data: torneio });
    }
    return Promise.resolve({ data: [] });
  });
};

const erroHttp = (status, detail) => {
  const e = new Error('http');
  e.response = { status, data: detail ? { detail } : {} };
  return e;
};

const montar = async (opcoes) => {
  responder(opcoes);
  render(<MemoryRouter><BlindManagement /></MemoryRouter>);
  await waitFor(() => expect(screen.queryByText('common.loading')).toBeNull());
};

const linhas = () => Array.from(document.querySelectorAll('tbody tr'));
const linhaDoNivel = (rotulo) => linhas().find((tr) => within(tr).queryByText(rotulo));

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

describe('carga', () => {
  it('mostra o carregamento antes dos dados', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<MemoryRouter><BlindManagement /></MemoryRouter>);
    expect(screen.getByText('common.loading')).toBeInTheDocument();
  });

  it('o subtítulo junta torneio e dia', async () => {
    await montar();
    expect(screen.getByText('Main Event - Dia 1A')).toBeInTheDocument();
  });

  it('dia sem torneio associado mostra só o dia', async () => {
    await montar({ dia: { id: 'd1', day_name: 'Avulso' } });
    expect(screen.getByText('Avulso')).toBeInTheDocument();
  });

  it('link errado (404) diz exatamente isso', async () => {
    // "Erro ao carregar" faria o operador recarregar sem parar; o problema é
    // o link, não a rede.
    await montar({ dia: erroHttp(404) });
    expect(screen.getByText('Dia do torneio não encontrado')).toBeInTheDocument();
  });

  it('erro do servidor mostra o motivo que ele deu', async () => {
    await montar({ dia: erroHttp(500, 'Banco indisponível') });
    expect(screen.getByText('Banco indisponível')).toBeInTheDocument();
  });

  it('erro sem motivo cai numa frase clara', async () => {
    await montar({ dia: erroHttp(500) });
    expect(screen.getByText('Não foi possível carregar a estrutura de blinds')).toBeInTheDocument();
  });

  it('da tela de erro dá para voltar aos torneios', async () => {
    await montar({ dia: erroHttp(404) });
    await userEvent.click(screen.getByRole('button', { name: 'common.back' }));
    expect(mockNavigate).toHaveBeenCalledWith('/torneios');
  });

  it('estrutura vazia diz isso na tabela', async () => {
    await montar({ blinds: [] });
    expect(screen.getByText('blinds.noBlindRegistered')).toBeInTheDocument();
  });
});

describe('numeração dos níveis', () => {
  it('o INTERVALO não consome número de nível', async () => {
    // O intervalo está na terceira posição, mas o blind seguinte é o Nível 3 —
    // se contasse, o dealer anunciaria "Nível 4" para o Nível 3 impresso.
    await montar();
    expect(linhaDoNivel('blinds.level 3')).toBeDefined();
    expect(linhaDoNivel('blinds.level 4')).toBeUndefined();
  });

  it('o intervalo aparece como intervalo, não como nível', async () => {
    await montar();
    const intervalo = linhas()[2];
    expect(within(intervalo).getByText('blinds.break')).toBeInTheDocument();
  });

  it('intervalo não mostra valores de blind', async () => {
    // "0/0" no telão faria a mesa achar que a estrutura quebrou.
    await montar();
    const intervalo = linhas()[2];
    expect(within(intervalo).getAllByText('-').length).toBe(3);
  });

  it('a lista é ordenada pelo nível, não pela ordem que veio', async () => {
    await montar({ blinds: [BLINDS[3], BLINDS[0], BLINDS[2], BLINDS[1]] });
    expect(linhas()[0]).toHaveTextContent('blinds.level 1');
  });
});

describe('resumo da estrutura', () => {
  it('conta níveis e intervalos separados', async () => {
    await montar();
    const resumo = document.querySelector('.blinds-summary');
    expect(resumo).toHaveTextContent('blinds.levels: 3');
    expect(resumo).toHaveTextContent('blinds.breaks: 1');
  });

  it('mostra a duração total em minutos e em horas', async () => {
    // 20+20+10+20 = 70min = 1h10min. É o que o gerente usa para dizer a que
    // horas o torneio acaba.
    await montar();
    const resumo = document.querySelector('.blinds-summary');
    expect(resumo).toHaveTextContent('70 min (1h 10min)');
  });

  it('separa quanto do tempo é intervalo', async () => {
    await montar();
    expect(document.querySelector('.blinds-summary')).toHaveTextContent('blinds.breakTime: 10 min');
  });

  it('estrutura vazia não mostra resumo', async () => {
    await montar({ blinds: [] });
    expect(document.querySelector('.blinds-summary')).toBeNull();
  });
});

describe('edição direta na célula', () => {
  const celula = (linha, indice) => linha.querySelectorAll('td')[indice];

  it('clicar no valor abre a edição', async () => {
    await montar();
    await userEvent.click(within(celula(linhas()[0], 1)).getByText('100'));
    expect(document.querySelector('.inline-edit-input')).toHaveValue(100);
  });

  it('Enter grava o novo valor', async () => {
    await montar();
    await userEvent.click(within(celula(linhas()[0], 1)).getByText('100'));
    const campo = document.querySelector('.inline-edit-input');
    await userEvent.clear(campo);
    await userEvent.type(campo, '150{Enter}');
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        '/tournament-days/d1/blinds/b1',
        expect.objectContaining({ small_blind: 150 })
      )
    );
  });

  it('Escape desiste sem gravar', async () => {
    await montar();
    await userEvent.click(within(celula(linhas()[0], 1)).getByText('100'));
    const campo = document.querySelector('.inline-edit-input');
    await userEvent.clear(campo);
    await userEvent.type(campo, '999{Escape}');
    expect(api.patch).not.toHaveBeenCalled();
    expect(document.querySelector('.inline-edit-input')).toBeNull();
  });

  it('sair do campo sem mudar nada não grava', async () => {
    // Clicar e desistir acontece o tempo todo; gravar à toa poluiria o log.
    await montar();
    await userEvent.click(within(celula(linhas()[0], 1)).getByText('100'));
    fireEvent.blur(document.querySelector('.inline-edit-input'));
    await waitFor(() => expect(document.querySelector('.inline-edit-input')).toBeNull());
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('valor negativo vira zero, não negativo', async () => {
    // Blind negativo não existe; deixar passar quebraria o cálculo do stack.
    await montar();
    await userEvent.click(within(celula(linhas()[0], 3)).getByText('0'));
    const campo = document.querySelector('.inline-edit-input');
    await userEvent.clear(campo);
    await userEvent.type(campo, '-50{Enter}');
    await waitFor(() => expect(document.querySelector('.inline-edit-input')).toBeNull());
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('texto sem número vira zero', async () => {
    await montar();
    await userEvent.click(within(celula(linhas()[0], 1)).getByText('100'));
    const campo = document.querySelector('.inline-edit-input');
    await userEvent.clear(campo);
    await userEvent.type(campo, '{Enter}');
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        '/tournament-days/d1/blinds/b1',
        expect.objectContaining({ small_blind: 0 })
      )
    );
  });

  it('no intervalo, SÓ a duração é editável', async () => {
    // Um intervalo com "100/200" apareceria no telão como se fosse um nível.
    await montar();
    const intervalo = linhas()[2];
    await userEvent.click(within(celula(intervalo, 4)).getByText('10 min'));
    expect(document.querySelector('.inline-edit-input')).toBeInTheDocument();
  });

  it('gravar um intervalo zera os valores de blind', async () => {
    await montar();
    const intervalo = linhas()[2];
    await userEvent.click(within(celula(intervalo, 4)).getByText('10 min'));
    const campo = document.querySelector('.inline-edit-input');
    await userEvent.clear(campo);
    await userEvent.type(campo, '15{Enter}');
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/tournament-days/d1/blinds/b3', {
        level: 3, duration: 15, is_break: true, small_blind: 0, big_blind: 0, ante: 0,
      })
    );
  });

  it('erro ao gravar mostra o motivo do servidor', async () => {
    api.patch.mockRejectedValue(erroHttp(409, 'Nível em uso'));
    await montar();
    await userEvent.click(within(celula(linhas()[0], 1)).getByText('100'));
    const campo = document.querySelector('.inline-edit-input');
    await userEvent.clear(campo);
    await userEvent.type(campo, '150{Enter}');
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Nível em uso'));
  });
});

describe('reordenar arrastando', () => {
  const arrastar = async (de, para) => {
    const dados = { effectAllowed: '' };
    fireEvent.dragStart(linhas()[de], { dataTransfer: dados });
    fireEvent.dragOver(linhas()[para], { dataTransfer: dados });
    fireEvent.drop(linhas()[para], { dataTransfer: dados });
  };

  it('a lista renumera na hora, antes da rede', async () => {
    // O operador precisa ver a nova ordem imediatamente; esperar o servidor
    // deixaria a tela "pulando" depois.
    await montar();
    await arrastar(3, 0);
    await waitFor(() => expect(linhas()[0]).toHaveTextContent('blinds.level 1'));
  });

  it('grava as posições que mudaram', async () => {
    await montar();
    await arrastar(3, 0);
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(api.patch.mock.calls.length).toBeGreaterThan(0);
  });

  it('soltar na mesma posição não grava nada', async () => {
    await montar();
    await arrastar(1, 1);
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('falha ao gravar volta para a verdade do servidor', async () => {
    // Manter a ordem nova na tela faria o operador confiar numa estrutura que
    // o banco não tem.
    api.patch.mockRejectedValue(erroHttp(500, 'Conflito de nível'));
    await montar();
    const buscas = api.get.mock.calls.length;
    await arrastar(3, 0);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Conflito de nível'));
    expect(api.get.mock.calls.length).toBeGreaterThan(buscas);
  });

  it('arrastar sem origem válida não faz nada', async () => {
    await montar();
    fireEvent.drop(linhas()[0], { dataTransfer: {} });
    expect(api.patch).not.toHaveBeenCalled();
  });
});

describe('adicionar nível', () => {
  const abrir = () => userEvent.click(screen.getByRole('button', { name: 'blinds.addBlind' }));

  it('sugere o dobro do último nível', async () => {
    // A progressão dobrando é o padrão; digitar tudo de novo a cada nível
    // seria trabalho repetido no meio do evento.
    await montar();
    await abrir();
    expect(screen.getByLabelText('blinds.smallBlind *')).toHaveValue(600);
    expect(screen.getByLabelText('blinds.bigBlind *')).toHaveValue(1200);
  });

  it('sugere o dobro do ante quando já existe ante', async () => {
    await montar();
    await abrir();
    expect(screen.getByLabelText('blinds.ante')).toHaveValue(1200);
  });

  it('sem ante ainda, sugere o big blind (padrão do BB ante)', async () => {
    await montar({ blinds: [{ ...BLINDS[0], ante: 0 }] });
    await abrir();
    expect(screen.getByLabelText('blinds.ante')).toHaveValue(200);
  });

  it('estrutura vazia começa do zero, sem sugestão', async () => {
    await montar({ blinds: [] });
    await abrir();
    expect(screen.getByLabelText('blinds.smallBlind *')).toHaveValue(null);
    expect(screen.getByLabelText('blinds.duration *')).toHaveValue(15);
  });

  it('as posições disponíveis dizem entre quais níveis o novo entra', async () => {
    // Sem essa dica o operador precisaria contar a tabela para inserir um
    // nível no meio.
    await montar();
    await abrir();
    const posicoes = screen.getByLabelText('blinds.position *');
    expect(within(posicoes).getByText(/positionAfter/)).toBeInTheDocument();
  });

  it('a única posição de uma estrutura vazia é a primeira', async () => {
    await montar({ blinds: [] });
    await abrir();
    const posicoes = screen.getByLabelText('blinds.position *');
    expect(within(posicoes).getByText(/primeiro nível/)).toBeInTheDocument();
  });

  it('posições já ocupadas não são oferecidas', async () => {
    await montar();
    const posicoes = (await abrir(), screen.getByLabelText('blinds.position *'));
    // Existem os níveis 1..4; só a posição 5 sobra.
    expect(within(posicoes).getAllByRole('option').length).toBe(1);
  });

  it('cria o nível com os valores informados', async () => {
    // O botao do cabecalho e o de submissao tem o mesmo nome; o do
    // formulario e o ultimo.
    await montar();
    await abrir();
    await userEvent.click(screen.getAllByRole('button', { name: 'blinds.addBlind' }).slice(-1)[0]);
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/tournament-days/d1/blinds', {
        level: 5, duration: 20, is_break: false,
        small_blind: 600, big_blind: 1200, ante: 1200,
      })
    );
  });

  it('erro do servidor aparece com o motivo', async () => {
    api.post.mockRejectedValue(erroHttp(400, 'Nível duplicado'));
    await montar();
    await abrir();
    await userEvent.click(screen.getAllByRole('button', { name: 'blinds.addBlind' }).slice(-1)[0]);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Nível duplicado'));
  });

  it('cancelar fecha sem criar', async () => {
    await montar();
    await abrir();
    await userEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(document.querySelector('.modal')).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe('adicionar intervalo', () => {
  const abrir = () => userEvent.click(screen.getByRole('button', { name: 'blinds.addBreak' }));

  it('o formulário do intervalo não pede blinds', async () => {
    await montar();
    await abrir();
    expect(screen.queryByLabelText('blinds.smallBlind *')).toBeNull();
    expect(screen.getByLabelText('blinds.duration *')).toHaveValue(10);
  });

  it('explica o que vai acontecer, com a duração escolhida', async () => {
    await montar();
    await abrir();
    expect(document.querySelector('.break-info')).toHaveTextContent('blinds.breakInfo:10');
  });

  it('o intervalo é criado com os valores zerados', async () => {
    // Zerar aqui é o que impede um intervalo com blind aparecer no telão.
    await montar();
    await abrir();
    await userEvent.click(screen.getAllByRole('button', { name: 'blinds.addBreak' }).slice(-1)[0]);
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/tournament-days/d1/blinds', {
        level: 5, duration: 10, is_break: true, small_blind: 0, big_blind: 0, ante: 0,
      })
    );
  });
});

describe('editar pelo formulário', () => {
  const abrirEdicao = async (indice) =>
    userEvent.click(within(linhas()[indice]).getByRole('button', { name: 'common.edit' }));

  it('o formulário abre com os valores atuais', async () => {
    await montar();
    await abrirEdicao(0);
    expect(screen.getByLabelText('blinds.smallBlind *')).toHaveValue(100);
    expect(screen.getByLabelText('blinds.duration *')).toHaveValue(20);
  });

  it('salvar envia o que mudou', async () => {
    await montar();
    await abrirEdicao(0);
    const campo = screen.getByLabelText('blinds.smallBlind *');
    await userEvent.clear(campo);
    await userEvent.type(campo, '125');
    await userEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        '/tournament-days/d1/blinds/b1',
        expect.objectContaining({ small_blind: 125 })
      )
    );
  });

  it('transformar um nível em intervalo esconde os campos de blind', async () => {
    await montar();
    await abrirEdicao(0);
    await userEvent.click(screen.getByRole('checkbox'));
    expect(screen.queryByLabelText('blinds.smallBlind *')).toBeNull();
  });

  it('erro ao salvar mostra o motivo', async () => {
    api.patch.mockRejectedValue(erroHttp(400, 'Estrutura travada'));
    await montar();
    await abrirEdicao(0);
    await userEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Estrutura travada'));
  });
});

describe('excluir nível', () => {
  it('a confirmação nomeia o nível pelo número que aparece na tela', async () => {
    // Confirmar "excluir o nível 4" e ver sumir o 3 destruiria a confiança
    // na tela.
    await montar();
    await userEvent.click(within(linhas()[3]).getByRole('button', { name: 'common.delete' }));
    expect(confirmar).toHaveBeenCalledWith(
      'blinds.confirmDeleteMessage:blinds.level 3',
      expect.objectContaining({ variant: 'danger' })
    );
  });

  it('a confirmação de um intervalo o chama de intervalo', async () => {
    await montar();
    await userEvent.click(within(linhas()[2]).getByRole('button', { name: 'common.delete' }));
    expect(confirmar).toHaveBeenCalledWith(
      'blinds.confirmDeleteMessage:blinds.break',
      expect.anything()
    );
  });

  it('confirmar exclui', async () => {
    await montar();
    await userEvent.click(within(linhas()[0]).getByRole('button', { name: 'common.delete' }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/tournament-days/d1/blinds/b1'));
  });

  it('cancelar não exclui', async () => {
    confirmar.mockResolvedValue(false);
    await montar();
    await userEvent.click(within(linhas()[0]).getByRole('button', { name: 'common.delete' }));
    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('erro ao excluir avisa', async () => {
    api.delete.mockRejectedValue(new Error('500'));
    await montar();
    await userEvent.click(within(linhas()[0]).getByRole('button', { name: 'common.delete' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('common.error'));
  });
});

describe('modelos de estrutura', () => {
  const abrir = () => userEvent.click(screen.getByRole('button', { name: 'blinds.loadTemplate' }));

  it('lista os modelos com os dados que identificam cada um', async () => {
    await montar();
    await abrir();
    const modal = document.querySelector('.template-modal');
    expect(within(modal).getByText('Turbo')).toBeInTheDocument();
    expect(within(modal).getByText('15 níveis rápidos')).toBeInTheDocument();
    expect(modal).toHaveTextContent('25/50');
  });

  it('sem modelo nenhum orienta a criar um', async () => {
    await montar({ modelos: [] });
    await abrir();
    expect(screen.getByText('blinds.noTemplatesHint')).toBeInTheDocument();
  });

  it('aplicar sobre uma estrutura existente pede confirmação', async () => {
    // Aplicar apaga tudo o que já estava lá.
    await montar();
    await abrir();
    await userEvent.click(screen.getAllByRole('button', { name: 'blinds.applyTemplate' })[0]);
    expect(confirmar).toHaveBeenCalledWith('blinds.confirmApplyTemplate');
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/blind-templates/apply', {
        template_id: 'm1', tournament_day_id: 'd1', clear_existing: true,
      })
    );
  });

  it('estrutura vazia aplica direto, sem perguntar', async () => {
    await montar({ blinds: [] });
    await abrir();
    await userEvent.click(screen.getAllByRole('button', { name: 'blinds.applyTemplate' })[0]);
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(confirmar).not.toHaveBeenCalled();
  });

  it('recusar a confirmação não aplica', async () => {
    confirmar.mockResolvedValue(false);
    await montar();
    await abrir();
    await userEvent.click(screen.getAllByRole('button', { name: 'blinds.applyTemplate' })[0]);
    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    expect(api.post).not.toHaveBeenCalled();
  });

  it('erro ao aplicar avisa', async () => {
    api.post.mockRejectedValue(new Error('500'));
    await montar();
    await abrir();
    await userEvent.click(screen.getAllByRole('button', { name: 'blinds.applyTemplate' })[0]);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('common.error'));
  });

  it('excluir um modelo cita o nome na confirmação', async () => {
    await montar();
    await abrir();
    await userEvent.click(screen.getAllByRole('button', { name: 'common.delete' }).slice(-2)[0]);
    expect(confirmar).toHaveBeenCalledWith(
      'blinds.confirmDeleteTemplate "Turbo"?',
      expect.objectContaining({ variant: 'danger' })
    );
  });

  it('erro ao excluir o modelo avisa', async () => {
    api.delete.mockRejectedValue(new Error('409'));
    await montar();
    await abrir();
    await userEvent.click(screen.getAllByRole('button', { name: 'common.delete' }).slice(-2)[0]);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('common.error'));
  });
});
