/**
 * Menu lateral.
 *
 * Ele é o mapa do sistema para cada perfil, e três decisões nele têm
 * consequência direta:
 *
 * 1. **O item ativo tem que ser o mais específico.** Sem isso, "/caixa"
 *    acende enquanto o operador está em "/caixa/jogadores" — dois itens
 *    marcados ao mesmo tempo, e ele perde a referência de onde está.
 * 2. **O menu filtra por permissão, mas isso é UX.** Esconder não protege
 *    nada (o backend valida em toda rota); serve para o operador não clicar
 *    em algo que vai levar 403.
 * 3. **O item de organizações vem do CLAIM, não do RBAC do clube.** Ele
 *    abre o cadastro de CLIENTES: um grupo de permissão do clube jamais
 *    pode concedê-lo.
 * 4. **O menu troca inteiro conforme o MÓDULO.** Torneio e cash game são
 *    operações diferentes; ver os dois menus ao mesmo tempo dobraria a
 *    lista com itens que não servem para o que a pessoa está fazendo. E
 *    módulo não é permissão: o admin de um clube que só faz torneio tem
 *    todas as chaves e mesmo assim não pode ver as telas de cash.
 */
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Sidebar from './Sidebar';
import { useAuth } from '../contexts/AuthContext';
import { useStage } from '../contexts/StageContext';
import { usePermissions } from '../contexts/PermissionContext';
import { useModule } from '../contexts/ModuleContext';

jest.mock('../contexts/AuthContext', () => ({ useAuth: jest.fn() }));
jest.mock('../contexts/StageContext', () => ({ useStage: jest.fn() }));
jest.mock('../contexts/PermissionContext', () => ({ usePermissions: jest.fn() }));
// O mock precisa devolver as CONSTANTES junto: a Sidebar indexa os menus por
// elas, e um mock sem esses valores montaria o objeto com chave `undefined`.
jest.mock('../contexts/ModuleContext', () => ({
  useModule: jest.fn(),
  MODULO_TORNEIO: 'tournament',
  MODULO_CASH: 'cash',
}));
jest.mock('./OrgSwitcher', () => () => <div data-testid="org-switcher" />);
jest.mock('./ModuleSwitcher', () => () => <div data-testid="module-switcher" />);
jest.mock('./LanguageSelector', () => () => <div data-testid="language-selector" />);
jest.mock('../assets/aceblind-logo-white.png', () => 'logo.png');
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (chave, padrao) => padrao || chave }),
}));

let sair;

const montar = ({
  rota = '/home', permissoes = null, plataforma = false, etapa = null,
  modulo = 'tournament',
} = {}) => {
  usePermissions.mockReturnValue({
    hasPermission: permissoes ? (p) => !p || permissoes.includes(p) : () => true,
    isPlatformAdmin: plataforma,
  });
  useModule.mockReturnValue({
    module: modulo,
    homePath: modulo === 'cash' ? '/cash' : '/home',
  });
  useStage.mockReturnValue({ selectedStage: etapa });
  return render(
    <MemoryRouter initialEntries={[rota]}>
      <Sidebar />
    </MemoryRouter>
  );
};

const itemAtivo = () =>
  Array.from(document.querySelectorAll('.nav-item.active, .sub-menu-item.active')).map(
    (el) => el.getAttribute('href') || el.textContent.trim()
  );

beforeEach(() => {
  sair = jest.fn().mockResolvedValue({});
  useAuth.mockReturnValue({ signOut: sair });
  localStorage.clear();
  window.innerWidth = 1200;
});

