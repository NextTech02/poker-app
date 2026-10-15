import React, { Suspense, lazy, useEffect, useRef } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { StageProvider } from './contexts/StageContext';
import { ToastProvider, useToast } from './contexts/ToastContext';
import { PermissionProvider, usePermissions } from './contexts/PermissionContext';
import { ModuleProvider, useModule } from './contexts/ModuleContext';
import MfaChallenge from './components/MfaChallenge';
import useMfaGate from './hooks/useMfaGate';
import { CashDayProvider } from './contexts/CashDayContext';
import { BarShiftProvider } from './contexts/BarShiftContext';
import { CurrencyProvider } from './contexts/CurrencyContext';
import { PaymentMethodsProvider } from './contexts/PaymentMethodsContext';
import { BuyTypesProvider } from './contexts/BuyTypesContext';
import { ConnectivityProvider } from './contexts/ConnectivityContext';
import { isOnline } from './offline/connectivity';
import OfflineBanner from './components/OfflineBanner';
import OrgScopeBanner from './components/OrgScopeBanner';
import OrgInviteModal from './components/OrgInviteModal';
import Login from './pages/Login';
import SetPassword from './pages/SetPassword';
import SelectOrg from './pages/SelectOrg';
import Dashboard from './pages/Dashboard';
import Etapas from './pages/Etapas';
import Torneios from './pages/Torneios';
import Players from './pages/Players';
import PlayerDetail from './pages/PlayerDetail';
import Caixa from './pages/Caixa';
import ComingSoon from './pages/ComingSoon';
import ErrorBoundary from './components/ErrorBoundary';
import './styles/App.css';
import './components/SkeletonLoader.css';

// Lazy-load less-frequented pages (B4)
const Seguranca = lazy(() => import('./pages/Seguranca'));
const TournamentBroadcast = lazy(() => import('./pages/TournamentBroadcast'));
const TournamentDetail = lazy(() => import('./pages/TournamentDetail'));
const TorneioEquipes = lazy(() => import('./pages/TorneioEquipes'));
const ManualAllocation = lazy(() => import('./pages/ManualAllocation'));
const TableManagement = lazy(() => import('./pages/TableManagement'));
const TournamentRankings = lazy(() => import('./pages/TournamentRankings'));
const BlindManagement = lazy(() => import('./pages/BlindManagement'));
const Premiacao = lazy(() => import('./pages/Premiacao'));
const PremiacaoSelector = lazy(() => import('./pages/PremiacaoSelector'));
const TournamentDayForm = lazy(() => import('./pages/TournamentDayForm'));
const BlindTemplates = lazy(() => import('./pages/BlindTemplates'));
const BroadcastSettings = lazy(() => import('./pages/BroadcastSettings'));
const TournamentDayStats = lazy(() => import('./pages/TournamentDayStats'));
const FichasClassificados = lazy(() => import('./pages/FichasClassificados'));
const TournamentControl = lazy(() => import('./pages/TournamentControl'));
const TVCode = lazy(() => import('./pages/TVCode'));
const ContactConsent = lazy(() => import('./pages/ContactConsent'));
const SyncConflicts = lazy(() => import('./pages/SyncConflicts'));
const Organizacoes = lazy(() => import('./pages/Organizacoes'));
const CaixaJogadores = lazy(() => import('./pages/CaixaJogadores'));
const SatelliteTickets = lazy(() => import('./pages/SatelliteTickets'));
const CaixaGeral = lazy(() => import('./pages/CaixaGeral'));
const Relatorios = lazy(() => import('./pages/Relatorios'));
const RelatorioTorneio = lazy(() => import('./pages/RelatorioTorneio'));
const Sangi = lazy(() => import('./pages/Sangi'));
const Financeiro = lazy(() => import('./pages/Financeiro'));
const Funcionarios = lazy(() => import('./pages/Funcionarios'));
const SelectModule = lazy(() => import('./pages/SelectModule'));
// Cash game. `CashFloor` fica no bundle principal — é a home do módulo e a
// tela que o operador abre primeiro; um chunk extra ali seria uma espera no
// começo de toda noite.
const CashFloor = lazy(() => import('./pages/CashFloor'));
const CashTableDetail = lazy(() => import('./pages/CashTableDetail'));
const CashDays = lazy(() => import('./pages/CashDays'));
const CashWaitlist = lazy(() => import('./pages/CashWaitlist'));
const CashRelatorios = lazy(() => import('./pages/CashRelatorios'));
const CashJackpot = lazy(() => import('./pages/CashJackpot'));
const CashConfig = lazy(() => import('./pages/CashConfig'));
// Bar (comandas). A POS é a home do módulo, mesma lógica do CashFloor.
const BarPOS = lazy(() => import('./pages/BarPOS'));
const BarProducts = lazy(() => import('./pages/BarProducts'));
const BarShifts = lazy(() => import('./pages/BarShifts'));
const BarShiftDetail = lazy(() => import('./pages/BarShiftDetail'));
const BarTabDetail = lazy(() => import('./pages/BarTabDetail'));
const BarOrders = lazy(() => import('./pages/BarOrders'));
const BarRelatorios = lazy(() => import('./pages/BarRelatorios'));

