/**
 * Despesas da etapa (aba do Financeiro).
 *
 * As despesas são o que fecha o DRE: sem elas o clube vê faturamento, não
 * resultado. Daí as regras que os testes travam:
 *
 * - **Toda despesa ancora numa ETAPA.** Uma despesa solta não entra em DRE
 *   nenhum — some do relatório sem aviso. Por isso a etapa é obrigatória e
 *   NÃO muda depois de criada: mudá-la tiraria o valor de um fechamento já
 *   feito e o jogaria em outro.
 * - **Valor tem que ser maior que zero.** Uma despesa de zero não é despesa;
 *   é um lançamento em branco que polui o relatório.
 * - **Campos vazios viram `null`.** String vazia no banco vira "há um
 *   fornecedor chamado ''", e os filtros passam a não bater.
 * - **O comprovante vai para um caminho começado pela ORGANIZAÇÃO.** É esse
 *   prefixo que a policy do Storage compara para isolar os clubes.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ExpensesManager from './ExpensesManager';
import api from '../config/api';
import { supabase } from '../config/supabase';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock('../config/supabase', () => ({
  supabase: { storage: { from: jest.fn() } },
}));
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));
// `t` e `i18n` precisam ser ESTAVEIS entre renders: o componente usa `t` como
// dependencia de um useCallback que alimenta um useEffect. Devolver funcoes
// novas a cada render (o que o i18next real nao faz) criaria um laco infinito
// de recarga — artefato do teste, nao do produto.
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
const CATEGORIAS = [{ id: 'c1', name: 'Aluguel' }, { id: 'c2', name: 'Buffet' }];
const TORNEIOS = [{ id: 't1', name: 'Main Event' }];
const MODELOS = [
  { id: 'm1', name: 'Aluguel do salão', category_id: 'c1',
    description: 'Aluguel', supplier: 'Imobiliária', amount: 5000 },
];

const DESPESAS = [
  {
    id: 'd1', description: 'Buffet', supplier: 'Casa de Festas',
    category_id: 'c2', category_name: 'Buffet', stage_id: 'e1', stage_name: 'Etapa Rio',
    tournament_name: 'Main Event', amount: 1200, status: 'pendente',
    due_date: '2026-06-15', paid_from_cash: true,
  },
  {
    id: 'd2', description: 'Aluguel', category_name: 'Aluguel',
    stage_id: 'e1', stage_name: 'Etapa Rio', amount: 5000, status: 'pago',
    paid_from_cash: false,
  },
];

let toast;
let confirmar;

const responder = ({ despesas = DESPESAS, modelos = MODELOS } = {}) => {
  api.get.mockImplementation((url) => {
    if (url === '/stages') return Promise.resolve({ data: ETAPAS });
    if (url === '/tournaments') return Promise.resolve({ data: TORNEIOS });
    if (url === '/expenses/categories') return Promise.resolve({ data: CATEGORIAS });
    if (url === '/expenses/templates') return Promise.resolve({ data: modelos });
    if (url === '/expenses') return Promise.resolve({ data: despesas });
    if (url.includes('/attachments')) return Promise.resolve({ data: [] });
    return Promise.resolve({ data: [] });
  });
};

const montar = async (opcoes) => {
  responder(opcoes);
  render(<ExpensesManager />);
  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/expenses', expect.any(Object)));
};

/** Espera as linhas da tabela aparecerem (o texto do fornecedor fica junto
 *  com o nome do torneio no mesmo no, entao nao serve de ancora). */
const esperarLinhas = () =>
  waitFor(() => expect(document.querySelectorAll('tbody tr').length).toBeGreaterThan(0));

const abrirNova = async () => {
  await userEvent.click(screen.getByRole('button', { name: /Nova despesa/ }));
};

/** Campos do formulario dentro do modal (o primeiro <select> pode ser o
 *  seletor de modelos, que fica FORA do <form>). */
const campo = (seletor) => document.querySelector(`.exp-modal form ${seletor}`);

/** Preenche o mínimo obrigatório do formulário. */
const preencherMinimo = async (descricao = 'Segurança', valor = '800') => {
  await userEvent.selectOptions(campo('select'), 'e1');
  await userEvent.type(campo('input'), descricao);
  await userEvent.type(campo('input[type="number"]'), valor);
};