describe('itens por permissão', () => {
  it('admin vê o menu completo', () => {
    montar();
    expect(screen.getByRole('link', { name: /sidebar.stages/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /sidebar.reports/ })).toBeInTheDocument();
  });

  it('operador de caixa não vê relatórios nem funcionários', () => {
    // Esconder é UX; o backend valida em toda rota. Serve para o operador
    // não clicar em algo que vai levar 403.
    montar({ permissoes: ['cashier'] });
    expect(screen.queryByRole('link', { name: /sidebar.reports/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /sidebar.staff/ })).toBeNull();
  });

  it('grupo some quando nenhum filho é permitido', () => {
    montar({ permissoes: ['reports'] });
    expect(screen.queryByText('sidebar.cashRegister')).toBeNull();
  });

  it('grupo aparece com um filho só permitido, e só ele', () => {
    montar({ permissoes: ['cashier_tickets'] });
    expect(screen.getByText('sidebar.cashRegister')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /sidebar.tournamentTickets/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /sidebar.sales/ })).toBeNull();
  });

  it('o sangi puro vê a própria tela no primeiro nível', () => {
    // É a única tela dele; sem o item de topo, ficaria sem acesso.
    // No módulo de CASH: a sangeur circula pelas mesas vendendo fichas, e no
    // torneio a venda acontece no caixa, com o jogador indo até lá.
    montar({ permissoes: ['sangi'], modulo: 'cash' });
    expect(screen.getByRole('link', { name: /sidebar.sangi/ })).toBeInTheDocument();
  });

  it('quem tem caixa vê a sangria uma vez só, sem duplicar', () => {
    // Dois itens "Sangi" no menu seriam ruído puro.
    montar({ permissoes: ['cashier', 'sangi'], modulo: 'cash' });
    expect(screen.getAllByRole('link', { name: /sidebar.sangi/ })).toHaveLength(1);
  });

  it('o menu de cash não leva a NENHUMA tela de torneio', () => {
    // O caso que motivou isto: estando no cash, a barra lateral mostrava
    // "Relatórios" duas vezes — o `/cash/relatorios` e o `/relatorios`, que é
    // a tela de relatórios de TORNEIO ("Total de Torneios", "Receita por
    // Torneio") e estava no menu comum.
    //
    // O teste é sobre a REGRA, não sobre aquele item: qualquer tela de torneio
    // que escorregue para o menu comum cai aqui.
    montar({ modulo: 'cash' });
    const soDoTorneio = [
      '/home', '/etapas', '/torneios', '/caixa', '/caixa-geral',
      '/relatorios', '/premiacao', '/ranking', '/alocacao', '/blinds',
    ];
    const destinos = [...document.querySelectorAll('a[href]')]
      .map((a) => a.getAttribute('href'));
    destinos.forEach((href) => {
      soDoTorneio.forEach((prefixo) => {
        // `/cash/relatorios` não pode ser confundido com `/relatorios`.
        const ehDoTorneio = href === prefixo || href.startsWith(prefixo + '/');
        expect(ehDoTorneio).toBe(false);
      });
    });
  });

  it('nenhum rótulo aparece duas vezes no menu', () => {
    // Dois itens com o mesmo nome são indistinguíveis para quem opera: a
    // pessoa clica num, não é o que queria, e não tem como saber qual é qual.
    ['cash', 'tournament'].forEach((modulo) => {
      const { unmount } = montar({ modulo });
      const rotulos = [...document.querySelectorAll('.nav-label')]
        .map((n) => n.textContent.trim());
      expect(rotulos.length).toBe(new Set(rotulos).size);
      unmount();
    });
  });

  it('a sangeur NÃO aparece no menu de torneio', () => {
    // A migração em uma linha: o papel é do cash. Deixá-la no torneio faria o
    // operador procurar a consignação numa operação onde ela não existe.
    montar({ permissoes: ['cashier', 'sangi'], modulo: 'tournament' });
    expect(screen.queryByRole('link', { name: /sidebar.sangi/ })).not.toBeInTheDocument();
  });

  it('cadastro de organizações só com o claim da plataforma', () => {
    // Ele abre o cadastro de CLIENTES: um grupo de permissão do clube jamais
    // pode concedê-lo.
    montar({ plataforma: false });
    expect(screen.queryByRole('link', { name: /sidebar.organizations/ })).toBeNull();
  });

  it('admin da plataforma vê o cadastro de organizações', () => {
    montar({ plataforma: true });
    expect(screen.getByRole('link', { name: /sidebar.organizations/ })).toBeInTheDocument();
  });

  it('o item de organizações ignora o RBAC do clube', () => {
    // Mesmo sem permissão nenhuma de grupo, o claim manda.
    montar({ permissoes: [], plataforma: true });
    expect(screen.getByRole('link', { name: /sidebar.organizations/ })).toBeInTheDocument();
  });
});

