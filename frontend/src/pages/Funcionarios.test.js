/**
 * Funcionários — quem entra no clube, o que pode fazer e quanto recebe.
 *
 * A tela junta três assuntos com riscos diferentes:
 *
 * - **Convite.** O admin NÃO cria senha para ninguém: manda um e-mail e a
 *   pessoa define nome e senha. Por isso existem dois estados de convite com
 *   causas distintas (já tinha conta × conta nova), e num convite pendente a
 *   ação que cabe é desfazer, não "ativar" alguém que ainda não aceitou.
 * - **Exclusão.** Quem tem lançamento financeiro NÃO é apagado — é desativado.
 *   Apagar mudaria o resultado de etapas já fechadas. A tela precisa dizer
 *   qual dos três desfechos aconteceu.
 * - **Pagamento.** Pagar debita o caixa geral de verdade; estornar devolve.
 *   Pagar acima do saldo é recusado antes de sair qualquer escrita.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Funcionarios from './Funcionarios';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useStage } from '../contexts/StageContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { usePermissions } from '../contexts/PermissionContext';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock('../components/Sidebar', () => () => <nav data-testid="sidebar" />);
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../contexts/StageContext', () => ({ useStage: jest.fn() }));
jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));
jest.mock('../contexts/PermissionContext', () => ({ usePermissions: jest.fn() }));
// A tabela do log tem teste próprio; aqui só interessa se a aba existe e o
// que ela pede ao backend.
jest.mock('../components/ActivityLogTable', () => (props) => {
  props.fetchPage({ page: 1 });
  return <div data-testid="activity-log" />;
});

// Fake do supabase-js: a aba de pagamentos escreve DIRETO na base, sem passar
// pelo backend. O fake registra cada operação para os testes conferirem o que
// foi gravado — em especial o débito no caixa geral.
const mockBase = { dados: {}, chamadas: [], erro: null };
jest.mock('../config/supabase', () => {
  const criar = (tabela) => {
    const estado = { tabela, op: 'select', payload: null, filtros: {}, unico: false };
    const b = {};
    b.select = () => b;
    b.limit = () => b;
    b.eq = (coluna, valor) => { estado.filtros[coluna] = valor; return b; };
    b.single = () => { estado.unico = true; return b; };
    b.insert = (payload) => { estado.op = 'insert'; estado.payload = payload; return b; };
    b.update = (payload) => { estado.op = 'update'; estado.payload = payload; return b; };
    b.delete = () => { estado.op = 'delete'; return b; };
    b.then = (aoResolver, aoRejeitar) => {
      mockBase.chamadas.push({ ...estado, filtros: { ...estado.filtros } });
      if (mockBase.erro) return Promise.reject(mockBase.erro).then(aoResolver, aoRejeitar);
      const linhas = mockBase.dados[tabela] || [];
      const data = estado.op === 'select' ? (estado.unico ? linhas[0] || null : linhas) : null;
      return Promise.resolve({ data, error: null }).then(aoResolver, aoRejeitar);
    };
    return b;
  };
  return { supabase: { from: criar } };
});

jest.mock('react-i18next', () => {
  const t = (chave, segundo, terceiro) => {
    const vars = segundo && typeof segundo === 'object' ? segundo : terceiro;
    if (vars) return `${chave}:${Object.values(vars).join(',')}`;
    return typeof segundo === 'string' ? segundo : chave;
  };
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

// Davi reproduz o caso relatado: convite pendente fica `active: false` no
// banco de proposito (quem nao aceitou nao ocupa vaga do plano). Era isso que
// fazia a tela mostrar "convite pendente" E "desativado" na mesma linha, e
// escondia a pessoa atras do filtro de desativados.
const EQUIPE = [
  { id: 's1', name: 'Ana', email: 'ana@clube.com', active: true, permission_group_id: 'g1' },
  { id: 's2', name: 'Beto', email: 'beto@clube.com', active: false, permission_group_id: null },
  { id: 's3', name: 'Carla', email: 'carla@clube.com', active: true, invite_status: 'awaiting_signup' },
  { id: 's4', name: 'Davi', email: 'davi@clube.com', active: false, invite_status: 'pending' },
];

const GRUPOS = [
  { id: 'g1', name: 'Caixa', description: 'Opera o caixa', permissions: ['cashier', 'players'] },
  { id: 'g2', name: 'Somente leitura', description: null, permissions: [] },
];

const ETAPA = { id: 'e1', name: 'Etapa 1' };

let toast;
let confirmar;

const responder = ({
  equipe = EQUIPE,
  grupos = GRUPOS,
  torneios = [{ id: 't1' }],
  resumos = { t1: { reserved_purpose: 'staff', reserved_amount: 5000 } },
} = {}) => {
  api.get.mockImplementation((url) => {
    if (url === '/staff') {
      return equipe instanceof Error ? Promise.reject(equipe) : Promise.resolve({ data: equipe });
    }
    if (url === '/staff/groups') return Promise.resolve({ data: grupos });
    if (url === '/tournaments') return Promise.resolve({ data: torneios });
    const m = url.match(/^\/tournaments\/(.+)\/prizes\/summary$/);
    if (m) {
      const r = resumos[m[1]];
      return r ? Promise.resolve({ data: r }) : Promise.reject(new Error('404'));
    }
    return Promise.resolve({ data: [] });
  });
};

const montar = async (opcoes) => {
  responder(opcoes);
  render(<Funcionarios />);
  await waitFor(() => expect(document.querySelector('.skeleton-row')).toBeNull());
};

const irPara = async (chave) => userEvent.click(screen.getByRole('button', { name: chave }));

const linhaDe = (nome) =>
  Array.from(document.querySelectorAll('tbody tr')).find((tr) => within(tr).queryByText(nome));

beforeEach(() => {
  mockBase.dados = {
    general_cash_register: [{ id: 'gc1', current_balance: '20000' }],
    staff_payments: [],
  };
  mockBase.chamadas = [];
  mockBase.erro = null;
  toast = { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() };
  confirmar = jest.fn().mockResolvedValue(true);
  useToast.mockReturnValue({ toast, confirm: confirmar });
  useStage.mockReturnValue({ selectedStage: ETAPA });
  useCurrency.mockReturnValue({ formatCurrency: (v) => `R$ ${Number(v || 0).toFixed(2)}` });
  usePermissions.mockReturnValue({ hasPermission: () => false });
  api.post.mockResolvedValue({ data: {} });
  api.patch.mockResolvedValue({ data: {} });
  api.delete.mockResolvedValue({ data: { acao: 'removido' } });
  jest.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => window.confirm.mockRestore());

describe('lista da equipe', () => {
  it('mostra nome e e-mail de cada um', async () => {
    await montar();
    expect(screen.getByText('ana@clube.com')).toBeInTheDocument();
  });

  it('desativados ficam escondidos por padrão', async () => {
    // A lista polui rápido com quem já saiu; o histórico continua no banco.
    await montar();
    expect(linhaDe('Beto')).toBeUndefined();
  });

  it('o filtro revela os desativados e conta quantos são', async () => {
    await montar();
    const filtro = screen.getByRole('button', { name: /Desativados/ });
    expect(within(filtro).getByText('1')).toBeInTheDocument();
    await userEvent.click(filtro);
    expect(linhaDe('Beto')).toBeDefined();
    expect(filtro).toHaveAttribute('aria-pressed', 'true');
  });

  it('sem ninguém desativado o filtro nem aparece', async () => {
    await montar({ equipe: [EQUIPE[0]] });
    expect(screen.queryByRole('button', { name: /Desativados/ })).toBeNull();
  });

  it('equipe vazia explica isso em vez de mostrar um cartão em branco', async () => {
    await montar({ equipe: [] });
    expect(screen.getByText('staff.noStaffRegistered')).toBeInTheDocument();
  });

  it('falha ao carregar avisa', async () => {
    await montar({ equipe: new Error('500') });
    expect(toast.error).toHaveBeenCalledWith('staff.errLoadData');
  });
});

describe('estados de convite', () => {
  it('conta nova aguardando cadastro pode reenviar ou cancelar', async () => {
    // Nesse estado a pessoa ainda não definiu senha; "ativar" não faz sentido.
    await montar();
    const linha = linhaDe('Carla');
    expect(within(linha).getByText('Aguardando cadastro')).toBeInTheDocument();
    expect(within(linha).getByText('Reenviar')).toBeInTheDocument();
    expect(within(linha).queryByText('staff.deactivate')).toBeNull();
  });

  it('quem já tinha conta e não aceitou pode ser efetivado ou ter o convite cancelado', async () => {
    await montar();
    const linha = linhaDe('Davi');
    expect(within(linha).getByText('Convite pendente')).toBeInTheDocument();
    expect(within(linha).getByText('Efetivar')).toBeInTheDocument();
    expect(within(linha).getByText('Cancelar convite')).toBeInTheDocument();
    expect(within(linha).queryByText('Reenviar')).toBeNull();
  });

  it('convite pendente aparece SEM precisar do filtro de desativados', async () => {
    // O relato: "está cadastrado mas aparece como convite pendente e como
    // desativado". A linha nasce `active: false`, então caía no filtro e sumia
    // da lista — o admin não achava a pessoa para resolver nada.
    await montar();
    expect(linhaDe('Davi')).toBeDefined();
  });

  it('convite pendente não é contado nem pintado como desativado', async () => {
    // Dois sinais contraditórios na mesma linha (cinza de desativado + selo de
    // pendente) é o que deixava o admin sem saber o que fazer.
    await montar();
    const filtro = screen.getByRole('button', { name: /Desativados/ });
    expect(within(filtro).getByText('1')).toBeInTheDocument(); // só o Beto
    expect(linhaDe('Davi')).not.toHaveClass('func-row-inactive');
  });

  it('convite não recebe "Ativar"/"Desativar" — quem manda é o status do convite', async () => {
    await montar();
    const linha = linhaDe('Davi');
    expect(within(linha).queryByText('staff.activate')).toBeNull();
    expect(within(linha).queryByText('staff.deactivate')).toBeNull();
  });

  it('efetivar transforma o convite em membro da equipe', async () => {
    // Antes, "pending" só virava "accepted" se a própria pessoa entrasse no
    // sistema e respondesse — quem nunca entrava ficava presa para sempre.
    await montar();
    await userEvent.click(within(linhaDe('Davi')).getByText('Efetivar'));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/staff/s4/confirm-invite'));
    expect(toast.success).toHaveBeenCalledWith('staff.effectivated:Davi');
  });

  it('efetivar pede confirmação e recusar não efetiva', async () => {
    confirmar.mockResolvedValue(false);
    await montar();
    await userEvent.click(within(linhaDe('Davi')).getByText('Efetivar'));
    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    expect(api.post).not.toHaveBeenCalled();
  });

  it('limite do plano ao efetivar aparece com o motivo do servidor', async () => {
    api.post.mockRejectedValue({ response: { data: { detail: 'O plano atual não permite mais usuários ativos.' } } });
    await montar();
    await userEvent.click(within(linhaDe('Davi')).getByText('Efetivar'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('O plano atual não permite mais usuários ativos.')
    );
  });

  it('quem aguarda cadastro não pode ser efetivado — falta a senha', async () => {
    // Marcar como membro não a faria entrar; o caminho lá é reenviar o link.
    await montar();
    expect(within(linhaDe('Carla')).queryByText('Efetivar')).toBeNull();
  });

  it('quem já entrou aparece como ativo e pode ser desativado', async () => {
    await montar();
    const linha = linhaDe('Ana');
    expect(within(linha).getByText('staff.active')).toBeInTheDocument();
    expect(within(linha).getByText('staff.deactivate')).toBeInTheDocument();
  });

  it('reenviar manda um link novo', async () => {
    // Os links do e-mail expiram; sem reenvio a pessoa fica travada fora.
    await montar();
    await userEvent.click(within(linhaDe('Carla')).getByText('Reenviar'));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/staff/s3/resend-invite'));
    expect(toast.success).toHaveBeenCalledWith('staff.inviteResent:carla@clube.com');
  });

  it('falha no reenvio mostra o motivo do servidor', async () => {
    api.post.mockRejectedValue({ response: { data: { detail: 'Limite de envios' } } });
    await montar();
    await userEvent.click(within(linhaDe('Carla')).getByText('Reenviar'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Limite de envios'));
  });

  it('cancelar convite chama a rota do CONVITE, não a que apenas desativa', async () => {
    // O bug relatado: a tela chamava DELETE /staff/{id}, que só desativa. Como
    // o convite já nasce inativo, o clique não mudava nada e a pessoa ficava
    // presa em "convite pendente" para sempre.
    await montar();
    await userEvent.click(within(linhaDe('Davi')).getByText('Cancelar convite'));
    expect(confirmar).toHaveBeenCalledWith(
      'staff.confirmCancelInvite:davi@clube.com',
      expect.objectContaining({ variant: 'danger' })
    );
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/staff/s4/invite'));
    expect(api.delete).not.toHaveBeenCalledWith('/staff/s4');
  });

  it('cancelado, a lista é recarregada — a linha some de verdade', async () => {
    await montar();
    api.get.mockImplementation((url) => {
      if (url === '/staff') return Promise.resolve({ data: EQUIPE.filter((s) => s.id !== 's4') });
      if (url === '/staff/groups') return Promise.resolve({ data: GRUPOS });
      return Promise.resolve({ data: [] });
    });
    await userEvent.click(within(linhaDe('Davi')).getByText('Cancelar convite'));
    await waitFor(() => expect(linhaDe('Davi')).toBeUndefined());
  });

  it('falha ao cancelar mostra o motivo do servidor', async () => {
    api.delete.mockRejectedValue({ response: { data: { detail: 'Este funcionário já movimentou caixa.' } } });
    await montar();
    await userEvent.click(within(linhaDe('Davi')).getByText('Cancelar convite'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Este funcionário já movimentou caixa.')
    );
  });

  it('recusar a confirmação não cancela', async () => {
    confirmar.mockResolvedValue(false);
    await montar();
    await userEvent.click(within(linhaDe('Davi')).getByText('Cancelar convite'));
    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    expect(api.delete).not.toHaveBeenCalled();
  });
});

describe('convidar alguém', () => {
  const abrir = () => userEvent.click(screen.getByRole('button', { name: '+ staff.newEmployee' }));

  it('só pede o e-mail — a senha é a pessoa que define', async () => {
    await montar();
    await abrir();
    expect(screen.getByPlaceholderText('email@exemplo.com')).toBeInTheDocument();
    expect(screen.queryByLabelText(/senha/i)).toBeNull();
  });

  it.each(['', 'sem-arroba', 'a@b', 'a@b.'])('e-mail "%s" é recusado sem chamar o servidor', async (valor) => {
    // Convite com e-mail torto some no vazio: ninguém recebe e o admin acha
    // que convidou.
    await montar();
    await abrir();
    if (valor) await userEvent.type(screen.getByPlaceholderText('email@exemplo.com'), valor);
    await userEvent.click(screen.getByRole('button', { name: 'Enviar convite' }));
    expect(toast.error).toHaveBeenCalledWith('Informe um e-mail válido.');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('envia o convite com o grupo escolhido', async () => {
    await montar();
    await abrir();
    await userEvent.type(screen.getByPlaceholderText('email@exemplo.com'), 'novo@clube.com');
    await userEvent.selectOptions(
      within(document.querySelector('.func-modal')).getByRole('combobox'),
      'g1'
    );
    await userEvent.click(screen.getByRole('button', { name: 'Enviar convite' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/staff', {
        email: 'novo@clube.com',
        permission_group_id: 'g1',
      })
    );
    expect(toast.success).toHaveBeenCalledWith('staff.inviteSent:novo@clube.com');
  });

  it('quem entra direto não é anunciado como "convite enviado"', async () => {
    // Conta que já existia e não é de outro clube vira membro na hora, e o
    // servidor não dispara e-mail nenhum. Dizer "convite enviado" faria o
    // admin esperar por uma mensagem que nunca chega.
    api.post.mockResolvedValue({ data: { id: 's9', invite_status: 'accepted', active: true } });
    await montar();
    await abrir();
    await userEvent.type(screen.getByPlaceholderText('email@exemplo.com'), 'orfa@nexthub.com');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar convite' }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('staff.joinedDirectly:orfa@nexthub.com')
    );
  });

  it('sem grupo o convite vai só com o e-mail', async () => {
    await montar();
    await abrir();
    await userEvent.type(screen.getByPlaceholderText('email@exemplo.com'), 'novo@clube.com');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar convite' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/staff', { email: 'novo@clube.com' })
    );
  });

  it('espaços em volta do e-mail são ignorados', async () => {
    await montar();
    await abrir();
    await userEvent.type(screen.getByPlaceholderText('email@exemplo.com'), '  novo@clube.com  ');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar convite' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/staff', { email: 'novo@clube.com' })
    );
  });

  it('e-mail já usado mostra o motivo do servidor', async () => {
    api.post.mockRejectedValue({ response: { data: { detail: 'E-mail já cadastrado' } } });
    await montar();
    await abrir();
    await userEvent.type(screen.getByPlaceholderText('email@exemplo.com'), 'ana@clube.com');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar convite' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('E-mail já cadastrado'));
    expect(document.querySelector('.func-modal')).toBeInTheDocument();
  });

  it('cancelar fecha sem convidar', async () => {
    await montar();
    await abrir();
    await userEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(document.querySelector('.func-modal')).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe('excluir funcionário', () => {
  const excluir = async () => {
    await userEvent.click(within(linhaDe('Ana')).getByText('Excluir'));
  };

  it('avisa que a conta de acesso também pode sumir', async () => {
    await montar();
    await excluir();
    expect(confirmar).toHaveBeenCalledWith(
      expect.stringContaining('staff.confirmRemove'),
      expect.objectContaining({ variant: 'danger' })
    );
  });

  it('quem tem movimentação é apenas DESATIVADO, e a tela diz isso', async () => {
    // Apagar mudaria o resultado de etapas já fechadas. Sem essa mensagem, o
    // admin acharia que a exclusão falhou.
    api.delete.mockResolvedValue({ data: { acao: 'desativado', nome: 'Ana' } });
    await montar();
    await excluir();
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('staff.removedButKept:Ana'));
  });

  it('sem movimentação, a conta de acesso é removida junto', async () => {
    api.delete.mockResolvedValue({ data: { acao: 'removido', conta_removida: true, nome: 'Ana' } });
    await montar();
    await excluir();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('staff.removedWithAccount:Ana'));
  });

  it('quem trabalha em outro clube sai só deste', async () => {
    api.delete.mockResolvedValue({ data: { acao: 'removido', conta_removida: false, nome: 'Ana' } });
    await montar();
    await excluir();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('staff.removedOnly:Ana'));
  });

  it('erro do servidor aparece com o motivo', async () => {
    api.delete.mockRejectedValue({ response: { data: { detail: 'Sem permissão' } } });
    await montar();
    await excluir();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Sem permissão'));
  });
});

describe('ativar, desativar e trocar de grupo', () => {
  it('desativar envia o novo estado', async () => {
    await montar();
    await userEvent.click(within(linhaDe('Ana')).getByText('staff.deactivate'));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/staff/s1', { active: false }));
    expect(toast.success).toHaveBeenCalledWith('staff.staffDeactivated');
  });

  it('reativar também', async () => {
    await montar();
    await userEvent.click(screen.getByRole('button', { name: /Desativados/ }));
    await userEvent.click(within(linhaDe('Beto')).getByText('staff.activate'));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/staff/s2', { active: true }));
  });

  it('falha ao alternar avisa', async () => {
    api.patch.mockRejectedValue(new Error('500'));
    await montar();
    await userEvent.click(within(linhaDe('Ana')).getByText('staff.deactivate'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('staff.errUpdateStaff'));
  });

  it('o grupo é trocado direto na linha', async () => {
    await montar();
    await userEvent.selectOptions(within(linhaDe('Ana')).getByRole('combobox'), 'g2');
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/staff/s1', { permission_group_id: 'g2' })
    );
  });

  it('tirar o grupo manda nulo, não string vazia', async () => {
    // String vazia não é um id; o backend precisa do nulo para limpar.
    await montar();
    await userEvent.selectOptions(within(linhaDe('Ana')).getByRole('combobox'), '');
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/staff/s1', { permission_group_id: null })
    );
  });
});

describe('grupos de permissão', () => {
  const irGrupos = () => irPara('staff.tabGroups');

  it('lista os grupos com as permissões', async () => {
    await montar();
    await irGrupos();
    expect(screen.getByText('Caixa')).toBeInTheDocument();
    expect(screen.getByText('Opera o caixa')).toBeInTheDocument();
  });

  it('grupo sem permissão nenhuma é sinalizado', async () => {
    // Um grupo vazio não dá acesso a nada; precisa ser óbvio na lista.
    await montar();
    await irGrupos();
    expect(screen.getByText('staff.noPermissions')).toBeInTheDocument();
  });

  it('grupo com todas as permissões é sinalizado como total', async () => {
    await montar({
      // O total acompanha ALL_PERMISSIONS da tela — hoje 22 chaves, com a
      // emissão de ticket em lote ('cashier_tickets.master') e o log de
      // acessos ('access_log').
      grupos: [{ id: 'g9', name: 'Admin', permissions: Array.from({ length: 22 }, (_, i) => `p${i}`) }],
    });
    await irGrupos();
    expect(screen.getByText('staff.allPermissions')).toBeInTheDocument();
  });

  it('muitas permissões são resumidas com um contador', async () => {
    await montar({
      grupos: [{ id: 'g3', name: 'Meio', permissions: ['cashier', 'players', 'reports', 'blinds', 'tables', 'rankings'] }],
    });
    await irGrupos();
    expect(screen.getByText('+2')).toBeInTheDocument();
  });

  it('sem grupo nenhum explica isso', async () => {
    await montar({ grupos: [] });
    await irGrupos();
    expect(screen.getByText('staff.noGroupsRegistered')).toBeInTheDocument();
  });

  it('criar exige nome', async () => {
    await montar();
    await irGrupos();
    await userEvent.click(screen.getByRole('button', { name: '+ staff.newGroup' }));
    await userEvent.click(screen.getByRole('button', { name: 'staff.createGroup' }));
    expect(toast.error).toHaveBeenCalledWith('staff.enterGroupName');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('cria com nome, descrição e permissões marcadas', async () => {
    await montar();
    await irGrupos();
    await userEvent.click(screen.getByRole('button', { name: '+ staff.newGroup' }));
    await userEvent.type(screen.getByPlaceholderText('staff.groupNamePlaceholder'), 'Recepção');
    await userEvent.click(screen.getByLabelText('staff.perm.players'));
    await userEvent.click(screen.getByRole('button', { name: 'staff.createGroup' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/staff/groups', {
        name: 'Recepção', description: '', permissions: ['players'],
      })
    );
  });

  it('editar já vem com as permissões atuais marcadas', async () => {
    await montar();
    await irGrupos();
    await userEvent.click(within(linhaDe('Caixa')).getByText('common.edit'));
    expect(screen.getByLabelText('staff.perm.cashier')).toBeChecked();
    expect(screen.getByLabelText('staff.perm.blinds')).not.toBeChecked();
  });

  it('editar salva por PATCH, não cria outro grupo', async () => {
    await montar();
    await irGrupos();
    await userEvent.click(within(linhaDe('Caixa')).getByText('common.edit'));
    await userEvent.click(screen.getByRole('button', { name: 'staff.saveChanges' }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/staff/groups/g1', expect.objectContaining({ name: 'Caixa' }))
    );
    expect(api.post).not.toHaveBeenCalled();
  });

  it('desmarcar uma permissão a remove do grupo', async () => {
    await montar();
    await irGrupos();
    await userEvent.click(within(linhaDe('Caixa')).getByText('common.edit'));
    await userEvent.click(screen.getByLabelText('staff.perm.cashier'));
    await userEvent.click(screen.getByRole('button', { name: 'staff.saveChanges' }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/staff/groups/g1', expect.objectContaining({ permissions: ['players'] }))
    );
  });

  it('"selecionar todas" marca tudo e vira "desmarcar todas"', async () => {
    await montar();
    await irGrupos();
    await userEvent.click(screen.getByRole('button', { name: '+ staff.newGroup' }));
    await userEvent.click(screen.getByRole('button', { name: 'staff.selectAll' }));
    expect(screen.getByLabelText('staff.perm.blinds')).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: 'staff.deselectAll' }));
    expect(screen.getByLabelText('staff.perm.blinds')).not.toBeChecked();
  });

  it('erro do servidor ao salvar aparece com o motivo', async () => {
    api.post.mockRejectedValue({ response: { data: { detail: 'Nome já existe' } } });
    await montar();
    await irGrupos();
    await userEvent.click(screen.getByRole('button', { name: '+ staff.newGroup' }));
    await userEvent.type(screen.getByPlaceholderText('staff.groupNamePlaceholder'), 'Caixa');
    await userEvent.click(screen.getByRole('button', { name: 'staff.createGroup' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Nome já existe'));
  });

  it('excluir pede confirmação', async () => {
    await montar();
    await irGrupos();
    await userEvent.click(within(linhaDe('Caixa')).getByText('common.remove'));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/staff/groups/g1'));
  });

  it('recusar a confirmação não exclui', async () => {
    window.confirm.mockReturnValue(false);
    await montar();
    await irGrupos();
    await userEvent.click(within(linhaDe('Caixa')).getByText('common.remove'));
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('erro ao excluir avisa', async () => {
    api.delete.mockRejectedValue(new Error('409'));
    await montar();
    await irGrupos();
    await userEvent.click(within(linhaDe('Caixa')).getByText('common.remove'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('staff.errRemoveGroup'));
  });
});

describe('pagamentos da equipe', () => {
  const irPagamentos = () => irPara('staff.tabPayments');

  it('sem etapa selecionada não há o que pagar', async () => {
    // O pagamento é POR ETAPA; sem etapa, "pagar" não tem significado.
    useStage.mockReturnValue({ selectedStage: null });
    await montar();
    await irPagamentos();
    expect(screen.getByText('staff.selectStageForPayments')).toBeInTheDocument();
  });

  it('mostra o orçamento reservado para a equipe', async () => {
    // Vem da premiação com finalidade "staff" dos torneios da etapa: é a
    // referência de quanto há para distribuir.
    await montar();
    await irPagamentos();
    await waitFor(() =>
      expect(document.querySelector('.func-pay-summary')).toHaveTextContent('R$ 5000.00')
    );
  });

  it('premiação reservada para outra finalidade não entra no orçamento', async () => {
    await montar({ resumos: { t1: { reserved_purpose: 'ranking', reserved_amount: 5000 } } });
    await irPagamentos();
    await waitFor(() =>
      expect(document.querySelector('.func-pay-stat')).toHaveTextContent('R$ 0.00')
    );
  });

  it('mostra o saldo do caixa geral, que é de onde sai o dinheiro', async () => {
    await montar();
    await irPagamentos();
    await waitFor(() =>
      expect(document.querySelector('.func-pay-summary')).toHaveTextContent('R$ 20000.00')
    );
  });

  it('só funcionários ATIVOS entram na folha', async () => {
    await montar();
    await irPagamentos();
    await waitFor(() => expect(linhaDe('Ana')).toBeDefined());
    expect(linhaDe('Beto')).toBeUndefined();
  });

  it('o valor digitado é salvo ao sair do campo', async () => {
    await montar();
    await irPagamentos();
    const campo = await waitFor(() => within(linhaDe('Ana')).getByRole('spinbutton'));
    await userEvent.type(campo, '300');
    await userEvent.tab();
    await waitFor(() => {
      const gravacao = mockBase.chamadas.find((c) => c.op === 'insert' && c.tabela === 'staff_payments');
      expect(gravacao.payload).toMatchObject({ stage_id: 'e1', staff_id: 's1', amount: 300, status: 'pending' });
    });
  });

  it('sair do campo sem mudar nada não grava', async () => {
    // Sair do campo acontece o tempo todo; gravar à toa poluiria a base.
    mockBase.dados.staff_payments = [{ id: 'sp1', staff_id: 's1', amount: 300, status: 'pending' }];
    await montar();
    await irPagamentos();
    const campo = await waitFor(() => within(linhaDe('Ana')).getByRole('spinbutton'));
    await userEvent.click(campo);
    await userEvent.tab();
    expect(mockBase.chamadas.some((c) => c.op === 'update')).toBe(false);
  });

  it('campo vazio sem valor anterior não cria linha zerada', async () => {
    await montar();
    await irPagamentos();
    const campo = await waitFor(() => within(linhaDe('Ana')).getByRole('spinbutton'));
    await userEvent.click(campo);
    await userEvent.tab();
    expect(mockBase.chamadas.some((c) => c.op === 'insert')).toBe(false);
  });

  it('pagar sem valor definido é recusado', async () => {
    await montar();
    await irPagamentos();
    await waitFor(() => expect(linhaDe('Ana')).toBeDefined());
    await userEvent.click(within(linhaDe('Ana')).getByText('staff.pay'));
    expect(toast.error).toHaveBeenCalledWith('staff.defineAmountBeforePay');
  });

  it('pagar acima do saldo do caixa é recusado ANTES de escrever', async () => {
    // O caixa geral não pode ficar negativo; a checagem vem antes da gravação.
    mockBase.dados.staff_payments = [{ id: 'sp1', staff_id: 's1', amount: 999999, status: 'pending' }];
    await montar();
    await irPagamentos();
    await waitFor(() => expect(linhaDe('Ana')).toBeDefined());
    await userEvent.click(within(linhaDe('Ana')).getByText('staff.pay'));
    expect(toast.error).toHaveBeenCalledWith('staff.insufficientGeneralCash:R$ 20000.00');
    expect(mockBase.chamadas.some((c) => c.op === 'update' && c.tabela === 'general_cash_register')).toBe(false);
  });

  it('pagar DEBITA o caixa geral pelo valor exato', async () => {
    mockBase.dados.staff_payments = [{ id: 'sp1', staff_id: 's1', amount: 500, status: 'pending' }];
    await montar();
    await irPagamentos();
    await waitFor(() => expect(linhaDe('Ana')).toBeDefined());
    await userEvent.click(within(linhaDe('Ana')).getByText('staff.pay'));
    await waitFor(() => {
      const debito = mockBase.chamadas.find(
        (c) => c.tabela === 'general_cash_register' && c.op === 'update'
      );
      expect(debito.payload.current_balance).toBe('19500');
    });
    expect(toast.success).toHaveBeenCalledWith('staff.paymentRegistered');
  });

  it('pagamento marca a linha como paga', async () => {
    mockBase.dados.staff_payments = [{ id: 'sp1', staff_id: 's1', amount: 500, status: 'pending' }];
    await montar();
    await irPagamentos();
    await waitFor(() => expect(linhaDe('Ana')).toBeDefined());
    await userEvent.click(within(linhaDe('Ana')).getByText('staff.pay'));
    await waitFor(() => {
      const marcacao = mockBase.chamadas.find(
        (c) => c.tabela === 'staff_payments' && c.op === 'update' && c.payload.status === 'paid'
      );
      expect(marcacao).toBeTruthy();
    });
  });

  it('valor já pago não pode mais ser editado', async () => {
    mockBase.dados.staff_payments = [
      { id: 'sp1', staff_id: 's1', amount: 500, status: 'paid', paid_at: '2026-06-09T00:00:00Z' },
    ];
    await montar();
    await irPagamentos();
    await waitFor(() => expect(within(linhaDe('Ana')).getByRole('spinbutton')).toBeDisabled());
    expect(within(linhaDe('Ana')).getByText('staff.reverse')).toBeInTheDocument();
  });

  it('estornar DEVOLVE o valor ao caixa geral', async () => {
    // Pagamento errado precisa de caminho de volta; sem isso o caixa fica
    // furado até alguém corrigir na mão.
    mockBase.dados.staff_payments = [
      { id: 'sp1', staff_id: 's1', amount: 500, status: 'paid', paid_at: '2026-06-09T00:00:00Z' },
    ];
    await montar();
    await irPagamentos();
    await waitFor(() => expect(linhaDe('Ana')).toBeDefined());
    await userEvent.click(within(linhaDe('Ana')).getByText('staff.reverse'));
    await waitFor(() => {
      const credito = mockBase.chamadas.find(
        (c) => c.tabela === 'general_cash_register' && c.op === 'update'
      );
      expect(credito.payload.current_balance).toBe('20500');
    });
    expect(toast.success).toHaveBeenCalledWith('staff.paymentReversed');
  });

  it('o total pago soma só o que foi de fato pago', async () => {
    mockBase.dados.staff_payments = [
      { id: 'sp1', staff_id: 's1', amount: 500, status: 'paid' },
      { id: 'sp2', staff_id: 's3', amount: 300, status: 'pending' },
    ];
    await montar();
    await irPagamentos();
    await waitFor(() =>
      expect(document.querySelectorAll('.func-pay-stat')[2]).toHaveTextContent('R$ 500.00')
    );
  });

  it('o total atribuído soma pagos e pendentes', async () => {
    mockBase.dados.staff_payments = [
      { id: 'sp1', staff_id: 's1', amount: 500, status: 'paid' },
      { id: 'sp2', staff_id: 's3', amount: 300, status: 'pending' },
    ];
    await montar();
    await irPagamentos();
    await waitFor(() =>
      expect(document.querySelectorAll('.func-pay-stat')[1]).toHaveTextContent('R$ 800.00')
    );
  });

  it('falha ao carregar os pagamentos avisa', async () => {
    mockBase.erro = new Error('rls');
    await montar();
    await irPagamentos();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('staff.errLoadPayments'));
  });
});

describe('aba de acessos', () => {
  // O log mostra o que CADA funcionário fez — só quem tem a chave `access_log`.
  it('sem a permissão nem vê a aba', async () => {
    await montar();
    expect(screen.queryByRole('button', { name: 'Acessos' })).toBeNull();
  });

  it('com a permissão a aba abre e o log da própria organização é buscado', async () => {
    usePermissions.mockReturnValue({ hasPermission: (k) => k === 'access_log' });
    await montar();
    await irPara('Acessos');
    expect(screen.getByTestId('activity-log')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/activity-logs', { params: { page: 1 } });
    // Nesta aba não há o que criar: nem funcionário, nem grupo.
    expect(screen.queryByRole('button', { name: /staff.newGroup/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /staff.newEmployee/ })).toBeNull();
  });
});
