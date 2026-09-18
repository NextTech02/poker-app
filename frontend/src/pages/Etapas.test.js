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

/** Resumo do que a exclusão destruiria (GET /stages/:id/delete-impact). */
const responder = ({ etapas = ETAPAS, impacto = null } = {}) => {
  api.get.mockImplementation((url) => {
    if (url.includes('/delete-impact')) {
      return impacto instanceof Error
        ? Promise.reject(impacto)
        : Promise.resolve({ data: impacto || { stage_id: 'e1', stage_name: 'Etapa Rio' } });
    }
    return etapas instanceof Error
      ? Promise.reject(etapas)
      : Promise.resolve({ data: etapas });
  });
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

const campo = (nome) => document.querySelector(`.modal [name="${nome}"]`);

/** Nome, local e data de início: o mínimo que o servidor aceita. */
const preencherObrigatorios = async (inicio = '2026-07-01') => {
  await userEvent.type(screen.getByPlaceholderText('stages.namePlaceholder'), 'Nova');
  await userEvent.type(screen.getByPlaceholderText('stages.locationPlaceholder'), 'Recife');
  if (inicio) await userEvent.type(campo('start_date'), inicio);
};

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
    await userEvent.click(within(linhaDe('Etapa Rio')).getByRole('button', { name: 'Selecionar' }));
    expect(selecionarEtapa).toHaveBeenCalledWith(expect.objectContaining({ id: 'e1' }));
  });

  it('a etapa já selecionada é marcada e não oferece selecionar de novo', async () => {
    await montar(undefined, { id: 'e1' });
    expect(linhaDe('Etapa Rio')).toHaveClass('selected-row');
    expect(within(linhaDe('Etapa Rio')).queryByRole('button', { name: 'Selecionar' })).toBeNull();
    // No lugar do "Selecionar" fica um botão desabilitado indicando a atual.
    expect(within(linhaDe('Etapa Rio')).getByRole('button', { name: 'Selecionada' })).toBeDisabled();
  });
});

describe('criar etapa', () => {
  it('data de fim vazia é enviada como NULO, não string vazia', async () => {
    // ISSUE-001: string vazia fazia o FastAPI devolver 422 e a etapa não
    // era criada. O fim continua opcional — o circuito pode estar em aberto.
    await montar();
    await abrirNovo();
    await preencherObrigatorios();
    await salvar();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const corpo = api.post.mock.calls[0][1];
    expect(corpo.end_date).toBeNull();
    expect(corpo.description).toBeNull();
  });

  it('as datas preenchidas viajam como estão', async () => {
    await montar();
    await abrirNovo();
    await preencherObrigatorios('2026-07-01');
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
    await preencherObrigatorios();
    await salvar();
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/stages', expect.objectContaining({ status: 'upcoming' }))
    );
  });

  it('erro do servidor mostra o motivo', async () => {
    api.post.mockRejectedValue({ userMessage: 'Já existe etapa com esse nome' });
    await montar();
    await abrirNovo();
    await preencherObrigatorios();
    await salvar();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Já existe etapa com esse nome'));
  });

  it('erro em lista (422) não é renderizado cru', async () => {
    api.post.mockRejectedValue({ response: { data: { detail: [{ msg: 'x' }] } } });
    await montar();
    await abrirNovo();
    await preencherObrigatorios();
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

describe('datas da etapa', () => {
  /* Achados do teste de aceitação do dono do clube:
     - "foi possível criar uma etapa com data de início dia 10/08 e data final
       02/08" — etapa que termina antes de começar some do relatório por
       período e nunca aparece como "em andamento";
     - "criei uma etapa sem data de início, não sei se isso é um erro" —
       decisão do dono do produto: início OBRIGATÓRIO, fim OPCIONAL.
     A tela avisa cedo; quem decide é o backend (models/stage.py). */

  const erro = () => document.querySelector('.et-erro-data');

  it('fim antes do início não chega a ser enviado', async () => {
    await montar();
    await abrirNovo();
    await preencherObrigatorios('2026-08-10');
    await userEvent.type(campo('end_date'), '2026-08-02');
    await salvar();
    expect(api.post).not.toHaveBeenCalled();
    expect(erro()).toHaveTextContent('A data final não pode ser anterior à data de início');
  });

  it('mesmo dia de início e fim é válido', async () => {
    // Etapa de uma noite só (satélite) é rotina.
    await montar();
    await abrirNovo();
    await preencherObrigatorios('2026-08-10');
    await userEvent.type(campo('end_date'), '2026-08-10');
    await salvar();
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/stages', expect.objectContaining({
        start_date: '2026-08-10', end_date: '2026-08-10',
      }))
    );
  });

  it('sem data de início não chega a ser enviado', async () => {
    await montar();
    await abrirNovo();
    await preencherObrigatorios(null);
    await salvar();
    expect(api.post).not.toHaveBeenCalled();
    expect(erro()).toHaveTextContent('Informe a data de início da etapa');
  });

  it('corrigir a data limpa o aviso e a etapa é criada', async () => {
    await montar();
    await abrirNovo();
    await preencherObrigatorios('2026-08-10');
    await userEvent.type(campo('end_date'), '2026-08-02');
    await salvar();
    expect(erro()).not.toBeNull();

    await userEvent.clear(campo('end_date'));
    await userEvent.type(campo('end_date'), '2026-08-20');
    await salvar();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(erro()).toBeNull();
  });

  it('o campo de fim não deixa escolher data anterior ao início', async () => {
    // Trava do próprio seletor de data: o erro nem chega a acontecer.
    await montar();
    await abrirNovo();
    await preencherObrigatorios('2026-08-10');
    expect(campo('end_date')).toHaveAttribute('min', '2026-08-10');
  });

  it('editar invertendo as datas também é barrado', async () => {
    await montar();
    await userEvent.click(within(linhaDe('Etapa Rio')).getByRole('button', { name: 'common.edit' }));
    await userEvent.clear(campo('end_date'));
    await userEvent.type(campo('end_date'), '2020-01-01');
    await salvar();
    expect(api.patch).not.toHaveBeenCalled();
  });
});