describe('item ativo', () => {
  it('marca a rota atual', () => {
    montar({ rota: '/jogadores' });
    expect(itemAtivo()).toContain('/jogadores');
  });

  it('a raiz acende o item de início', () => {
    // "/" e "/home" são a mesma tela; sem isso o menu abre sem nada marcado.
    montar({ rota: '/' });
    expect(itemAtivo()).toContain('/home');
  });

  it('sub-rota específica não acende o item mais curto', () => {
    // "/caixa" aceso junto com "/caixa/jogadores" marcaria dois itens ao
    // mesmo tempo e o operador perderia a referência de onde está.
    montar({ rota: '/caixa/jogadores' });
    const ativos = itemAtivo();
    expect(ativos).toContain('/caixa/jogadores');
    expect(ativos).not.toContain('/caixa');
  });

  it('sub-rota sem item próprio acende o item pai', () => {
    // "/torneios/123" não tem entrada no menu: o esperado é "Torneios".
    montar({ rota: '/torneios/123' });
    expect(itemAtivo()).toContain('/torneios');
  });

  it('rota fora do menu não acende nada', () => {
    montar({ rota: '/tela-desconhecida' });
    expect(itemAtivo()).toEqual([]);
  });

  it('o grupo acende quando um filho está ativo', () => {
    montar({ rota: '/caixa/tickets' });
    expect(document.querySelector('.nav-item-group .nav-item.active')).toBeInTheDocument();
  });
});

describe('grupos', () => {
  it('caixa e torneios começam abertos', () => {
    // São os grupos usados durante o evento; abrir a cada visita seria
    // atrito no meio da operação.
    montar();
    expect(screen.getByRole('link', { name: /sidebar.sales/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /sidebar.tournamentsList/ })).toBeInTheDocument();
  });

  it('clicar no grupo fecha e reabre', async () => {
    montar();
    await userEvent.click(screen.getByText('sidebar.cashRegister'));
    expect(screen.queryByRole('link', { name: /sidebar.sales/ })).toBeNull();
    await userEvent.click(screen.getByText('sidebar.cashRegister'));
    expect(screen.getByRole('link', { name: /sidebar.sales/ })).toBeInTheDocument();
  });

  it('grupo com filho ativo não fecha', async () => {
    // Fechar esconderia justamente a tela em que o operador está.
    montar({ rota: '/caixa/tickets' });
    await userEvent.click(screen.getByText('sidebar.cashRegister'));
    expect(screen.getByRole('link', { name: /sidebar.tournamentTickets/ })).toBeInTheDocument();
  });
});

describe('etapa selecionada', () => {
  it('aparece no topo do menu', () => {
    // É o que evita operar na etapa errada.
    montar({ etapa: { id: 'e1', name: 'Etapa Rio' } });
    expect(screen.getByText('Etapa Rio')).toBeInTheDocument();
  });

  it('sem etapa não mostra o rótulo', () => {
    montar();
    expect(document.querySelector('.selected-stage-sidebar')).toBeNull();
  });
});

describe('recolher a barra', () => {
  it('lembra a escolha entre visitas', async () => {
    montar();
    await userEvent.click(document.querySelector('.sidebar-collapse-btn'));
    expect(localStorage.getItem('sidebar-collapsed')).toBe('true');
    expect(document.querySelector('.sidebar')).toHaveClass('collapsed');
  });

  it('parte recolhida quando foi assim que ficou', () => {
    localStorage.setItem('sidebar-collapsed', 'true');
    montar();
    expect(document.querySelector('.sidebar')).toHaveClass('collapsed');
  });

  it('recolhida esconde o nome da etapa', () => {
    // Sem espaço para o texto, ele vazaria por cima dos ícones.
    localStorage.setItem('sidebar-collapsed', 'true');
    montar({ etapa: { id: 'e1', name: 'Etapa Rio' } });
    expect(screen.queryByText('Etapa Rio')).toBeNull();
  });

  it('avisa o documento para o conteúdo ajustar a margem', () => {
    localStorage.setItem('sidebar-collapsed', 'true');
    montar();
    expect(document.documentElement.getAttribute('data-sidebar-collapsed')).toBe('true');
  });
});