const PageFallback = () => (
  <div className="page-loading-skeleton">
    <div className="skeleton-bar skeleton-bar--wide" />
    <div className="skeleton-bar skeleton-bar--medium" />
    <div className="skeleton-bar skeleton-bar--narrow" />
  </div>
);

/** Leva para a casa do módulo ativo. Usado só na raiz.
 *
 * Fica DENTRO de um PrivateRoute de propósito: ele já segura o render até as
 * permissões carregarem, e é delas que sai a lista de módulos. Sem essa espera,
 * `homePath` seria calculado sobre o padrão (torneio) e o redirect mandaria
 * todo mundo para o lugar errado — exatamente o bug que isto corrige. */
const HomeDoModulo = () => {
  const { homePath } = useModule();
  return <Navigate to={homePath} replace />;
};

const PrivateRoute = ({ children, permission, anyPermission, module }) => {
  const { t } = useTranslation();
  const { user, loading } = useAuth();
  const { hasPermission, loading: permLoading } = usePermissions();
  // VERIFICAÇÃO EM DUAS ETAPAS. Mora aqui, e não em cada tela, pelo mesmo
  // motivo da guarda de módulo: uma trava por rota depende de alguém não
  // esquecer nenhuma das quarenta que existem.
  const { precisaConfirmar, verificando: mfaVerificando, reavaliar } = useMfaGate(user);
  const { module: activeModule, hasModule, selectModule, homePath, casaDoModulo } = useModule();
  const { toast } = useToast();
  const location = useLocation();
  const toastedRef = useRef(false);

  // Check if there's a token in localStorage — Supabase may be refreshing the session
  const hasToken = !!localStorage.getItem('supabase_token');

  // `anyPermission` (array) passes if the user holds at least one of the keys.
  const failsAny = Array.isArray(anyPermission) && anyPermission.length > 0
    && !anyPermission.some((p) => hasPermission(p));
  const denied = !loading && !permLoading && user
    && ((permission && !hasPermission(permission)) || failsAny);

  useEffect(() => {
    if (denied && !toastedRef.current) {
      toastedRef.current = true;
      toast.warning(t('app.permissionDenied'));
    }
  }, [denied, toast, t]);

  // Show loading while auth or permissions are resolving, or while we have a token
  // but user hasn't loaded yet (token refresh in progress) — só ONLINE; offline não
  // adianta esperar refresh.
  if (loading || permLoading || mfaVerificando || (!user && hasToken && isOnline())) {
    return <div className="loading">{t('common.loading')}</div>;
  }

  if (!user) {
    // Offline com token = sessão caiu por falta de rede; mantém o app utilizável
    // (o operador não consegue re-autenticar offline). Online sem user = login.
    if (!isOnline() && hasToken) return children;
    return <Navigate to="/login" />;
  }

  // Falta o segundo fator. Vem ANTES de qualquer outra checagem de tela: sem
  // `aal2` o banco recusa toda leitura (política RESTRICTIVE em todas as
  // tabelas), então deixar passar daqui só levaria a pessoa a telas vazias com
  // cara de sistema quebrado.
  //
  // Não é um redirect: a segunda etapa não tem URL própria de propósito. Um
  // endereço para ela seria mais uma coisa a proteger, e um favorito salvo nele
  // não significaria nada.
  if (user && precisaConfirmar) {
    return <MfaChallenge aoConfirmar={reavaliar} />;
  }

  // Convidado que ainda não definiu a própria senha: completa o cadastro antes
  // de usar o sistema. `organization_name` só existe em conta criada por
  // convite; `onboarded_at` é gravado quando ela conclui. Isso vale mesmo que o
  // Supabase ignore o redirect do convite e caia direto no app.
  const meta = user.user_metadata || {};
  if (meta.organization_name && !meta.onboarded_at) {
    return <Navigate to="/definir-senha" replace />;
  }

  if (denied) {
    // A recusa numa tela de MÓDULO manda para a casa DESSE módulo — a primeira
    // tela que o cargo pode abrir nele (ver menus.js) — e não para a casa do
    // módulo que estava aberto. Era assim que a sangeur, ao entrar em /cash
    // com o torneio ativo, voltava para o Dashboard de torneio e concluía que
    // "o cash não abre": a casa dela no cash é /sangi.
    const rotaDeModulo = module && hasModule(module);
    const destino = rotaDeModulo && typeof casaDoModulo === 'function' ? casaDoModulo(module) : homePath;
    // Recusa na PRÓPRIA casa: redirecionar levaria à mesma URL, e o guard
    // recusaria de novo — em laço, sem nunca pintar a tela. Acontece com um
    // cargo sem tela nenhuma no módulo. Mostra a recusa com o menu ao lado.
    if (destino === location.pathname) {
      return <ComingSoon variant="forbidden" />;
    }
    if (rotaDeModulo && module !== activeModule) selectModule(module);
    return <Navigate to={destino} replace />;
  }

  // GUARD DE MÓDULO. Duas situações diferentes, e só uma é recusa:
  //  - o clube NÃO contratou o módulo => manda escolher (a tela de escolha
  //    entra direto na operação quando só existe um, então isso vira um
  //    redirecionamento silencioso para o lugar certo);
  //  - o clube tem, mas está com o outro selecionado => troca e segue. Um
  //    link salvo nos favoritos não pode dar 404 só porque o menu estava
  //    em outra modalidade.
  if (module && module !== activeModule) {
    if (!hasModule(module)) return <Navigate to="/selecionar-modulo" replace />;
    selectModule(module);
  }

  return children;
};