describe('etapa antiga sem data de início', () => {
  /* Existem etapas assim na base, criadas antes da regra. Elas não podem
     quebrar: continuam listadas e operáveis. A data é PEDIDA na edição, que é
     o único momento em que dá para informá-la. */
  const SEM_DATA = [{ id: 'e7', name: 'Etapa Legada', location: 'Natal',
    status: 'upcoming', tournament_count: 2 }];

  const editarLegada = async () => {
    await montar({ etapas: SEM_DATA });
    await userEvent.click(within(linhaDe('Etapa Legada')).getByRole('button', { name: 'common.edit' }));
  };

  it('continua listada e operável', async () => {
    await montar({ etapas: SEM_DATA });
    expect(linhaDe('Etapa Legada')).toBeInTheDocument();
    await userEvent.click(within(linhaDe('Etapa Legada')).getByRole('button', { name: 'Selecionar' }));
    expect(selecionarEtapa).toHaveBeenCalledWith(expect.objectContaining({ id: 'e7' }));
  });

  it('ao editar, a tela explica que falta a data', async () => {
    await editarLegada();
    expect(document.querySelector('.et-aviso-data')).toHaveTextContent(
      'Esta etapa foi criada sem data de início'
    );
  });

  it('salvar sem informar a data não envia nada ao servidor', async () => {
    await editarLegada();
    const nome = screen.getByPlaceholderText('stages.namePlaceholder');
    await userEvent.clear(nome);
    await userEvent.type(nome, 'Etapa Legada 2026');
    await salvar();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('informando a data, a edição vai adiante', async () => {
    await editarLegada();
    await userEvent.type(campo('start_date'), '2026-08-02');
    await salvar();
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/stages/e7', expect.objectContaining({
        start_date: '2026-08-02',
      }))
    );
  });
});

describe('exclusão de etapa: o que vai junto', () => {
  /* As FKs para `stages` são ON DELETE CASCADE: apagar a etapa apaga
     sangrias, despesas, outras receitas, pagamentos de funcionário, caixas,
     tipos de buy e consignações de ficha. Dinheiro apagado não volta e não há
     desfazer, então a confirmação precisa dizer o que será destruído — e,
     havendo movimento, a exclusão nem é oferecida. */

  const pedirExclusao = async (impacto) => {
    await montar({ impacto });
    await userEvent.click(within(linhaDe('Etapa Rio')).getByRole('button', { name: 'common.edit' }));
    await userEvent.click(screen.getByRole('button', { name: 'common.delete' }));
    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    return confirmar.mock.calls[0][0];
  };

  it('a confirmação mostra os números reais do que será apagado', async () => {
    const texto = await pedirExclusao({
      stage_id: 'e1', stage_name: 'Etapa Rio',
      sangrias: 3, expenses: 12, cash_balance: 4500, blocked: false,
    });
    expect(texto).toContain('3 sangrias');
    expect(texto).toContain('12 despesas');
    expect(texto).toContain('4.500,00');
  });

  it('só o que existe entra na frase', async () => {
    const texto = await pedirExclusao({
      stage_id: 'e1', stage_name: 'Etapa Rio', buy_types: 2, blocked: false,
    });
    expect(texto).toContain('2 meios de entrada');
    expect(texto).not.toContain('0 ');
  });

  it('avisa que os torneios ficam sem etapa', async () => {
    // A FK dos torneios é SET NULL: eles não somem, mas perdem o vínculo.
    const texto = await pedirExclusao({
      stage_id: 'e1', stage_name: 'Etapa Rio', tournaments: 4, buy_types: 1, blocked: false,
    });
    expect(texto).toContain('4 torneios ficam sem etapa');
  });

  it('etapa vazia mantém a confirmação simples de sempre', async () => {
    const texto = await pedirExclusao({ stage_id: 'e1', stage_name: 'Etapa Rio', blocked: false });
    expect(texto).toBe('stages.confirmDelete');
  });

  it('confirmada, a exclusão acontece', async () => {
    await pedirExclusao({ stage_id: 'e1', stage_name: 'Etapa Rio', expenses: 1, blocked: false });
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/stages/e1'));
  });

  it('servidor antigo sem a rota de impacto não impede a exclusão', async () => {
    // O deploy não é atômico: a tela nova pode chegar antes do backend.
    const texto = await pedirExclusao(new Error('404'));
    expect(texto).toBe('stages.confirmDelete');
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/stages/e1'));
  });
});

