import React, { Suspense, lazy, useEffect, useRef } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { StageProvider } from './contexts/StageContext';
import { ToastProvider, useToast } from './contexts/ToastContext';
import { PermissionProvider, usePermissions } from './contexts/PermissionContext';
import { CurrencyProvider } from './contexts/CurrencyContext';
import { PaymentMethodsProvider } from './contexts/PaymentMethodsContext';
import { BuyTypesProvider } from './contexts/BuyTypesContext';
import { ConnectivityProvider } from './contexts/ConnectivityContext';
import OfflineBanner from './components/OfflineBanner';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Etapas from './pages/Etapas';
import Torneios from './pages/Torneios';
import Players from './pages/Players';
import Caixa from './pages/Caixa';
import ComingSoon from './pages/ComingSoon';
import ErrorBoundary from './components/ErrorBoundary';
import './styles/App.css';
import './components/SkeletonLoader.css';

// Lazy-load less-frequented pages (B4)
const TournamentBroadcast = lazy(() => import('./pages/TournamentBroadcast'));
const TournamentDetail = lazy(() => import('./pages/TournamentDetail'));
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
const TournamentControl = lazy(() => import('./pages/TournamentControl'));
const CaixaJogadores = lazy(() => import('./pages/CaixaJogadores'));
const SatelliteTickets = lazy(() => import('./pages/SatelliteTickets'));
const CaixaGeral = lazy(() => import('./pages/CaixaGeral'));
const Relatorios = lazy(() => import('./pages/Relatorios'));
const RelatorioTorneio = lazy(() => import('./pages/RelatorioTorneio'));
const Sangi = lazy(() => import('./pages/Sangi'));
const Financeiro = lazy(() => import('./pages/Financeiro'));
const Funcionarios = lazy(() => import('./pages/Funcionarios'));

const PageFallback = () => (
  <div className="page-loading-skeleton">
    <div className="skeleton-bar skeleton-bar--wide" />
    <div className="skeleton-bar skeleton-bar--medium" />
    <div className="skeleton-bar skeleton-bar--narrow" />
  </div>
);

const PrivateRoute = ({ children, permission, anyPermission }) => {
  const { user, loading } = useAuth();
  const { hasPermission, loading: permLoading } = usePermissions();
  const { toast } = useToast();
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
      toast.warning('Você não tem permissão para acessar esta página.');
    }
  }, [denied, toast]);

  // Show loading while auth or permissions are resolving,
  // or while we have a token but user hasn't loaded yet (token refresh in progress)
  if (loading || permLoading || (!user && hasToken)) {
    return <div className="loading">Carregando...</div>;
  }

  if (!user) return <Navigate to="/login" />;

  if (denied) {
    return <Navigate to="/" replace />;
  }

  return children;
};

function AppRoutes() {
  return (
    <Suspense fallback={<PageFallback />}>
      <Routes>
        <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <PrivateRoute>
            <Dashboard />
          </PrivateRoute>
        }
      />
      <Route
        path="/etapas"
        element={
          <PrivateRoute permission="stages">
            <Etapas />
          </PrivateRoute>
        }
      />
      <Route
        path="/torneios"
        element={
          <PrivateRoute permission="tournaments">
            <Torneios />
          </PrivateRoute>
        }
      />
      <Route
        path="/blinds-templates"
        element={
          <PrivateRoute permission="tournaments">
            <BlindTemplates />
          </PrivateRoute>
        }
      />
      <Route
        path="/torneios/:id"
        element={
          <PrivateRoute permission="tournaments">
            <TournamentDetail />
          </PrivateRoute>
        }
      />
      <Route
        path="/torneios/:tournamentId/dia/novo"
        element={
          <PrivateRoute permission="tournaments">
            <TournamentDayForm />
          </PrivateRoute>
        }
      />
      <Route
        path="/torneios/:tournamentId/dia/editar/:dayId"
        element={
          <PrivateRoute permission="tournaments">
            <TournamentDayForm />
          </PrivateRoute>
        }
      />
      <Route
        path="/torneios/:tournamentId/dia/:dayId/broadcast"
        element={
          <PrivateRoute permission="broadcast">
            <BroadcastSettings />
          </PrivateRoute>
        }
      />
      <Route
        path="/torneios/dia/:dayId/estatisticas"
        element={
          <PrivateRoute permission="tournaments">
            <TournamentDayStats />
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
        path="/caixa"
        element={
          <PrivateRoute permission="cashier">
            <Caixa />
          </PrivateRoute>
        }
      />
      <Route
        path="/caixa/jogadores"
        element={
          <PrivateRoute permission="cashier_players">
            <CaixaJogadores />
          </PrivateRoute>
        }
      />
      <Route
        path="/caixa/tickets"
        element={
          <PrivateRoute permission="cashier_tickets">
            <SatelliteTickets />
          </PrivateRoute>
        }
      />
      <Route
        path="/caixa-geral"
        element={
          <PrivateRoute permission="general_cash">
            <CaixaGeral />
          </PrivateRoute>
        }
      />
      <Route
        path="/relatorios"
        element={
          <PrivateRoute permission="reports">
            <Relatorios />
          </PrivateRoute>
        }
      />
      <Route
        path="/relatorios/torneio/:tournamentId"
        element={
          <PrivateRoute permission="reports">
            <RelatorioTorneio />
          </PrivateRoute>
        }
      />
      <Route
        path="/sangi"
        element={
          <PrivateRoute anyPermission={["sangi", "cashier", "general_cash"]}>
            <Sangi />
          </PrivateRoute>
        }
      />
      <Route
        path="/alocacao/:tournamentId"
        element={
          <PrivateRoute permission="tables">
            <ManualAllocation />
          </PrivateRoute>
        }
      />
      <Route
        path="/alocacao/dia/:dayId"
        element={
          <PrivateRoute permission="tables">
            <TableManagement />
          </PrivateRoute>
        }
      />
      <Route
        path="/ranking/:tournamentId"
        element={
          <PrivateRoute permission="rankings">
            <TournamentRankings />
          </PrivateRoute>
        }
      />
      <Route
        path="/blinds/:dayId"
        element={
          <PrivateRoute permission="blinds">
            <BlindManagement />
          </PrivateRoute>
        }
      />
      <Route
        path="/control/:dayId"
        element={
          <PrivateRoute permission="tournaments">
            <TournamentControl />
          </PrivateRoute>
        }
      />
      <Route
        path="/broadcast/:id"
        element={<TournamentBroadcast />}
      />
      <Route
        path="/home"
        element={
          <PrivateRoute>
            <Dashboard />
          </PrivateRoute>
        }
      />
      <Route
        path="/premiacao"
        element={
          <PrivateRoute permission="prizes">
            <PremiacaoSelector />
          </PrivateRoute>
        }
      />
      <Route
        path="/premiacao/:tournamentId"
        element={
          <PrivateRoute permission="prizes">
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
  return (
    <Router future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ConnectivityProvider>
        <AuthProvider>
          <PermissionProvider>
            <StageProvider>
              <CurrencyProvider>
                <PaymentMethodsProvider>
                  <BuyTypesProvider>
                    <ToastProvider>
                      <ErrorBoundary title="Erro na aplicação" subtitle="Recarregue a página para continuar.">
                        <OfflineBanner />
                        <AppRoutes />
                      </ErrorBoundary>
                    </ToastProvider>
                  </BuyTypesProvider>
                </PaymentMethodsProvider>
              </CurrencyProvider>
            </StageProvider>
          </PermissionProvider>
        </AuthProvider>
      </ConnectivityProvider>
    </Router>
  );
}

export default App;