function AppRoutes() {
  return (
    <Suspense fallback={<PageFallback />}>
      <Routes>
        <Route path="/login" element={<Login />} />
      {/* Destino do convite: o usuário define a própria senha antes de entrar.
          Rota pública — a sessão vem no fragmento da URL enviada por e-mail. */}
      <Route path="/definir-senha" element={<SetPassword />} />
      {/* Escolha da organização (só para quem pertence a 2+ clubes). */}
      <Route
        path="/selecionar-organizacao"
        element={
          <PrivateRoute>
            <SelectOrg />
          </PrivateRoute>
        }
      />
      {/* Escolha do módulo (só para quem contratou torneio E cash game).
          Com um módulo só a própria tela entra direto na operação. */}
      <Route
        path="/selecionar-modulo"
        element={
          <PrivateRoute>
            <SelectModule />
          </PrivateRoute>
        }
      />

      {/* ── Módulo de CASH GAME ──────────────────────────────────────────
          `module="cash"` não é permissão: é entitlement do clube. Quem não
          contratou vai parar na escolha de módulo; quem contratou mas está
          com o torneio selecionado troca sozinho e segue (um link salvo nos
          favoritos não pode dar 404 por causa do menu). */}
      <Route
        path="/cash"
        element={
          <PrivateRoute module="cash" permission="cash.operate">
            <CashFloor />
          </PrivateRoute>
        }
      />
      <Route
        path="/cash/mesas/:tableId"
        element={
          <PrivateRoute module="cash" permission="cash.operate">
            <CashTableDetail />
          </PrivateRoute>
        }
      />
      <Route
        path="/cash/fila"
        element={
          <PrivateRoute module="cash" permission="cash.operate">
            <CashWaitlist />
          </PrivateRoute>
        }
      />
      <Route
        path="/cash/dias"
        element={
          <PrivateRoute module="cash" anyPermission={['cash.day', 'cash.reports']}>
            <CashDays />
          </PrivateRoute>
        }
      />
      <Route
        path="/cash/relatorios"
        element={
          <PrivateRoute module="cash" anyPermission={['cash.reports', 'cash.day']}>
            <CashRelatorios />
          </PrivateRoute>
        }
      />
      <Route
        path="/cash/jackpot"
        element={
          <PrivateRoute module="cash" permission="cash.admin">
            <CashJackpot />
          </PrivateRoute>
        }
      />
      <Route
        path="/cash/configuracao"
        element={
          <PrivateRoute module="cash" permission="cash.admin">
            <CashConfig />
          </PrivateRoute>
        }
      />
      {/* ── Módulo de BAR ────────────────────────────────────────────────
          Mesma guarda do cash: `module="bar"` é entitlement do clube, a
          permissão é do cargo. */}
      <Route
        path="/bar"
        element={
          <PrivateRoute module="bar" permission="bar.operate">
            <BarPOS />
          </PrivateRoute>
        }
      />
      <Route
        path="/bar/comandas/:id"
        element={
          <PrivateRoute module="bar" permission="bar.operate">
            <BarTabDetail />
          </PrivateRoute>
        }
      />
      <Route
        path="/bar/pedidos"
        element={
          <PrivateRoute module="bar" permission="bar.operate">
            <BarOrders />
          </PrivateRoute>
        }
      />
      <Route
        path="/bar/produtos"
        element={
          <PrivateRoute module="bar" permission="bar.admin">
            <BarProducts />
          </PrivateRoute>
        }
      />
      <Route
        path="/bar/turnos"
        element={
          <PrivateRoute module="bar" anyPermission={['bar.shift', 'bar.reports']}>
            <BarShifts />
          </PrivateRoute>
        }
      />
      <Route
        path="/bar/turnos/:id"
        element={
          <PrivateRoute module="bar" anyPermission={['bar.shift', 'bar.reports']}>
            <BarShiftDetail />
          </PrivateRoute>
        }
      />
      <Route
        path="/bar/relatorios"
        element={
          <PrivateRoute module="bar" anyPermission={['bar.reports', 'bar.shift']}>
            <BarRelatorios />
          </PrivateRoute>
        }
      />
      {/* A RAIZ NÃO PERTENCE A MÓDULO NENHUM: ela leva para a casa de quem
          está aberto. Antes ela era o Dashboard de torneio direto, então quem
          estava no cash e abria "/" (o link do logo, um favorito, o redirect
          pós-login) via torneios ativos e receita de torneio dentro do módulo
          de cash.

          Redirecionar em vez de escolher o componente aqui mantém a barra de
          endereço honesta: a URL passa a dizer onde a pessoa está. */}
      <Route
        path="/"
        element={
          <PrivateRoute>
            <HomeDoModulo />
          </PrivateRoute>
        }
      />
      <Route
        path="/etapas"
        element={
          <PrivateRoute module="tournament" permission="stages">
            <Etapas />
          </PrivateRoute>
        }
      />
      <Route
        path="/torneios"
        element={
          <PrivateRoute module="tournament" permission="tournaments">
            <Torneios />
          </PrivateRoute>
        }
      />
      <Route
        path="/blinds-templates"
        element={
          <PrivateRoute module="tournament" permission="tournaments">
            <BlindTemplates />
          </PrivateRoute>
        }
      />
      <Route
        path="/torneios/:id"
        element={
          <PrivateRoute module="tournament" permission="tournaments">
            <TournamentDetail />
          </PrivateRoute>
        }
      />
      <Route
        path="/torneios/:id/equipes"
        element={
          <PrivateRoute module="tournament" permission="tournaments">
            <TorneioEquipes />
          </PrivateRoute>
        }
      />
      <Route
        path="/torneios/:tournamentId/dia/novo"
        element={
          <PrivateRoute module="tournament" permission="tournaments">
            <TournamentDayForm />
          </PrivateRoute>
        }
      />
      <Route
        path="/torneios/:tournamentId/dia/editar/:dayId"
        element={
          <PrivateRoute module="tournament" permission="tournaments">
            <TournamentDayForm />
          </PrivateRoute>
        }
      />
      <Route
        path="/torneios/:tournamentId/dia/:dayId/broadcast"
        element={
          <PrivateRoute module="tournament" permission="broadcast">
            <BroadcastSettings />
          </PrivateRoute>
        }
      />
      <Route
        path="/torneios/dia/:dayId/estatisticas"
        element={
          <PrivateRoute module="tournament" permission="tournaments">
            <TournamentDayStats />
          </PrivateRoute>
        }
      />
      <Route
        path="/torneios/dia/:dayId/fichas"
        element={
          <PrivateRoute module="tournament" permission="tournaments">
            <FichasClassificados />
          </PrivateRoute>
        }
      />
      <Route
        path="/jogadores"
        element={
          <PrivateRoute permission="players">
            <Players />
          </PrivateRoute>
        }
      />
      <Route
        path="/jogadores/:id"
        element={
          <PrivateRoute permission="players">
            <PlayerDetail />
          </PrivateRoute>
        }
      />
      <Route
        path="/caixa"
        element={
          <PrivateRoute module="tournament" permission="cashier">
            <Caixa />
          </PrivateRoute>
        }
      />
      <Route
        path="/caixa/jogadores"
        element={
          <PrivateRoute module="tournament" permission="cashier_players">
            <CaixaJogadores />
          </PrivateRoute>
        }
      />
      <Route
        path="/caixa/tickets"
        element={
          <PrivateRoute module="tournament" permission="cashier_tickets">
            <SatelliteTickets />
          </PrivateRoute>
        }
      />
      <Route
        path="/caixa-geral"
        element={
          <PrivateRoute module="tournament" permission="general_cash">
            <CaixaGeral />
          </PrivateRoute>
        }
      />
      <Route
        path="/relatorios"
        element={
          <PrivateRoute module="tournament" permission="reports">
            <Relatorios />
          </PrivateRoute>
        }
      />
      <Route
        path="/relatorios/torneio/:tournamentId"
        element={
          <PrivateRoute module="tournament" permission="reports">
            <RelatorioTorneio />
          </PrivateRoute>
        }
      />
      <Route
        path="/sangi"
        element={
          <PrivateRoute module="cash" anyPermission={["sangi", "cashier", "general_cash"]}>
            <Sangi />
          </PrivateRoute>
        }
      />
      <Route
        path="/alocacao/:tournamentId"
        element={
          <PrivateRoute module="tournament" permission="tables">
            <ManualAllocation />
          </PrivateRoute>
        }
      />
      <Route
        path="/alocacao/dia/:dayId"
        element={
          <PrivateRoute module="tournament" permission="tables">
            <TableManagement />
          </PrivateRoute>
        }
      />
      <Route
        path="/ranking/:tournamentId"
        element={
          <PrivateRoute module="tournament" permission="rankings">
            <TournamentRankings />
          </PrivateRoute>
        }
      />
      <Route
        path="/blinds/:dayId"
        element={
          <PrivateRoute module="tournament" permission="blinds">
            <BlindManagement />
          </PrivateRoute>
        }
      />
      <Route
        path="/control/:dayId"
        element={
          <PrivateRoute module="tournament" permission="tournaments">
            <TournamentControl />
          </PrivateRoute>
        }
      />
      <Route
        path="/broadcast/:id"
        element={<TournamentBroadcast />}
      />
      <Route path="/tv" element={<TVCode />} />
      <Route path="/tv/:code" element={<TVCode />} />
      {/* Resposta do jogador ao pedido de contatos (link do e-mail): pública. */}
      <Route path="/consentimento/:token" element={<ContactConsent />} />
      <Route
        path="/organizacoes"
        element={
          <PrivateRoute>
            <Organizacoes />
          </PrivateRoute>
        }
      />
      <Route
        path="/conflitos"
        element={
          <PrivateRoute>
            <SyncConflicts />
          </PrivateRoute>
        }
      />
      <Route
        path="/home"
        element={
          <PrivateRoute module="tournament" permission="dashboard">
            <Dashboard />
          </PrivateRoute>
        }
      />
      <Route
        path="/premiacao"
        element={
          <PrivateRoute module="tournament" permission="prizes">
            <PremiacaoSelector />
          </PrivateRoute>
        }
      />
      <Route
        path="/premiacao/:tournamentId"
        element={
          <PrivateRoute module="tournament" permission="prizes">
            <Premiacao />
          </PrivateRoute>
        }
      />
      {/* Placeholder routes — show ComingSoon instead of silent redirect (ISSUE-003) */}
      <Route
        path="/financeiro"
        element={
          <PrivateRoute permission="financial">
            <Financeiro />
          </PrivateRoute>
        }
      />
      {/* Segurança da conta: sem permissão e sem módulo. Proteger a própria
          conta não é privilégio de cargo — e quem tem o menor acesso do
          sistema precisa chegar aqui tanto quanto o dono do clube. */}
      <Route
        path="/seguranca"
        element={
          <PrivateRoute>
            <Seguranca />
          </PrivateRoute>
        }
      />
      <Route
        path="/funcionarios"
        element={
          <PrivateRoute permission="employees">
            <Funcionarios />
          </PrivateRoute>
        }
      />
      {['/eliminacao'].map((path) => (
        <Route
          key={path}
          path={path}
          element={
            <PrivateRoute>
              <ComingSoon />
            </PrivateRoute>
          }
        />
      ))}
      {/* Catch-all 404 — show NotFound page instead of silent redirect (ISSUE-009) */}
      <Route
        path="*"
        element={
          <PrivateRoute>
            <ComingSoon variant="notFound" />
          </PrivateRoute>
        }
      />
    </Routes>
    </Suspense>
  );
}

function App() {
  const { t } = useTranslation();
  return (
    <Router future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ConnectivityProvider>
        <AuthProvider>
          <PermissionProvider>
            <ModuleProvider>
              <CashDayProvider>
              <BarShiftProvider>
                <StageProvider>
                  <CurrencyProvider>
                    <PaymentMethodsProvider>
                      <BuyTypesProvider>
                        <ToastProvider>
                          <ErrorBoundary title={t('app.errorTitle')} subtitle={t('app.errorSubtitle')}>
                            <OfflineBanner />
                            <OrgScopeBanner />
                            <OrgInviteModal />
                            <AppRoutes />
                          </ErrorBoundary>
                        </ToastProvider>
                      </BuyTypesProvider>
                    </PaymentMethodsProvider>
                  </CurrencyProvider>
                </StageProvider>
              </BarShiftProvider>
              </CashDayProvider>
            </ModuleProvider>
          </PermissionProvider>
        </AuthProvider>
      </ConnectivityProvider>
    </Router>
  );
}

export default App;