const salvar = () =>
  userEvent.click(document.querySelector('.exp-modal button[type="submit"]'));

beforeEach(() => {
  toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn() };
  confirmar = jest.fn().mockResolvedValue(true);
  useToast.mockReturnValue({ toast, confirm: confirmar });
  useCurrency.mockReturnValue({ formatCurrency: (v) => `R$ ${Number(v || 0).toFixed(2)}` });
  api.post.mockResolvedValue({ data: {} });
  api.patch.mockResolvedValue({ data: {} });
  api.delete.mockResolvedValue({ data: {} });
  localStorage.setItem(
    'supabase_token',
    `x.${btoa(JSON.stringify({ organization_id: 'org-1' }))}.y`
  );
});

describe('listagem e totais', () => {
  it('mostra as despesas com categoria e etapa', async () => {
    await montar();
    await esperarLinhas();
    expect(document.querySelector('.exp-desc')).toHaveTextContent('Buffet');
    expect(screen.getAllByText('Etapa Rio').length).toBeGreaterThan(0);
  });

  it('separa total, pago e a pagar', async () => {
    // É o que o clube olha primeiro: quanto ainda vai sair do caixa.
    await montar();
    await esperarLinhas();
    const valores = Array.from(document.querySelectorAll('.exp-total-value')).map(
      (v) => v.textContent
    );
    expect(valores).toEqual(['R$ 6200.00', 'R$ 5000.00', 'R$ 1200.00']);
  });

  it('despesa paga por fora é marcada', async () => {
    // Ela conta no DRE mas NÃO saiu do caixa; sem a marca, a conferência do
    // caixa não bateria.
    await montar();
    expect(await screen.findByText('por fora')).toBeInTheDocument();
  });

  it('despesa sem categoria mostra travessão', async () => {
    await montar({ despesas: [{ ...DESPESAS[0], category_name: null }] });
    await esperarLinhas();
    expect(document.querySelector('.exp-muted').textContent).toBe('—');
  });

  it('despesa sem vencimento mostra travessão', async () => {
    await montar({ despesas: [{ ...DESPESAS[0], due_date: null }] });
    await esperarLinhas();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('sem despesa mostra o estado vazio', async () => {
    await montar({ despesas: [] });
    expect(await screen.findByText(/Nenhuma despesa registrada/)).toBeInTheDocument();
  });

  it('falha ao carregar avisa', async () => {
    api.get.mockImplementation((url) =>
      url === '/expenses'
        ? Promise.reject(Object.assign(new Error('403'), { userMessage: 'sem permissão' }))
        : Promise.resolve({ data: [] })
    );
    render(<ExpensesManager />);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('sem permissão'));
  });

  it('listas auxiliares que falham não impedem a tela', async () => {
    // Um /stages fora do ar não pode travar a aba inteira.
    api.get.mockImplementation((url) =>
      url === '/expenses'
        ? Promise.resolve({ data: DESPESAS })
        : Promise.reject(new Error('falhou'))
    );
    render(<ExpensesManager />);
    await esperarLinhas();
  });
});

describe('filtros', () => {
  it('filtra por etapa', async () => {
    await montar();
    await esperarLinhas();
    await userEvent.selectOptions(document.querySelectorAll('.exp-toolbar select')[0], 'e2');
    await waitFor(() => {
      const ultima = api.get.mock.calls.filter((c) => c[0] === '/expenses').pop();
      expect(ultima[1].params.stage_id).toBe('e2');
    });
  });

  it('filtra por categoria e status juntos', async () => {
    await montar();
    await esperarLinhas();
    const selects = document.querySelectorAll('.exp-toolbar select');
    await userEvent.selectOptions(selects[1], 'c1');
    await userEvent.selectOptions(selects[2], 'pago');
    await waitFor(() => {
      const ultima = api.get.mock.calls.filter((c) => c[0] === '/expenses').pop();
      expect(ultima[1].params).toMatchObject({ category_id: 'c1', status: 'pago' });
    });
  });

  it('sem filtro nenhum não manda parâmetros vazios', async () => {
    // `stage_id: ''` faria o backend filtrar por etapa vazia e devolver nada.
    await montar();
    const primeira = api.get.mock.calls.find((c) => c[0] === '/expenses');
    expect(primeira[1].params).toEqual({});
  });
});

describe('criação', () => {
  it('grava a despesa com os campos preenchidos', async () => {
    await montar();
    await esperarLinhas();
    await abrirNova();
    await preencherMinimo();
    await salvar();
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        '/expenses',
        expect.objectContaining({
          stage_id: 'e1',
          description: 'Segurança',
          amount: 800,
        })
      )
    );
    expect(toast.success).toHaveBeenCalled();
  });

  it('etapa é obrigatória', async () => {
    // Despesa solta não entra em DRE nenhum — some do relatório sem aviso.
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
    // Uma despesa de zero é um lançamento em branco que polui o relatório.
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

  it('campos opcionais vazios viram null', async () => {
    // String vazia no banco vira "há um fornecedor chamado ''", e os filtros
    // deixam de bater.
    await montar();
    await esperarLinhas();
    await abrirNova();
    await preencherMinimo();
    await salvar();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const corpo = api.post.mock.calls.find((c) => c[0] === '/expenses')[1];
    expect(corpo.category_id).toBeNull();
    expect(corpo.tournament_id).toBeNull();
    expect(corpo.supplier).toBeNull();
  });

  it('erro do servidor aparece e mantém o formulário', async () => {
    api.post.mockRejectedValue({ userMessage: 'Saldo insuficiente no caixa geral' });
    await montar();
    await esperarLinhas();
    await abrirNova();
    await preencherMinimo();
    await salvar();
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Saldo insuficiente no caixa geral')
    );
    expect(document.querySelector('.exp-modal')).toBeInTheDocument();
  });

  it('cancelar fecha sem gravar', async () => {
    await montar();
    await esperarLinhas();
    await abrirNova();
    await userEvent.click(document.querySelector('.exp-modal-overlay'));
    expect(document.querySelector('.exp-modal')).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe('edição', () => {
  it('carrega os valores da despesa', async () => {
    await montar();
    await esperarLinhas();
    await userEvent.click(screen.getAllByRole('button', { name: 'Editar' })[0]);
    expect(campo('input')).toHaveValue('Buffet');
    expect(screen.getByDisplayValue('Casa de Festas')).toBeInTheDocument();
  });

  it('a etapa NÃO é enviada na edição', async () => {
    // Mudá-la tiraria o valor de um fechamento já feito e o jogaria em outro.
    await montar();
    await esperarLinhas();
    await userEvent.click(screen.getAllByRole('button', { name: 'Editar' })[0]);
    await salvar();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    const [url, corpo] = api.patch.mock.calls[0];
    expect(url).toBe('/expenses/d1');
    expect(corpo).not.toHaveProperty('stage_id');
  });
});

describe('marcar como paga', () => {
  it('alterna pendente → pago', async () => {
    await montar();
    await esperarLinhas();
    await userEvent.click(document.querySelector('.exp-status--pendente'));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/expenses/d1', { status: 'pago' })
    );
  });

  it('alterna pago → pendente', async () => {
    // Erro de marcação precisa ser reversível sem apagar a despesa.
    await montar();
    await esperarLinhas();
    await userEvent.click(document.querySelector('.exp-status--pago'));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/expenses/d2', { status: 'pendente' })
    );
  });

  it('falha ao alternar avisa', async () => {
    api.patch.mockRejectedValue({ userMessage: 'sem saldo' });
    await montar();
    await esperarLinhas();
    await userEvent.click(document.querySelector('.exp-status--pendente'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('sem saldo'));
  });
});

describe('exclusão', () => {
  it('pede confirmação de perigo com a descrição', async () => {
    await montar();
    await esperarLinhas();
    await userEvent.click(screen.getAllByRole('button', { name: 'Excluir' })[0]);
    expect(confirmar).toHaveBeenCalledWith(
      expect.stringContaining('Buffet'),
      expect.objectContaining({ variant: 'danger' })
    );
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/expenses/d1'));
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

describe('modelos recorrentes', () => {
  it('aplicar um modelo preenche o formulário', async () => {
    // Aluguel e dealers se repetem a cada etapa; redigitar seria trabalho
    // manual toda semana.
    await montar();
    await esperarLinhas();
    await abrirNova();
    await userEvent.selectOptions(
      document.querySelector('.exp-modal select'), 'm1'
    );
    expect(campo('input')).toHaveValue('Aluguel');
    expect(screen.getByDisplayValue('Imobiliária')).toBeInTheDocument();
  });

  it('sem modelos o seletor não aparece', async () => {
    await montar({ modelos: [] });
    await esperarLinhas();
    await abrirNova();
    expect(screen.queryByText(/Usar um modelo/)).toBeNull();
  });

  it('na edição o seletor de modelos não aparece', async () => {
    // O lançamento já existe; aplicar um modelo sobrescreveria o histórico.
    await montar();
    await esperarLinhas();
    await userEvent.click(screen.getAllByRole('button', { name: 'Editar' })[0]);
    expect(screen.queryByText(/Usar um modelo/)).toBeNull();
  });

  it('modelo inexistente não altera nada', async () => {
    await montar();
    await esperarLinhas();
    await abrirNova();
    expect(campo('input')).toHaveValue('');
  });
});

describe('comprovantes', () => {
  const abrirAnexos = async () => {
    await montar();
    await esperarLinhas();
    await userEvent.click(screen.getAllByTitle('Comprovantes')[0]);
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/expenses/d1/attachments')
    );
  };

  it('abre a lista de comprovantes da despesa', async () => {
    await abrirAnexos();
  });

  it('falha ao carregar comprovantes avisa', async () => {
    api.get.mockImplementation((url) => {
      if (url.includes('/attachments')) return Promise.reject(Object.assign(new Error('403'), { userMessage: 'sem acesso' }));
      if (url === '/expenses') return Promise.resolve({ data: DESPESAS });
      return Promise.resolve({ data: [] });
    });
    render(<ExpensesManager />);
    await esperarLinhas();
    await userEvent.click(screen.getAllByTitle('Comprovantes')[0]);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('sem acesso'));
  });

  it('o arquivo vai para um caminho começado pela ORGANIZAÇÃO', async () => {
    // É esse prefixo que a policy do Storage compara para isolar os clubes.
    const upload = jest.fn().mockResolvedValue({ error: null });
    supabase.storage.from.mockReturnValue({ upload });
    await abrirAnexos();
    const entrada = document.querySelector('input[type="file"]');
    await userEvent.upload(entrada, new File(['x'], 'nota fiscal.pdf', { type: 'application/pdf' }));
    await waitFor(() => expect(upload).toHaveBeenCalled());
    expect(upload.mock.calls[0][0]).toMatch(/^org-1\/d1\//);
  });

  it('o nome do arquivo é higienizado e datado', async () => {
    // Dois comprovantes com o mesmo nome não podem se sobrescrever.
    const upload = jest.fn().mockResolvedValue({ error: null });
    supabase.storage.from.mockReturnValue({ upload });
    await abrirAnexos();
    await userEvent.upload(
      document.querySelector('input[type="file"]'),
      new File(['x'], 'nota fiscal (1).pdf', { type: 'application/pdf' })
    );
    await waitFor(() => expect(upload).toHaveBeenCalled());
    const caminho = upload.mock.calls[0][0];
    expect(caminho).not.toContain(' ');
    expect(caminho).toMatch(/\d{5,}-/);
  });

  it('sem organização no token o envio é recusado', async () => {
    // Sem o prefixo, o arquivo cairia fora do escopo da policy.
    localStorage.removeItem('supabase_token');
    const upload = jest.fn();
    supabase.storage.from.mockReturnValue({ upload });
    await abrirAnexos();
    await userEvent.upload(
      document.querySelector('input[type="file"]'),
      new File(['x'], 'a.pdf', { type: 'application/pdf' })
    );
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(upload).not.toHaveBeenCalled();
  });

  it('falha no envio avisa e não registra o metadado', async () => {
    const upload = jest.fn().mockResolvedValue({ error: new Error('bucket cheio') });
    supabase.storage.from.mockReturnValue({ upload });
    await abrirAnexos();
    api.post.mockClear();
    await userEvent.upload(
      document.querySelector('input[type="file"]'),
      new File(['x'], 'a.pdf', { type: 'application/pdf' })
    );
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(api.post).not.toHaveBeenCalled();
  });
});
