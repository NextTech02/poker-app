/**
 * Etapas — o contêiner de tudo o que o clube opera.
 *
 * Toda operação do sistema é escopada por etapa (o header `X-Stage-ID`), então
 * a escolha feita aqui decide o que as outras telas enxergam. Dois cuidados
 * dominam os testes:
 *
 * - **O status vem das DATAS, não do campo salvo** (ISSUE-002). Uma etapa
 *   marcada como "Próxima" cuja data final já passou estava aparecendo como
 *   futura para sempre — ninguém volta no cadastro para mudar o status à mão.
 *   `cancelada` e `concluída` são terminais e não são sobrescritas: foram
 *   decisões explícitas de alguém.
 * - **Data vazia é enviada como NULO** (ISSUE-001). String vazia fazia o
 *   FastAPI devolver 422 e a etapa simplesmente não era criada.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Etapas from './Etapas';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useStage } from '../contexts/StageContext';
import { usePermissions } from '../contexts/PermissionContext';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock('../components/Sidebar', () => () => <nav data-testid="sidebar" />);
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../contexts/StageContext', () => ({ useStage: jest.fn() }));
jest.mock('../contexts/PermissionContext', () => ({ usePermissions: jest.fn() }));
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => jest.fn(),
}));
jest.mock('react-i18next', () => {
  const t = (chave, segundo) => (typeof segundo === 'string' ? segundo : chave);
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

/** Datas relativas a hoje, para o cálculo de status não depender do calendário. */
const emDias = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

const ETAPAS = [
  { id: 'e1', name: 'Etapa Rio', location: 'Rio', status: 'upcoming',
    start_date: emDias(-10), end_date: emDias(10), tournament_count: 3,
    description: 'Circuito de verão' },
  { id: 'e2', name: 'Etapa SP', location: 'São Paulo', status: 'upcoming',
    start_date: emDias(30), end_date: emDias(40), tournament_count: 0 },
  { id: 'e3', name: 'Etapa Antiga', location: 'BH', status: 'upcoming',
    start_date: emDias(-60), end_date: emDias(-30), tournament_count: 5 },
  { id: 'e4', name: 'Etapa Cancelada', location: 'Curitiba', status: 'cancelled',
    start_date: emDias(-5), end_date: emDias(5), tournament_count: 0 },
];

let toast;
let confirmar;
let selecionarEtapa;

const responder = ({ etapas = ETAPAS } = {}) => {
  api.get.mockImplementation(() =>
    etapas instanceof Error ? Promise.reject(etapas) : Promise.resolve({ data: etapas })
  );
};

const montar = async (opcoes, etapaAtual = null) => {
  responder(opcoes);
  useStage.mockReturnValue({ selectedStage: etapaAtual, selectStage: selecionarEtapa });
  render(<MemoryRouter><Etapas /></MemoryRouter>);
  await waitFor(() => expect(document.querySelector('.skeleton-row')).toBeNull());
};

const linhaDe = (nome) =>
  Array.from(document.querySelectorAll('tbody tr')).find((tr) =>
    within(tr).queryByText(nome)
  );

const abrirNovo = () => userEvent.click(screen.getByRole('button', { name: /Nova Etapa/ }));
const salvar = () => userEvent.click(document.querySelector('.modal button[type="submit"]'));

beforeEach(() => {
  toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn() };
  confirmar = jest.fn().mockResolvedValue(true);
  selecionarEtapa = jest.fn();
  useToast.mockReturnValue({ toast, confirm: confirmar });
  usePermissions.mockReturnValue({ isAdmin: true, hasPermission: () => true });
  api.post.mockResolvedValue({ data: {} });
  api.patch.mockResolvedValue({ data: {} });
  api.delete.mockResolvedValue({ data: {} });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => console.error.mockRestore());

