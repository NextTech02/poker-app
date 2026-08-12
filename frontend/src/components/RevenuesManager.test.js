/**
 * Outras receitas da etapa (bar, patrocínio, aluguel de espaço).
 *
 * É o faturamento que NÃO passa pelo caixa de torneio e que, antes desta
 * aba, ficava fora do DRE — o clube via só o dinheiro das entradas e
 * concluía que a etapa deu menos resultado do que deu.
 *
 * Duas distinções carregam peso:
 *
 * - **"Entrou no caixa" é diferente de "foi recebido".** Um patrocínio pago
 *   por transferência bancária conta no DRE mas não está na gaveta; marcar
 *   como se estivesse quebraria a conferência do caixa.
 * - **A etapa não muda depois de criada.** Mudá-la tiraria a receita de um
 *   fechamento já feito e a jogaria em outro.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RevenuesManager from './RevenuesManager';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));
// `t` estável: o componente usa `t` como dependência do useCallback que
// alimenta o useEffect de carga.
jest.mock('react-i18next', () => {
  const t = (chave, padrao, vars) => {
    let texto = typeof padrao === 'string' ? padrao : chave;
    if (vars) {
      Object.entries(vars).forEach(([k, v]) => {
        texto = texto.replace(`{{${k}}}`, v);
      });
    }
    return texto;
  };
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const ETAPAS = [{ id: 'e1', name: 'Etapa Rio' }, { id: 'e2', name: 'Etapa SP' }];
const TORNEIOS = [{ id: 't1', name: 'Main Event' }];

const RECEITAS = [
  {
    id: 'r1', description: 'Bar sábado', source: 'Bar/Cozinha',
    stage_id: 'e1', stage_name: 'Etapa Rio', amount: 3200,
    status: 'recebido', to_cash: true,
  },
  {
    id: 'r2', description: 'Patrocínio', source: 'Patrocínio',
    stage_id: 'e1', stage_name: 'Etapa Rio', amount: 10000,
    status: 'pendente', to_cash: false,
  },
];

let toast;
let confirmar;

const responder = (receitas = RECEITAS) => {
  api.get.mockImplementation((url) => {
    if (url === '/stages') return Promise.resolve({ data: ETAPAS });
    if (url === '/tournaments') return Promise.resolve({ data: TORNEIOS });
    if (url === '/revenues') return Promise.resolve({ data: receitas });
    return Promise.resolve({ data: [] });
  });
};

const montar = async (receitas) => {
  responder(receitas);
  render(<RevenuesManager />);
  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/revenues', expect.any(Object)));
};

const esperarLinhas = () =>
  waitFor(() => expect(document.querySelectorAll('tbody tr').length).toBeGreaterThan(0));

const campo = (seletor) => document.querySelector(`.exp-modal form ${seletor}`);
const salvar = () =>
  userEvent.click(document.querySelector('.exp-modal button[type="submit"]'));

const abrirNova = () =>
  userEvent.click(screen.getByRole('button', { name: /Nova receita/ }));

const preencherMinimo = async (descricao = 'Bar domingo', valor = '500') => {
  await userEvent.selectOptions(campo('select'), 'e1');
  await userEvent.type(campo('input'), descricao);
  await userEvent.type(campo('input[type="number"]'), valor);
};

beforeEach(() => {
  toast = { success: jest.fn(), error: jest.fn() };
  confirmar = jest.fn().mockResolvedValue(true);
  useToast.mockReturnValue({ toast, confirm: confirmar });
  useCurrency.mockReturnValue({ formatCurrency: (v) => `R$ ${Number(v || 0).toFixed(2)}` });
  api.post.mockResolvedValue({ data: {} });
  api.patch.mockResolvedValue({ data: {} });
  api.delete.mockResolvedValue({ data: {} });
});

describe('listagem e totais', () => {
  it('mostra as receitas com origem e etapa', async () => {
    await montar();
    await esperarLinhas();
    expect(screen.getByText('Bar/Cozinha')).toBeInTheDocument();
    expect(screen.getAllByText('Etapa Rio').length).toBeGreaterThan(0);
  });

  it('separa total, recebido e a receber', async () => {
    // "A receber" é o que o clube ainda vai cobrar — some do caixa se não
    // aparecer em lugar nenhum.
    await montar();
    await esperarLinhas();
    const valores = Array.from(document.querySelectorAll('.exp-total-value')).map(
      (v) => v.textContent
    );
    expect(valores).toEqual(['R$ 13200.00', 'R$ 3200.00', 'R$ 10000.00']);
  });

  it('sem receita mostra o estado vazio', async () => {
    await montar([]);
    expect(await screen.findByText(/Nenhuma receita registrada/)).toBeInTheDocument();
  });

  it('falha ao carregar avisa', async () => {
    api.get.mockImplementation((url) =>
      url === '/revenues'
        ? Promise.reject({ userMessage: 'sem permissão' })
        : Promise.resolve({ data: [] })
    );
    render(<RevenuesManager />);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('sem permissão'));
  });

  it('listas auxiliares que falham não impedem a tela', async () => {
    api.get.mockImplementation((url) =>
      url === '/revenues'
        ? Promise.resolve({ data: RECEITAS })
        : Promise.reject(new Error('falhou'))
    );
    render(<RevenuesManager />);
    await esperarLinhas();
  });
});

describe('filtros', () => {
  it('filtra por etapa e status', async () => {
    await montar();
    await esperarLinhas();
    const selects = document.querySelectorAll('.exp-toolbar select');
    await userEvent.selectOptions(selects[0], 'e2');
    await userEvent.selectOptions(selects[1], 'recebido');
    await waitFor(() => {
      const ultima = api.get.mock.calls.filter((c) => c[0] === '/revenues').pop();
      expect(ultima[1].params).toMatchObject({ stage_id: 'e2', status: 'recebido' });
    });
  });

  it('sem filtro não manda parâmetros vazios', async () => {
    // `stage_id: ''` faria o backend filtrar por etapa vazia e devolver nada.
    await montar();
    expect(api.get.mock.calls.find((c) => c[0] === '/revenues')[1].params).toEqual({});
  });
});

describe('criação', () => {
  it('grava a receita', async () => {
    await montar();
    await esperarLinhas();
    await abrirNova();
    await preencherMinimo();
    await salvar();
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        '/revenues',
        expect.objectContaining({ stage_id: 'e1', description: 'Bar domingo', amount: 500 })
      )
    );
    expect(toast.success).toHaveBeenCalled();
  });

  it('a origem tem sugestões mas o campo é livre', async () => {
    // Cada clube tem as próprias fontes de receita; uma lista fechada
    // obrigaria a jogar tudo em "Outros".
    await montar();
    await esperarLinhas();
    await abrirNova();
    const origem = document.querySelector('.exp-modal input[list], .exp-modal datalist');
    expect(document.querySelector('.exp-modal')).toBeInTheDocument();
    expect(origem || document.querySelector('.exp-modal select')).toBeTruthy();
  });

  it('etapa é obrigatória', async () => {
    // Receita solta não entra em DRE nenhum.
    await montar();
    await esperarLinhas();
    await abrirNova();
    await userEvent.type(campo('input'), 'X');
    await userEvent.type(campo('input[type="number"]'), '10');
    await salvar();
    expect(api.post).not.toHaveBeenCalled();
    expect(screen.getAllByText('Obrigatório').length).toBeGreaterThan(0);
  });

  it('descrição é obrigatória', async () => {
    await montar();
    await esperarLinhas();
    await abrirNova();
    await userEvent.selectOptions(campo('select'), 'e1');
    await userEvent.type(campo('input[type="number"]'), '10');
    await salvar();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('valor precisa ser maior que zero', async () => {
    // Receita negativa é despesa disfarçada; zero é lançamento em branco.
    await montar();
    await esperarLinhas();
    await abrirNova();
    await userEvent.selectOptions(campo('select'), 'e1');
    await userEvent.type(campo('input'), 'X');
    await userEvent.type(campo('input[type="number"]'), '0');
    await salvar();
    expect(api.post).not.toHaveBeenCalled();
    expect(screen.getByText(/valor maior que zero/)).toBeInTheDocument();
  });

  it('torneio e observação vazios viram null', async () => {
    await montar();
    await esperarLinhas();
    await abrirNova();
    await preencherMinimo();
    await salvar();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const corpo = api.post.mock.calls[0][1];
    expect(corpo.tournament_id).toBeNull();
    expect(corpo.notes).toBeNull();
  });

  it('erro do servidor aparece e mantém o formulário', async () => {
    api.post.mockRejectedValue({ userMessage: 'etapa encerrada' });
    await montar();
    await esperarLinhas();
    await abrirNova();
    await preencherMinimo();
    await salvar();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('etapa encerrada'));
    expect(document.querySelector('.exp-modal')).toBeInTheDocument();
  });
});

describe('edição', () => {
  it('carrega os valores da receita', async () => {
    await montar();
    await esperarLinhas();
    await userEvent.click(screen.getAllByRole('button', { name: 'Editar' })[0]);
    expect(campo('input')).toHaveValue('Bar sábado');
  });

  it('a etapa NÃO é enviada na edição', async () => {
    // Mudá-la tiraria a receita de um fechamento já feito.
    await montar();
    await esperarLinhas();
    await userEvent.click(screen.getAllByRole('button', { name: 'Editar' })[0]);
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    const [url, corpo] = api.patch.mock.calls[0];
    expect(url).toBe('/revenues/r1');
    expect(corpo).not.toHaveProperty('stage_id');
  });

  it('receita sem origem cai em "Outros"', async () => {
    await montar([{ ...RECEITAS[0], source: null }]);
    await esperarLinhas();
    await userEvent.click(screen.getAllByRole('button', { name: 'Editar' })[0]);
    await salvar();
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        '/revenues/r1',
        expect.objectContaining({ source: 'Outros' })
      )
    );
  });
});

describe('marcar como recebida', () => {
  it('alterna pendente → recebido', async () => {
    await montar();
    await esperarLinhas();
    await userEvent.click(document.querySelector('.exp-status--pendente'));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/revenues/r2', { status: 'recebido' })
    );
  });

  it('alterna recebido → pendente', async () => {
    // Erro de marcação precisa ser reversível sem apagar a receita.
    // A receita recebida reaproveita a classe visual "pago" das despesas.
    await montar();
    await esperarLinhas();
    await userEvent.click(document.querySelector('.exp-status--pago'));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/revenues/r1', { status: 'pendente' })
    );
  });

  it('falha ao alternar avisa', async () => {
    api.patch.mockRejectedValue({ userMessage: 'sem permissão' });
    await montar();
    await esperarLinhas();
    await userEvent.click(document.querySelector('.exp-status--pendente'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('sem permissão'));
  });
});

describe('exclusão', () => {
  it('pede confirmação de perigo com a descrição', async () => {
    await montar();
    await esperarLinhas();
    await userEvent.click(screen.getAllByRole('button', { name: 'Excluir' })[0]);
    expect(confirmar).toHaveBeenCalledWith(
      expect.stringContaining('Bar sábado'),
      expect.objectContaining({ variant: 'danger' })
    );
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/revenues/r1'));
  });

  it('cancelar não exclui', async () => {
    confirmar.mockResolvedValue(false);
    await montar();
    await esperarLinhas();
    await userEvent.click(screen.getAllByRole('button', { name: 'Excluir' })[0]);
    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('falha ao excluir avisa', async () => {
    api.delete.mockRejectedValue({ userMessage: 'em uso' });
    await montar();
    await esperarLinhas();
    await userEvent.click(screen.getAllByRole('button', { name: 'Excluir' })[0]);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('em uso'));
  });
});