describe('celular', () => {
  const emCelular = (props) => {
    window.innerWidth = 500;
    return montar(props);
  };

  it('mostra a barra de topo com o menu sanduíche', () => {
    emCelular();
    expect(screen.getByRole('button', { name: 'sidebar.toggleMenu' })).toBeInTheDocument();
  });

  it('abre e fecha o menu', async () => {
    emCelular();
    await userEvent.click(screen.getByRole('button', { name: 'sidebar.toggleMenu' }));
    expect(document.querySelector('.sidebar')).toHaveClass('open');
    await userEvent.click(screen.getByRole('button', { name: 'sidebar.toggleMenu' }));
    expect(document.querySelector('.sidebar')).not.toHaveClass('open');
  });

  it('clicar fora fecha', async () => {
    emCelular();
    await userEvent.click(screen.getByRole('button', { name: 'sidebar.toggleMenu' }));
    await userEvent.click(document.querySelector('.sidebar-overlay'));
    expect(document.querySelector('.sidebar')).not.toHaveClass('open');
  });

  it('escolher um item fecha o menu', async () => {
    // Sem isso, o menu ficaria por cima da tela recém-aberta.
    emCelular();
    await userEvent.click(screen.getByRole('button', { name: 'sidebar.toggleMenu' }));
    await userEvent.click(screen.getByRole('link', { name: /sidebar.registerPlayer/ }));
    expect(document.querySelector('.sidebar')).not.toHaveClass('open');
  });

  it('trava a rolagem do fundo com o menu aberto', async () => {
    // Rolar a página por baixo do menu desorienta.
    emCelular();
    await userEvent.click(screen.getByRole('button', { name: 'sidebar.toggleMenu' }));
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('mostra a etapa na barra de topo', () => {
    emCelular({ etapa: { id: 'e1', name: 'Etapa Rio' } });
    expect(document.querySelector('.mobile-stage-badge')).toHaveTextContent('Etapa Rio');
  });

  it('não oferece recolher no celular', () => {
    // Não há espaço lateral para recolher.
    emCelular();
    expect(document.querySelector('.sidebar-collapse-btn')).toBeNull();
  });

  it('voltar ao desktop fecha o menu de celular', async () => {
    emCelular();
    await userEvent.click(screen.getByRole('button', { name: 'sidebar.toggleMenu' }));
    await act(async () => {
      window.innerWidth = 1200;
      window.dispatchEvent(new Event('resize'));
    });
    expect(document.querySelector('.sidebar')).not.toHaveClass('open');
  });
});

describe('sair', () => {
  it('encerra a sessão', async () => {
    montar();
    const botao = screen.getByText(/sidebar.logout/i).closest('button');
    await userEvent.click(botao);
    expect(sair).toHaveBeenCalled();
  });
});

describe('menu por módulo', () => {
  it('o módulo de torneio mostra as telas de torneio', () => {
    montar({ modulo: 'tournament' });
    expect(screen.getByRole('link', { name: /sidebar.tournamentsList/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /sidebar.stages/ })).toBeInTheDocument();
  });

  it('o módulo de cash troca o menu inteiro', () => {
    montar({ modulo: 'cash', rota: '/cash' });
    expect(screen.getByRole('link', { name: /cash.floor/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /cash.waitlist/ })).toBeInTheDocument();
    // As telas de torneio somem — não é permissão negada, é outra operação.
    expect(screen.queryByRole('link', { name: /sidebar.tournamentsList/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /sidebar.sales/ })).toBeNull();
  });

  it('etapa é conceito de torneio e não aparece no cash', () => {
    // No cash a unidade de operação é o DIA. Um item de etapa ali levaria a
    // uma tela que não organiza nada do que aquele operador faz.
    montar({ modulo: 'cash', rota: '/cash' });
    expect(screen.queryByRole('link', { name: /sidebar.stages/ })).toBeNull();
    expect(screen.getByRole('link', { name: /cash.days/ })).toBeInTheDocument();
  });

  it('jogadores, equipe e financeiro seguem nos dois módulos', () => {
    // São do CLUBE, não da modalidade: o mesmo jogador senta na mesa de cash e
    // se inscreve no torneio, e o financeiro consolida os dois.
    montar({ modulo: 'cash', rota: '/cash' });
    expect(screen.getByRole('link', { name: /sidebar.registerPlayer/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /sidebar.staff/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /sidebar.financial/ })).toBeInTheDocument();
  });

  it('módulo desconhecido cai no de torneio', () => {
    // Vale para o estado inicial (antes de as permissões carregarem) e para um
    // valor velho no localStorage. Menu vazio seria indistinguível de app
    // quebrado.
    montar({ modulo: undefined });
    expect(screen.getByRole('link', { name: /sidebar.tournamentsList/ })).toBeInTheDocument();
  });

  it('permissão de cash não vaza para o menu de torneio', () => {
    montar({ modulo: 'tournament', permissoes: ['cash.operate', 'cash.day'] });
    expect(screen.queryByRole('link', { name: /cash.floor/ })).toBeNull();
  });

  it('no cash o menu ainda filtra por permissão', () => {
    // Módulo diz QUAIS telas existem; permissão diz quem entra nelas.
    montar({ modulo: 'cash', rota: '/cash', permissoes: ['cash.operate'] });
    expect(screen.getByRole('link', { name: /cash.floor/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /cash.reports/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /cash.config/ })).toBeNull();
  });
});