describe('status calculado pelas datas', () => {
  it('etapa em curso aparece como EM ANDAMENTO, mesmo salva como "próxima"', async () => {
    // ISSUE-002: ninguém volta no cadastro para mudar o status à mão.
    await montar();
    expect(within(linhaDe('Etapa Rio')).getByText('Em Andamento')).toBeInTheDocument();
  });

  it('etapa que ainda vai começar continua como PRÓXIMA', async () => {
    await montar();
    expect(within(linhaDe('Etapa SP')).getByText('Próxima')).toBeInTheDocument();
  });

  it('etapa cuja data final já passou aparece como CONCLUÍDA', async () => {
    await montar();
    expect(within(linhaDe('Etapa Antiga')).getByText('Concluída')).toBeInTheDocument();
  });

  it('CANCELADA é terminal e não é sobrescrita pelas datas', async () => {
    // Foi uma decisão explícita de alguém; as datas não a desfazem.
    await montar();
    expect(within(linhaDe('Etapa Cancelada')).getByText('Cancelada')).toBeInTheDocument();
  });

  it('CONCLUÍDA também é terminal', async () => {
    await montar({
      etapas: [{ id: 'e9', name: 'Fechada', location: 'X', status: 'completed',
        start_date: emDias(-1), end_date: emDias(10) }],
    });
    expect(within(linhaDe('Fechada')).getByText('Concluída')).toBeInTheDocument();
  });

  it('etapa sem datas cai em próxima', async () => {
    // Sem data não há como afirmar que começou.
    await montar({ etapas: [{ id: 'e9', name: 'Sem datas', location: 'X', status: 'upcoming' }] });
    expect(within(linhaDe('Sem datas')).getByText('Próxima')).toBeInTheDocument();
  });

  it('etapa aberta sem data de fim segue em andamento', async () => {
    await montar({
      etapas: [{ id: 'e9', name: 'Aberta', location: 'X', status: 'upcoming',
        start_date: emDias(-3) }],
    });
    expect(within(linhaDe('Aberta')).getByText('Em Andamento')).toBeInTheDocument();
  });
});

describe('lista', () => {
  it('mostra local, período e número de torneios', async () => {
    await montar();
    const linha = linhaDe('Etapa Rio');
    expect(linha).toHaveTextContent('Rio');
    expect(linha).toHaveTextContent('3');
  });

  it('etapa sem torneio mostra zero, não vazio', async () => {
    await montar();
    expect(linhaDe('Etapa SP')).toHaveTextContent('0');
  });

  it('a descrição aparece junto do nome', async () => {
    await montar();
    expect(linhaDe('Etapa Rio')).toHaveTextContent('Circuito de verão');
  });

  it('data ausente vira travessão', async () => {
    await montar({ etapas: [{ id: 'e9', name: 'Sem datas', location: 'X', status: 'upcoming' }] });
    expect(within(linhaDe('Sem datas')).getAllByText('-').length).toBe(2);
  });

  it('sem etapa nenhuma convida a criar a primeira', async () => {
    await montar({ etapas: [] });
    expect(screen.getByText('Nenhuma etapa encontrada')).toBeInTheDocument();
  });

  it('falha ao carregar não deixa a tela presa', async () => {
    await montar({ etapas: new Error('500') });
    expect(document.querySelector('.skeleton-row')).toBeNull();
  });
});

describe('escolher a etapa de trabalho', () => {
  it('selecionar troca o escopo do sistema inteiro', async () => {
    // Toda operação viaja com o X-Stage-ID desta escolha.
    await montar();
    await userEvent.click(within(linhaDe('Etapa Rio')).getByRole('button', { name: 'stages.selectStage' }));
    expect(selecionarEtapa).toHaveBeenCalledWith(expect.objectContaining({ id: 'e1' }));
  });

  it('a etapa já selecionada é marcada e não oferece selecionar de novo', async () => {
    await montar(undefined, { id: 'e1' });
    expect(linhaDe('Etapa Rio')).toHaveClass('selected-row');
    expect(within(linhaDe('Etapa Rio')).queryByRole('button', { name: 'stages.selectStage' })).toBeNull();
    // No lugar do "Selecionar" fica um botão desabilitado indicando a atual.
    expect(within(linhaDe('Etapa Rio')).getByRole('button', { name: 'common.active' })).toBeDisabled();
  });
});