describe('etapa com movimento financeiro não se apaga', () => {
  const COM_MOVIMENTO = {
    stage_id: 'e1', stage_name: 'Etapa Rio',
    sangrias: 3, expenses: 12, cash_balance: 4500, blocked: true,
  };

  const pedirExclusao = async (impacto = COM_MOVIMENTO) => {
    await montar({ impacto });
    await userEvent.click(within(linhaDe('Etapa Rio')).getByRole('button', { name: 'common.edit' }));
    await userEvent.click(screen.getByRole('button', { name: 'common.delete' }));
    await waitFor(() => expect(confirmar).toHaveBeenCalled());
  };

  it('a exclusão não é nem tentada', async () => {
    await pedirExclusao();
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('o motivo vem com os números e o convite a arquivar', async () => {
    await pedirExclusao();
    const texto = confirmar.mock.calls[0][0];
    expect(texto).toContain('3 sangrias');
    expect(texto).toContain('4.500,00');
    expect(texto).toContain('arquivar');
  });

  it('aceitando, a etapa é arquivada em vez de apagada', async () => {
    await pedirExclusao();
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/stages/e1/archive'));
    expect(api.delete).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('Etapa arquivada');
  });

  it('recusando, nada acontece', async () => {
    confirmar.mockResolvedValue(false);
    await pedirExclusao();
    expect(api.post).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('falha ao arquivar é avisada', async () => {
    api.post.mockRejectedValue({ response: { data: { detail: 'Etapa não encontrada' } } });
    await pedirExclusao();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Etapa não encontrada'));
  });
});

describe('a data mostrada é a data cadastrada', () => {
  /* O banco guarda "AAAA-MM-DD" e `new Date('2026-08-10')` é meia-noite UTC —
     que no Brasil, no Peru e na Colômbia é ainda dia 09. O clube cadastrava
     10/08 e a lista mostrava 09/08; pior, no ÚLTIMO dia a etapa já aparecia
     como "Concluída" e sumia das ativas. */

  /** Data local (não UTC) no formato do banco, deslocada de `n` dias. */
  const localEmDias = (n) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    const mes = String(d.getMonth() + 1).padStart(2, '0');
    const dia = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mes}-${dia}`;
  };

  it('a data da lista é exatamente a que foi cadastrada', async () => {
    await montar({
      etapas: [{ id: 'e9', name: 'Etapa Fuso', location: 'Bogotá', status: 'upcoming',
        start_date: '2026-08-10', end_date: '2026-08-20' }],
    });
    const linha = linhaDe('Etapa Fuso');
    expect(linha).toHaveTextContent('10/08/2026');
    expect(linha).toHaveTextContent('20/08/2026');
  });

  it('no último dia a etapa ainda está EM ANDAMENTO', async () => {
    // É o dia do evento: sumir das ativas justamente hoje é o pior momento.
    await montar({
      etapas: [{ id: 'e9', name: 'Último Dia', location: 'Lima', status: 'upcoming',
        start_date: localEmDias(-3), end_date: localEmDias(0) }],
    });
    expect(within(linhaDe('Último Dia')).getByText('Em Andamento')).toBeInTheDocument();
  });

  it('a etapa que começa hoje já entra EM ANDAMENTO', async () => {
    await montar({
      etapas: [{ id: 'e9', name: 'Começa Hoje', location: 'Lima', status: 'upcoming',
        start_date: localEmDias(0), end_date: localEmDias(2) }],
    });
    expect(within(linhaDe('Começa Hoje')).getByText('Em Andamento')).toBeInTheDocument();
  });
});

describe('filtro e busca', () => {
  /* A barra de ferramentas do redesign: filtro segmentado por status e busca
     por nome/local. "Ativas" = em andamento + próximas; "Arquivadas" são as
     canceladas (arquivar é marcar cancelada). O filtro nunca some com a
     etapa atual do servidor — só com o que está na tela. */
  const nomes = () =>
    Array.from(document.querySelectorAll('tbody tr strong')).map((el) => el.textContent);

  it('começa em "Todas" e mostra quantas etapas há', async () => {
    await montar();
    expect(screen.getByRole('button', { name: 'Todas' })).toHaveAttribute('aria-pressed', 'true');
    expect(nomes()).toEqual(['Etapa Rio', 'Etapa SP', 'Etapa Antiga', 'Etapa Cancelada']);
  });

  it('"Ativas" deixa só o que ainda vai ser operado', async () => {
    await montar();
    await userEvent.click(screen.getByRole('button', { name: 'Ativas' }));
    expect(nomes()).toEqual(['Etapa Rio', 'Etapa SP']);
  });

  it('"Concluídas" e "Arquivadas" separam o passado do que foi tirado da frente', async () => {
    await montar();
    await userEvent.click(screen.getByRole('button', { name: 'Concluídas' }));
    expect(nomes()).toEqual(['Etapa Antiga']);
    await userEvent.click(screen.getByRole('button', { name: 'Arquivadas' }));
    expect(nomes()).toEqual(['Etapa Cancelada']);
    // Arquivada não vende mais: a chave-mestra de vendas não aparece.
    expect(screen.queryByRole('button', { name: 'Encerrar vendas' })).toBeNull();
  });

  it('busca por nome ou local, sem diferenciar maiúsculas', async () => {
    await montar();
    await userEvent.type(screen.getByPlaceholderText('Buscar etapa…'), 'são paulo');
    expect(nomes()).toEqual(['Etapa SP']);
  });

  it('filtro sem resultado avisa em vez de deixar a tabela vazia', async () => {
    await montar();
    await userEvent.type(screen.getByPlaceholderText('Buscar etapa…'), 'Manaus');
    expect(nomes()).toEqual([]);
    expect(screen.getByText('Nenhuma etapa corresponde ao filtro.')).toBeInTheDocument();
    // Não é o estado "sem etapa nenhuma": o clube tem etapas, só não bateu.
    expect(screen.queryByText('Nenhuma etapa encontrada')).toBeNull();
  });

  it('a etapa atual leva a pílula "Etapa Atual" ao lado do nome', async () => {
    await montar(undefined, { id: 'e1' });
    expect(within(linhaDe('Etapa Rio')).getByText('Etapa Atual')).toBeInTheDocument();
    expect(within(linhaDe('Etapa SP')).queryByText('Etapa Atual')).toBeNull();
  });
});

describe('ordem da lista', () => {
  it('em andamento, depois as próximas (mais perto primeiro), depois as passadas (mais recente primeiro), arquivadas por último', async () => {
    // O servidor manda por data de criação; quem opera quer ver primeiro o
    // que está acontecendo e o que vem aí.
    await montar({
      etapas: [
        { id: 'a', name: 'Antiga 1', location: 'X', status: 'upcoming', start_date: emDias(-90), end_date: emDias(-85) },
        { id: 'b', name: 'Arquivada', location: 'X', status: 'cancelled', start_date: emDias(-10), end_date: emDias(-5) },
        { id: 'c', name: 'Longe', location: 'X', status: 'upcoming', start_date: emDias(60), end_date: emDias(62) },
        { id: 'd', name: 'Agora', location: 'X', status: 'upcoming', start_date: emDias(-1), end_date: emDias(1) },
        { id: 'e', name: 'Perto', location: 'X', status: 'upcoming', start_date: emDias(10), end_date: emDias(12) },
        { id: 'f', name: 'Antiga 2', location: 'X', status: 'upcoming', start_date: emDias(-30), end_date: emDias(-25) },
      ],
    });
    const nomes = Array.from(document.querySelectorAll('tbody tr strong')).map((el) => el.textContent);
    expect(nomes).toEqual(['Agora', 'Perto', 'Longe', 'Antiga 2', 'Antiga 1', 'Arquivada']);
  });
});

describe('vendas encerradas na lista', () => {
  it('a etapa bloqueada mostra o aviso ao lado do status', async () => {
    // A chave-mestra virou um ícone: o estado precisa continuar legível de
    // longe, na coluna de status.
    await montar({ etapas: [{ ...ETAPAS[0], sales_blocked: true }, ETAPAS[1]] });
    expect(within(linhaDe('Etapa Rio')).getByText('Vendas encerradas')).toBeInTheDocument();
    expect(within(linhaDe('Etapa SP')).queryByText('Vendas encerradas')).toBeNull();
  });
});
