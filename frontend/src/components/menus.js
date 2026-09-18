/* Menus do app — DADOS PUROS: caminho, chave de tradução, ícone e permissão.
   Nada aqui depende de estado, props ou idioma (a tradução acontece no render).
   Vivem fora dos componentes porque o menu lateral e a barra do topo leem a
   mesma lista: um para desenhar os itens, o outro para nomear a tela atual. */
import { MODULO_TORNEIO, MODULO_CASH, MODULO_BAR } from '../contexts/ModuleContext';

// MENU POR MÓDULO. Torneio, cash game e bar são operações diferentes, com
// telas diferentes; uma lista só daria um menu do triplo do tamanho no qual a
// maior parte dos itens não serve para o que a pessoa está fazendo agora.
//
// `/etapas` fica SÓ no torneio: no cash a unidade de operação é o DIA, e uma
// etapa/circuito ali não significa nada.
export const MENUS_POR_MODULO = {
  [MODULO_TORNEIO]: [
    { path: '/home', labelKey: 'sidebar.periods', icon: 'home', permission: 'dashboard' },
    { path: '/etapas', labelKey: 'sidebar.stages', icon: 'calendar', permission: 'stages' },
    {
      type: 'group',
      groupKey: 'caixa',
      labelKey: 'sidebar.cashRegister',
      icon: 'dollar',
      permission: 'cashier',
      children: [
        { path: '/caixa', labelKey: 'sidebar.sales', icon: 'dollar', permission: 'cashier' },
        { path: '/caixa/jogadores', labelKey: 'sidebar.playerLimit', icon: 'users', permission: 'cashier_players' },
        { path: '/caixa/tickets', labelKey: 'sidebar.tournamentTickets', icon: 'ticket', permission: 'cashier_tickets' },
      ],
    },
    { path: '/caixa-geral', labelKey: 'sidebar.generalCash', icon: 'wallet', permission: 'general_cash' },
    // RELATÓRIOS DE TORNEIO, e não item comum: a tela mostra "Total de
    // Torneios", "Receita por Torneio" e "Jogadores por Torneio". No menu
    // comum ela aparecia também no cash — ao lado de `/cash/relatorios` e com
    // rótulo idêntico, dois "Relatórios" na mesma barra lateral.
    { path: '/relatorios', labelKey: 'sidebar.reports', icon: 'document', permission: 'reports' },
    {
      type: 'group',
      groupKey: 'torneios',
      labelKey: 'sidebar.tournaments',
      icon: 'trophy',
      permission: 'tournaments',
      children: [
        { path: '/torneios', labelKey: 'sidebar.tournamentsList', icon: 'trophy', permission: 'tournaments' },
        { path: '/blinds-templates', labelKey: 'sidebar.blindTemplates', icon: 'clock', permission: 'tournaments' },
        { path: '/premiacao', labelKey: 'sidebar.registerPrize', icon: 'award', permission: 'prizes' },
      ],
    },
  ],
  [MODULO_CASH]: [
    { path: '/cash', labelKey: 'cash.floor', icon: 'chips', permission: 'cash.operate' },
    { path: '/cash/fila', labelKey: 'cash.waitlist', icon: 'queue', permission: 'cash.operate' },
    {
      type: 'group',
      groupKey: 'cashGestao',
      labelKey: 'cash.management',
      icon: 'clock',
      permission: 'cash.day',
      children: [
        { path: '/cash/dias', labelKey: 'cash.days', icon: 'calendar', permission: 'cash.day' },
        { path: '/cash/configuracao', labelKey: 'cash.config', icon: 'settings', permission: 'cash.admin' },
        { path: '/cash/jackpot', labelKey: 'cash.jackpot', icon: 'award', permission: 'cash.admin' },
      ],
    },
    { path: '/cash/relatorios', labelKey: 'cash.reports', icon: 'document', permission: 'cash.reports' },
    // A SANGEUR É DO CASH. É ela que circula pelas mesas vendendo fichas de uma
    // consignação; no torneio a venda acontece no caixa, com o jogador indo até
    // lá. Estava no menu de torneio porque a consignação nasceu antes do módulo
    // de cash existir.
    { path: '/sangi', labelKey: 'sidebar.sangi', icon: 'briefcase', permission: 'cashier' },
    // Entrada própria para quem SÓ é sangeur: é a única tela dela. Escondida de
    // quem já vê a de cima (tem `cashier`), para não duplicar o item.
    { path: '/sangi', labelKey: 'sidebar.sangi', icon: 'briefcase', permission: 'sangi', hideIfPermission: 'cashier' },
  ],
  // BAR. A POS (comandas) é a home; "Pedidos" é a tela do balcão/cozinha.
  // Turnos e produtos são gestão; o barman do dia a dia não precisa vê-los.
  [MODULO_BAR]: [
    { path: '/bar', labelKey: 'bar.pos', icon: 'cocktail', permission: 'bar.operate' },
    { path: '/bar/pedidos', labelKey: 'bar.orders', icon: 'bell', permission: 'bar.operate' },
    {
      type: 'group',
      groupKey: 'barGestao',
      labelKey: 'bar.management',
      icon: 'clock',
      permission: 'bar.shift',
      children: [
        { path: '/bar/turnos', labelKey: 'bar.shifts', icon: 'calendar', permission: 'bar.shift' },
        { path: '/bar/produtos', labelKey: 'bar.products', icon: 'box', permission: 'bar.admin' },
      ],
    },
    { path: '/bar/relatorios', labelKey: 'bar.reports', icon: 'document', permission: 'bar.reports' },
  ],
};

// Itens que existem em TODOS os módulos: cadastro de jogadores, equipe e
// financeiro são do CLUBE, não de uma modalidade.
export const MENU_COMUM = [
  { path: '/financeiro', labelKey: 'sidebar.financial', icon: 'wallet', permission: 'financial' },
  { path: '/jogadores', labelKey: 'sidebar.registerPlayer', icon: 'users', permission: 'players' },
  { path: '/funcionarios', labelKey: 'sidebar.staff', icon: 'id-badge', permission: 'employees' },
  // Da CONTA, não do clube: aparece nos dois módulos e para todo mundo, sem
  // permissão. Quem só tem a tela da sangeur também precisa poder ativar a
  // verificação em duas etapas.
  { path: '/seguranca', labelKey: 'sidebar.security', icon: 'shield' },
  // Só a NextHub: cadastro dos clubes clientes. `platformAdminOnly` não é
  // permissão de grupo — vem do claim do JWT. O backend valida o mesmo claim.
  { path: '/organizacoes', labelKey: 'sidebar.organizations', icon: 'building', platformAdminOnly: true },
];
