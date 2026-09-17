/**
 * Organizações — o cadastro de clubes do SaaS, só para o admin da plataforma.
 *
 * É a tela com as ações mais destrutivas do sistema, e cada uma tem uma trava
 * própria:
 *
 * - **Entrar numa organização** não é filtro de tela: é um TOKEN NOVO com o
 *   claim do clube. O isolamento passa a valer também no banco (RLS) e nas
 *   telas que falam direto com o Supabase. Por isso confirma antes.
 * - **Suspender** corta o acesso de TODOS os usuários do clube na hora.
 * - **Excluir** apaga torneios, jogadores, caixa e histórico — e só aparece
 *   depois que a organização já está suspensa, nunca para uma ativa.
 *
 * Esconder a tela de quem não é admin da plataforma é conveniência, não
 * segurança: o backend valida o mesmo claim.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Organizacoes from './Organizacoes';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { usePermissions } from '../contexts/PermissionContext';
import { currentOrgId, enterOrg } from '../utils/orgScope';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock('../components/Sidebar', () => () => <nav data-testid="sidebar" />);
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../contexts/PermissionContext', () => ({ usePermissions: jest.fn() }));
jest.mock('../components/ActivityLogTable', () => (props) => {
  props.fetchPage({ page: 1 });
  return <div data-testid="activity-log" />;
});
jest.mock('../utils/orgScope', () => ({ currentOrgId: jest.fn(), enterOrg: jest.fn() }));
jest.mock('react-i18next', () => {
  const t = (chave, segundo, terceiro) => {
    const vars = segundo && typeof segundo === 'object' ? segundo : terceiro;
    if (vars) return `${chave}:${Object.values(vars).join(',')}`;
    return typeof segundo === 'string' ? segundo : chave;
  };
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const ORGS = [
  { id: 'o1', name: 'Clube Royal', slug: 'clube-royal', status: 'active',
    plan_code: 'pro', plan_name: 'Pro', staff_count: 4, active_users: 3, max_users: 10 },
  { id: 'o2', name: 'Clube Suspenso', slug: 'clube-susp', status: 'suspended',
    plan_code: 'free', plan_name: 'Free', staff_count: 1, active_users: 1, max_users: 2 },
  { id: 'o3', name: 'Clube Cancelado', slug: 'clube-canc', status: 'cancelled',
    plan_code: 'free', plan_name: 'Free', staff_count: 0, active_users: 0, max_users: null },
];

const PLANOS = [
  { code: 'free', name: 'Free', max_users: 2, max_tournaments_month: 5,
    max_tables_tournament: 3, max_clients: 50, trial_days: 60 },
  { code: 'pro', name: 'Pro', max_users: 10, max_tournaments_month: null,
    max_tables_tournament: null, max_clients: null },
];

const EQUIPE = [
  { id: 's1', name: 'Ana', email: 'ana@royal.com', permission_group_name: 'Caixa',
    active: true, created_at: '2026-01-10T00:00:00Z' },
  { id: 's2', name: 'Beto', email: 'beto@royal.com', active: false },
];

let toast;
let confirmar;

const responder = ({ orgs = ORGS, planos = PLANOS, equipe = EQUIPE } = {}) => {
  api.get.mockImplementation((url) => {
    if (url === '/organizations') {
      return orgs instanceof Error ? Promise.reject(orgs) : Promise.resolve({ data: orgs });
    }
    if (url === '/organizations/plans') {
      return planos instanceof Error ? Promise.reject(planos) : Promise.resolve({ data: planos });
    }
    if (url.endsWith('/staff')) {
      return equipe instanceof Error ? Promise.reject(equipe) : Promise.resolve({ data: equipe });
    }
    return Promise.resolve({ data: [] });
  });
};

const montar = async (opcoes) => {
  responder(opcoes);
  render(<Organizacoes />);
  await waitFor(() => expect(document.querySelector('.skeleton-row')).toBeNull());
};

const linhaDe = (nome) =>
  Array.from(document.querySelectorAll('.org-table > tbody > tr')).find((tr) =>
    within(tr).queryByText(nome)
  );

beforeEach(() => {
  toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn() };
  confirmar = jest.fn().mockResolvedValue(true);
  useToast.mockReturnValue({ toast, confirm: confirmar });
  usePermissions.mockReturnValue({ isPlatformAdmin: true, loading: false });
  currentOrgId.mockReturnValue(null);
  enterOrg.mockResolvedValue(undefined);
  api.post.mockResolvedValue({ data: {} });
  api.patch.mockResolvedValue({ data: {} });
  api.delete.mockResolvedValue({ data: { deleted: {} } });
});

describe('quem pode ver', () => {
  it('quem não é admin da plataforma vê acesso restrito', async () => {
    usePermissions.mockReturnValue({ isPlatformAdmin: false, loading: false });
    render(<Organizacoes />);
    expect(screen.getByText('Acesso restrito')).toBeInTheDocument();
    expect(screen.getByText('Esta área é exclusiva dos administradores da plataforma.')).toBeInTheDocument();
  });

  it('sem permissão a lista nem é buscada', async () => {
    // Esconder é conveniência; não buscar evita um 403 inútil no console.
    usePermissions.mockReturnValue({ isPlatformAdmin: false, loading: false });
    render(<Organizacoes />);
    expect(api.get).not.toHaveBeenCalled();
  });

  it('enquanto as permissões carregam, nada é decidido', () => {
    usePermissions.mockReturnValue({ isPlatformAdmin: false, loading: true });
    render(<Organizacoes />);
    expect(screen.queryByText('Acesso restrito')).toBeNull();
  });

  it('403 do servidor não vira alarme na tela', async () => {
    // O backend já barrou; um toast vermelho só assustaria.
    const e = new Error('403');
    e.response = { status: 403 };
    await montar({ orgs: e });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('outros erros de carga avisam', async () => {
    const e = new Error('500');
    e.response = { status: 500 };
    await montar({ orgs: e });
    expect(toast.error).toHaveBeenCalledWith('Erro ao carregar organizações');
  });
});

describe('lista', () => {
  it('mostra nome, identificador e plano', async () => {
    await montar();
    const linha = linhaDe('Clube Royal');
    expect(within(linha).getByText('clube-royal')).toBeInTheDocument();
    expect(within(linha).getByText('Pro')).toBeInTheDocument();
  });

  it('mostra usuários ativos sobre o limite do plano', async () => {
    await montar();
    expect(within(linhaDe('Clube Royal')).getByText('3/10')).toBeInTheDocument();
  });

  it('limite ilimitado aparece como infinito, não vazio', async () => {
    await montar();
    expect(within(linhaDe('Clube Cancelado')).getByText('0/∞')).toBeInTheDocument();
  });

  it('organização no limite de usuários é sinalizada', async () => {
    // É o que explica por que o convite do próximo funcionário vai falhar.
    await montar({ orgs: [{ ...ORGS[0], active_users: 10, max_users: 10 }] });
    expect(linhaDe('Clube Royal').querySelector('.org-usage')).toHaveClass('at-limit');
  });

  it('a organização em que o admin está entra marcada', async () => {
    // Sem a marca, o admin editaria o clube errado achando que é outro.
    currentOrgId.mockReturnValue('o1');
    await montar();
    expect(within(linhaDe('Clube Royal')).getByText('Visualizando')).toBeInTheDocument();
  });

  it('lista vazia explica o que fazer', async () => {
    await montar({ orgs: [] });
    expect(screen.getByText('Nenhuma organização')).toBeInTheDocument();
    expect(screen.getByText('Cadastre o primeiro clube para começar.')).toBeInTheDocument();
  });
});

describe('trial', () => {
  const comTrial = (dias) => [{
    ...ORGS[0],
    trial_ends_at: new Date(Date.now() + dias * 86400000).toISOString(),
  }];

  it('mostra os dias que faltam', async () => {
    await montar({ orgs: comTrial(30) });
    expect(document.querySelector('.org-trial')).toHaveTextContent('organizations.trialLeft:30');
  });

  it('trial acabando ganha destaque', async () => {
    // É a janela em que o comercial precisa agir para não perder o cliente.
    await montar({ orgs: comTrial(5) });
    expect(document.querySelector('.org-trial')).toHaveClass('soon');
  });

  it('trial vencido é dito com todas as letras', async () => {
    await montar({ orgs: comTrial(-2) });
    expect(document.querySelector('.org-trial')).toHaveTextContent('Trial expirado');
    expect(document.querySelector('.org-trial')).toHaveClass('expired');
  });

  it('organização sem trial não mostra nada', async () => {
    await montar();
    expect(document.querySelector('.org-trial')).toBeNull();
  });
});

describe('funcionários por organização', () => {
  it('a lista é buscada só quando o admin abre', async () => {
    // Buscar a equipe de todas as organizações de uma vez seria caro e quase
    // sempre desperdiçado.
    await montar();
    expect(api.get).not.toHaveBeenCalledWith('/organizations/o1/staff');
    await userEvent.click(within(linhaDe('Clube Royal')).getByTitle('Ver funcionários'));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/organizations/o1/staff'));
  });

  it('mostra nome, e-mail e função de cada um', async () => {
    await montar();
    await userEvent.click(within(linhaDe('Clube Royal')).getByTitle('Ver funcionários'));
    const tabela = await waitFor(() => document.querySelector('.org-staff-table'));
    expect(within(tabela).getByText('ana@royal.com')).toBeInTheDocument();
    expect(within(tabela).getByText('Caixa')).toBeInTheDocument();
  });

  it('funcionário sem grupo mostra travessão', async () => {
    await montar();
    await userEvent.click(within(linhaDe('Clube Royal')).getByTitle('Ver funcionários'));
    await waitFor(() => expect(document.querySelector('.org-staff-nogroup')).toBeInTheDocument());
  });

  it('reabrir usa o cache, sem nova busca', async () => {
    await montar();
    const abrir = within(linhaDe('Clube Royal')).getByTitle('Ver funcionários');
    await userEvent.click(abrir);
    await waitFor(() => expect(document.querySelector('.org-staff-table')).toBeInTheDocument());
    await userEvent.click(abrir);
    const antes = api.get.mock.calls.filter((c) => c[0].endsWith('/staff')).length;
    await userEvent.click(abrir);
    await waitFor(() => expect(document.querySelector('.org-staff-table')).toBeInTheDocument());
    expect(api.get.mock.calls.filter((c) => c[0].endsWith('/staff')).length).toBe(antes);
  });

  it('organização sem equipe diz isso', async () => {
    await montar({ equipe: [] });
    await userEvent.click(within(linhaDe('Clube Royal')).getByTitle('Ver funcionários'));
    await waitFor(() => expect(document.querySelector('.org-staff-empty')).toBeInTheDocument());
  });

  it('falha ao buscar fecha de volta e avisa', async () => {
    // Deixar aberto e vazio pareceria "esse clube não tem ninguém".
    await montar({ equipe: new Error('500') });
    await userEvent.click(within(linhaDe('Clube Royal')).getByTitle('Ver funcionários'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Erro ao carregar funcionários'));
    expect(document.querySelector('.org-staff-row')).toBeNull();
  });
});

describe('acessos por organização', () => {
  it('o log é buscado só quando o admin pede, e da org certa', async () => {
    await montar();
    await userEvent.click(within(linhaDe('Clube Royal')).getByTitle('Ver funcionários'));
    await waitFor(() => document.querySelector('.org-staff-table'));
    expect(api.get).not.toHaveBeenCalledWith('/organizations/o1/activity-logs', expect.anything());

    await userEvent.click(screen.getByRole('button', { name: 'Ver acessos' }));
    expect(screen.getByTestId('activity-log')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/organizations/o1/activity-logs', { params: { page: 1 } });

    await userEvent.click(screen.getByRole('button', { name: 'Ocultar acessos' }));
    expect(screen.queryByTestId('activity-log')).toBeNull();
  });
});

describe('entrar na organização', () => {
  it('pede confirmação nomeando o clube', async () => {
    // Não é filtro de tela: é um token novo. Entrar no clube errado faria o
    // admin editar dados de outro cliente.
    await montar();
    await userEvent.click(within(linhaDe('Clube Royal')).getByRole('button', { name: 'Entrar' }));
    expect(confirmar).toHaveBeenCalledWith(
      'organizations.confirmEnter:Clube Royal',
      expect.anything()
    );
    await waitFor(() => expect(enterOrg).toHaveBeenCalledWith('o1'));
  });

  it('recusar não entra', async () => {
    confirmar.mockResolvedValue(false);
    await montar();
    await userEvent.click(within(linhaDe('Clube Royal')).getByRole('button', { name: 'Entrar' }));
    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    expect(enterOrg).not.toHaveBeenCalled();
  });

  it('a organização em que já se está não oferece "Entrar"', async () => {
    currentOrgId.mockReturnValue('o1');
    await montar();
    expect(within(linhaDe('Clube Royal')).queryByRole('button', { name: 'Entrar' })).toBeNull();
  });

  it('organização suspensa não oferece "Entrar"', async () => {
    // Entrar num clube sem acesso mostraria uma tela vazia sem explicação.
    await montar();
    expect(within(linhaDe('Clube Suspenso')).queryByRole('button', { name: 'Entrar' })).toBeNull();
  });

  it('falha ao entrar avisa e destrava o botão', async () => {
    enterOrg.mockRejectedValue({ userMessage: 'Token recusado' });
    await montar();
    await userEvent.click(within(linhaDe('Clube Royal')).getByRole('button', { name: 'Entrar' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Token recusado'));
    expect(within(linhaDe('Clube Royal')).getByRole('button', { name: 'Entrar' })).toBeEnabled();
  });
});

describe('suspender e reativar', () => {
  it('suspender avisa que todos perdem o acesso', async () => {
    await montar();
    await userEvent.click(within(linhaDe('Clube Royal')).getByRole('button', { name: 'Suspender' }));
    expect(confirmar).toHaveBeenCalledWith(
      'organizations.confirmSuspend:Clube Royal',
      expect.objectContaining({ variant: 'danger' })
    );
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/organizations/o1/status', { status: 'suspended' })
    );
  });

  it('a linha muda de status na hora, sem recarregar tudo', async () => {
    await montar();
    await userEvent.click(within(linhaDe('Clube Royal')).getByRole('button', { name: 'Suspender' }));
    await waitFor(() =>
      expect(within(linhaDe('Clube Royal')).getByRole('button', { name: 'Reativar' })).toBeInTheDocument()
    );
  });

  it('reativar devolve o acesso', async () => {
    await montar();
    await userEvent.click(within(linhaDe('Clube Suspenso')).getByRole('button', { name: 'Reativar' }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/organizations/o2/status', { status: 'active' })
    );
    expect(toast.success).toHaveBeenCalledWith('Organização reativada.');
  });

  it('organização cancelada não pode ser suspensa nem reativada', async () => {
    await montar();
    const linha = linhaDe('Clube Cancelado');
    expect(within(linha).queryByRole('button', { name: 'Suspender' })).toBeNull();
    expect(within(linha).queryByRole('button', { name: 'Reativar' })).toBeNull();
  });

  it('recusar não muda nada', async () => {
    confirmar.mockResolvedValue(false);
    await montar();
    await userEvent.click(within(linhaDe('Clube Royal')).getByRole('button', { name: 'Suspender' }));
    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('erro ao suspender avisa', async () => {
    api.patch.mockRejectedValue({ userMessage: 'Falhou' });
    await montar();
    await userEvent.click(within(linhaDe('Clube Royal')).getByRole('button', { name: 'Suspender' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Falhou'));
  });
});

describe('excluir organização', () => {
  it('organização ATIVA não pode ser excluída', async () => {
    // A exclusão só aparece depois da suspensão: é o degrau que impede
    // apagar um clube em operação por engano.
    await montar();
    expect(within(linhaDe('Clube Royal')).queryByRole('button', { name: 'Excluir' })).toBeNull();
  });

  it('organização suspensa pode ser excluída, com confirmação de perigo', async () => {
    await montar();
    await userEvent.click(within(linhaDe('Clube Suspenso')).getByRole('button', { name: 'Excluir' }));
    expect(confirmar).toHaveBeenCalledWith(
      'organizations.confirmDelete:Clube Suspenso',
      expect.objectContaining({ variant: 'danger' })
    );
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/organizations/o2'));
  });

  it('a mensagem de sucesso diz quantos registros foram apagados', async () => {
    // É a única confirmação do tamanho do estrago.
    api.delete.mockResolvedValue({ data: { deleted: { tournaments: 12, players: 300 } } });
    await montar();
    await userEvent.click(within(linhaDe('Clube Suspenso')).getByRole('button', { name: 'Excluir' }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('organizations.deleted_ok:312')
    );
  });

  it('a linha some da lista', async () => {
    await montar();
    await userEvent.click(within(linhaDe('Clube Suspenso')).getByRole('button', { name: 'Excluir' }));
    await waitFor(() => expect(linhaDe('Clube Suspenso')).toBeUndefined());
  });

  it('recusar não exclui', async () => {
    confirmar.mockResolvedValue(false);
    await montar();
    await userEvent.click(within(linhaDe('Clube Suspenso')).getByRole('button', { name: 'Excluir' }));
    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('erro ao excluir avisa', async () => {
    api.delete.mockRejectedValue({ userMessage: 'Não foi possível' });
    await montar();
    await userEvent.click(within(linhaDe('Clube Suspenso')).getByRole('button', { name: 'Excluir' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Não foi possível'));
  });
});

describe('criar organização', () => {
  const abrir = () => userEvent.click(screen.getByRole('button', { name: '+ Nova Organização' }));
  const preencher = async ({ nome = 'Clube Novo', admin = 'Dono', email = 'dono@clube.com' } = {}) => {
    if (nome) await userEvent.type(screen.getByPlaceholderText('Ex: Clube Royal Lima'), nome);
    if (admin) await userEvent.type(screen.getByPlaceholderText('Nome completo'), admin);
    if (email) await userEvent.type(screen.getByPlaceholderText('dono@clube.com'), email);
  };
  const criar = () => userEvent.click(screen.getByRole('button', { name: 'Criar e convidar' }));

  it('deixa claro que a senha não passa por aqui', async () => {
    // O dono do clube define a própria senha pelo convite.
    await montar();
    await abrir();
    expect(document.querySelector('.org-modal-hint')).toHaveTextContent('convite por e-mail');
    expect(screen.queryByLabelText(/senha/i)).toBeNull();
  });

  it.each([
    ['nome do clube', { nome: '' }],
    ['nome do administrador', { admin: '' }],
  ])('sem %s não envia', async (_rotulo, faltando) => {
    await montar();
    await abrir();
    await preencher(faltando);
    await criar();
    expect(document.querySelector('.org-error')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('e-mail inválido é recusado antes do envio', async () => {
    // O convite vai por e-mail; endereço torto some no vazio.
    await montar();
    await abrir();
    await preencher({ email: 'sem-arroba' });
    await criar();
    expect(screen.getByText('E-mail inválido')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('cria e avisa para quem foi o convite', async () => {
    await montar();
    await abrir();
    await preencher();
    await criar();
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/organizations', {
        name: 'Clube Novo', admin_name: 'Dono', admin_email: 'dono@clube.com',
        currency: 'BRL', language: 'pt-BR', plan: 'free',
      })
    );
    expect(toast.success).toHaveBeenCalledWith('organizations.created:dono@clube.com');
  });

  it('o idioma escolhido vai junto na criação', async () => {
    // Não é só a interface: o provisionamento grava os nomes dos cargos e das
    // formas de pagamento NESSE idioma, direto no banco. Um clube colombiano
    // criado sem isso nasce com "Caixa" e "Cartão" em português, e consertar
    // depois é editar registro por registro.
    await montar();
    await abrir();
    await preencher();
    await userEvent.selectOptions(document.getElementById('org-language'), 'es-ES');
    await criar();
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/organizations',
        expect.objectContaining({ language: 'es-ES' }))
    );
  });

  it('organização criada mas convite falhado avisa em amarelo, não em verde', async () => {
    // A organização existe; só o e-mail não saiu. Dizer "criada com sucesso"
    // esconderia que o dono não recebeu nada.
    api.post.mockResolvedValue({ data: { invite_error: 'SMTP recusou o envio' } });
    await montar();
    await abrir();
    await preencher();
    await criar();
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith('SMTP recusou o envio'));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('erro do servidor aparece já achatado pelo interceptor', async () => {
    // O 422 do FastAPI é uma lista de objetos; renderizá-la crua quebraria a
    // tela.
    api.post.mockRejectedValue({ userMessage: 'Slug já existe' });
    await montar();
    await abrir();
    await preencher();
    await criar();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Slug já existe'));
  });

  it('o plano escolhido mostra os limites que ele impõe', async () => {
    await montar();
    await abrir();
    expect(document.querySelector('.org-plan-hint')).toHaveTextContent('organizations.planLimits:2,5,3,50');
    expect(document.querySelector('.org-plan-hint')).toHaveTextContent('organizations.planTrial:60');
  });

  it('plano sem trial não anuncia trial', async () => {
    await montar();
    await abrir();
    await userEvent.selectOptions(document.getElementById('org-plan'), 'pro');
    expect(document.querySelector('.org-plan-hint')).not.toHaveTextContent('planTrial');
  });

  it('sem lista de planos do servidor, os quatro padrões continuam disponíveis', async () => {
    // A tela não pode ficar sem opção de plano por causa de uma consulta
    // secundária que falhou.
    await montar({ planos: [] });
    await abrir();
    // Por id, nao por posicao: a tela ganhou um seletor de idioma no meio, e
    // indice posicional passa a apontar para o campo errado sem avisar.
    expect(within(document.getElementById('org-plan')).getAllByRole('option').length).toBe(4);
  });

  it('cancelar fecha sem criar', async () => {
    await montar();
    await abrir();
    await userEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(document.querySelector('.org-modal')).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe('mudar de plano', () => {
  const abrir = async (nome) =>
    userEvent.click(within(linhaDe(nome)).getByRole('button', { name: 'Plano' }));

  it('abre já com o plano atual da organização', async () => {
    await montar();
    await abrir('Clube Royal');
    expect(screen.getByRole('combobox')).toHaveValue('pro');
  });

  it('deixa claro que mudar o plano não apaga dados', async () => {
    // O medo natural do operador é perder torneios ao rebaixar o plano.
    await montar();
    await abrir('Clube Royal');
    expect(document.querySelector('.org-modal-hint')).toHaveTextContent('organizations.changePlanHint:Clube Royal');
  });

  it('salvar envia o plano escolhido', async () => {
    await montar();
    await abrir('Clube Royal');
    await userEvent.selectOptions(screen.getByRole('combobox'), 'free');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar plano' }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/organizations/o1/plan', {
        plan_code: 'free', max_users_override: null,
      })
    );
    expect(toast.success).toHaveBeenCalledWith('Plano atualizado.');
  });

  it('limite personalizado de usuários vai como número', async () => {
    // É o acordo Premium que vence o limite do plano.
    await montar();
    await abrir('Clube Royal');
    await userEvent.type(screen.getByRole('spinbutton'), '25');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar plano' }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/organizations/o1/plan', {
        plan_code: 'pro', max_users_override: 25,
      })
    );
  });

  it('campo vazio manda nulo, para voltar ao limite do plano', async () => {
    await montar({
      orgs: [{ ...ORGS[0], max_users_override: 25 }],
    });
    await abrir('Clube Royal');
    await userEvent.clear(screen.getByRole('spinbutton'));
    await userEvent.click(screen.getByRole('button', { name: 'Salvar plano' }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        '/organizations/o1/plan',
        expect.objectContaining({ max_users_override: null })
      )
    );
  });

  it('erro ao salvar avisa e mantém o formulário aberto', async () => {
    api.patch.mockRejectedValue({ userMessage: 'Plano inexistente' });
    await montar();
    await abrir('Clube Royal');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar plano' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Plano inexistente'));
    expect(document.querySelector('.org-modal')).toBeInTheDocument();
  });

  it('cancelar fecha sem salvar', async () => {
    await montar();
    await abrir('Clube Royal');
    await userEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(document.querySelector('.org-modal')).toBeNull();
    expect(api.patch).not.toHaveBeenCalled();
  });
});

describe('módulos contratados', () => {
  // O que a tela afirma: o chip na linha diz o que o clube tem; o modal
  // liga/desliga e nunca deixa a org sem nenhum módulo (o backend também
  // recusa a lista vazia — uma org sem módulo fica com a sidebar em branco).
  const ORGS_COM_MODULOS = [
    { ...ORGS[0], modules: ['tournament', 'cash'] },
    { ...ORGS[1], modules: ['bar'] },
    { ...ORGS[2] },                       // sem a chave: org anterior ao backfill
  ];
  const abrir = async (nome) =>
    userEvent.click(within(linhaDe(nome)).getByRole('button', { name: 'Módulos' }));

  it('a linha mostra os módulos que o clube tem', async () => {
    await montar({ orgs: ORGS_COM_MODULOS });
    const royal = linhaDe('Clube Royal');
    expect(within(royal).getByText('Torneios')).toBeInTheDocument();
    expect(within(royal).getByText('Cash Game')).toBeInTheDocument();
    expect(within(royal).queryByText('Bar')).toBeNull();
    expect(within(linhaDe('Clube Suspenso')).getByText('Bar')).toBeInTheDocument();
  });

  it('org sem a chave de módulos é tratada como torneio', async () => {
    await montar({ orgs: ORGS_COM_MODULOS });
    expect(within(linhaDe('Clube Cancelado')).getByText('Torneios')).toBeInTheDocument();
  });

  it('o modal abre com o que está ligado e explica que desligar não apaga', async () => {
    await montar({ orgs: ORGS_COM_MODULOS });
    await abrir('Clube Royal');
    const caixas = screen.getAllByRole('checkbox');
    expect(caixas.map((c) => c.checked)).toEqual([true, true, false]);
    expect(document.querySelector('.org-modal-hint')).toHaveTextContent('organizations.changeModulesHint:Clube Royal');
  });

  it('ligar o bar e salvar manda a lista completa, e a linha atualiza na hora', async () => {
    api.patch.mockResolvedValue({ data: { modules: ['tournament', 'cash', 'bar'] } });
    await montar({ orgs: ORGS_COM_MODULOS });
    await abrir('Clube Royal');
    await userEvent.click(screen.getAllByRole('checkbox')[2]);
    await userEvent.click(screen.getByRole('button', { name: 'Salvar módulos' }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/organizations/o1/modules', {
        modules: ['tournament', 'cash', 'bar'],
      })
    );
    expect(toast.success).toHaveBeenCalledWith('Módulos atualizados.');
    expect(document.querySelector('.org-modal')).toBeNull();
    expect(within(linhaDe('Clube Royal')).getByText('Bar')).toBeInTheDocument();
  });

  it('desligar um módulo tira ele da lista enviada', async () => {
    api.patch.mockResolvedValue({ data: { modules: ['tournament'] } });
    await montar({ orgs: ORGS_COM_MODULOS });
    await abrir('Clube Royal');
    await userEvent.click(screen.getAllByRole('checkbox')[1]);   // cash
    await userEvent.click(screen.getByRole('button', { name: 'Salvar módulos' }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/organizations/o1/modules', { modules: ['tournament'] })
    );
    expect(within(linhaDe('Clube Royal')).queryByText('Cash Game')).toBeNull();
  });

  it('o último módulo ligado não pode ser desligado', async () => {
    await montar({ orgs: ORGS_COM_MODULOS });
    await abrir('Clube Suspenso');                                 // só bar
    const caixas = screen.getAllByRole('checkbox');
    expect(caixas[2]).toBeChecked();
    expect(caixas[2]).toBeDisabled();
    expect(screen.getByText('Ao menos um módulo precisa ficar ligado.')).toBeInTheDocument();
  });

  it('erro ao salvar avisa e mantém o modal aberto', async () => {
    api.patch.mockRejectedValue({ userMessage: 'Módulo inválido' });
    await montar({ orgs: ORGS_COM_MODULOS });
    await abrir('Clube Royal');
    await userEvent.click(screen.getAllByRole('checkbox')[2]);
    await userEvent.click(screen.getByRole('button', { name: 'Salvar módulos' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Módulo inválido'));
    expect(document.querySelector('.org-modal')).toBeInTheDocument();
  });

  it('cancelar fecha sem salvar', async () => {
    await montar({ orgs: ORGS_COM_MODULOS });
    await abrir('Clube Royal');
    await userEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(document.querySelector('.org-modal')).toBeNull();
    expect(api.patch).not.toHaveBeenCalled();
  });
});