describe('criar etapa', () => {
  it('data vazia é enviada como NULO, não string vazia', async () => {
    // ISSUE-001: string vazia fazia o FastAPI devolver 422 e a etapa não
    // era criada.
    await montar();
    await abrirNovo();
    await userEvent.type(screen.getByPlaceholderText('stages.namePlaceholder'), 'Nova');
    await userEvent.type(screen.getByPlaceholderText('stages.locationPlaceholder'), 'Recife');
    await salvar();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const corpo = api.post.mock.calls[0][1];
    expect(corpo.start_date).toBeNull();
    expect(corpo.end_date).toBeNull();
    expect(corpo.description).toBeNull();
  });

  it('as datas preenchidas viajam como estão', async () => {
    await montar();
    await abrirNovo();
    await userEvent.type(screen.getByPlaceholderText('stages.namePlaceholder'), 'Nova');
    await userEvent.type(screen.getByPlaceholderText('stages.locationPlaceholder'), 'Recife');
    await userEvent.type(document.querySelector('input[name="start_date"]'), '2026-07-01');
    await salvar();
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/stages', expect.objectContaining({
        start_date: '2026-07-01',
      }))
    );
    expect(toast.success).toHaveBeenCalledWith('stages.createdSuccess');
  });

  it('a nova etapa nasce como "próxima"', async () => {
    await montar();
    await abrirNovo();
    await userEvent.type(screen.getByPlaceholderText('stages.namePlaceholder'), 'Nova');
    await userEvent.type(screen.getByPlaceholderText('stages.locationPlaceholder'), 'Recife');
    await salvar();
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/stages', expect.objectContaining({ status: 'upcoming' }))
    );
  });

  it('erro do servidor mostra o motivo', async () => {
    api.post.mockRejectedValue({ userMessage: 'Já existe etapa com esse nome' });
    await montar();
    await abrirNovo();
    await userEvent.type(screen.getByPlaceholderText('stages.namePlaceholder'), 'Nova');
    await userEvent.type(screen.getByPlaceholderText('stages.locationPlaceholder'), 'Recife');
    await salvar();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Já existe etapa com esse nome'));
  });

  it('erro em lista (422) não é renderizado cru', async () => {
    api.post.mockRejectedValue({ response: { data: { detail: [{ msg: 'x' }] } } });
    await montar();
    await abrirNovo();
    await userEvent.type(screen.getByPlaceholderText('stages.namePlaceholder'), 'Nova');
    await userEvent.type(screen.getByPlaceholderText('stages.locationPlaceholder'), 'Recife');
    await salvar();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('stages.saveError'));
  });

  it('cancelar fecha sem criar', async () => {
    await montar();
    await abrirNovo();
    await userEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(document.querySelector('.modal')).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe('editar etapa', () => {
  const editar = async (nome) =>
    userEvent.click(within(linhaDe(nome)).getByRole('button', { name: 'common.edit' }));

  it('abre com os dados atuais', async () => {
    await montar();
    await editar('Etapa Rio');
    expect(screen.getByPlaceholderText('stages.namePlaceholder')).toHaveValue('Etapa Rio');
    expect(screen.getByPlaceholderText('stages.locationPlaceholder')).toHaveValue('Rio');
  });

  it('campos ausentes viram vazio, não "undefined"', async () => {
    await montar();
    await editar('Etapa SP');
    expect(document.querySelector('textarea[name="description"]')).toHaveValue('');
  });

  it('salvar usa PATCH na etapa certa', async () => {
    await montar();
    await editar('Etapa Rio');
    const nome = screen.getByPlaceholderText('stages.namePlaceholder');
    await userEvent.clear(nome);
    await userEvent.type(nome, 'Etapa Rio 2026');
    await salvar();
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/stages/e1', expect.objectContaining({
        name: 'Etapa Rio 2026',
      }))
    );
    expect(toast.success).toHaveBeenCalledWith('stages.updatedSuccess');
  });

  it('o status pode ser mudado à mão, e vira terminal', async () => {
    // É como o operador encerra uma etapa antes da data prevista.
    await montar();
    await editar('Etapa Rio');
    await userEvent.selectOptions(document.querySelector('select[name="status"]'), 'cancelled');
    await salvar();
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/stages/e1', expect.objectContaining({
        status: 'cancelled',
      }))
    );
  });

  it('excluir só existe na edição, e pede confirmação', async () => {
    // Um botão de excluir na linha da tabela seria clique fácil demais para
    // uma ação que leva torneios junto.
    await montar();
    expect(within(linhaDe('Etapa Rio')).queryByRole('button', { name: 'common.delete' })).toBeNull();
    await editar('Etapa Rio');
    await userEvent.click(screen.getByRole('button', { name: 'common.delete' }));
    expect(confirmar).toHaveBeenCalledWith(
      'stages.confirmDelete',
      expect.objectContaining({ variant: 'danger' })
    );
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/stages/e1'));
  });

  it('recusar não exclui', async () => {
    confirmar.mockResolvedValue(false);
    await montar();
    await editar('Etapa Rio');
    await userEvent.click(screen.getByRole('button', { name: 'common.delete' }));
    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('erro ao excluir avisa', async () => {
    api.delete.mockRejectedValue(new Error('409'));
    await montar();
    await editar('Etapa Rio');
    await userEvent.click(screen.getByRole('button', { name: 'common.delete' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('stages.deleteError'));
  });
});


describe('bloqueio de vendas da etapa', () => {
  /** A tabela e os cartões do celular renderizam a mesma etapa: o primeiro
   *  botão é o da linha da tabela. */
  const botao = (nome) => screen.getAllByRole('button', { name: nome })[0];

  it('encerra a venda em toda a etapa depois de confirmar', async () => {
    await montar();
    await userEvent.click(botao('Encerrar vendas'));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/stages/e1/sales-block', { blocked: true, reason: null })
    );
  });

  it('desistir da confirmação não encerra nada', async () => {
    // Encerrar a venda no meio do evento por um clique errado deixaria a fila
    // do caixa parada sem ninguém entender por quê.
    confirmar.mockResolvedValue(false);
    await montar();
    await userEvent.click(botao('Encerrar vendas'));
    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    expect(api.post).not.toHaveBeenCalled();
  });

  it('etapa bloqueada oferece liberar de volta', async () => {
    await montar({ etapas: [{ ...ETAPAS[0], sales_blocked: true }] });
    await userEvent.click(botao('Liberar vendas'));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/stages/e1/sales-block', { blocked: false, reason: null })
    );
  });

  it('erro do servidor é mostrado', async () => {
    api.post.mockRejectedValue({ response: { data: { detail: 'Sem permissão para bloquear vendas' } } });
    await montar();
    await userEvent.click(botao('Encerrar vendas'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Sem permissão para bloquear vendas')
    );
  });

  it('quem não administra caixa nem vê o botão', async () => {
    // O backend exige CashboxService.can_admin. Mostrar o botão a quem ele
    // recusa faz o usuário clicar no meio do evento, levar "Sem permissão para
    // bloquear vendas" e ficar sem saber se as vendas pararam ou não.
    usePermissions.mockReturnValue({ isAdmin: false, hasPermission: () => false });
    await montar();
    expect(screen.queryByRole('button', { name: 'Encerrar vendas' })).toBeNull();
  });

  it('quem só tem o financeiro também não vê', async () => {
    // 'financial' NÃO é permissão de caixa: o servidor recusa.
    usePermissions.mockReturnValue({
      isAdmin: false,
      hasPermission: (p) => p === 'financial',
    });
    await montar();
    expect(screen.queryByRole('button', { name: 'Encerrar vendas' })).toBeNull();
  });
});
