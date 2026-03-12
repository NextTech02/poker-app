import React, { Suspense, lazy } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { StageProvider } from './contexts/StageContext';
import { ToastProvider } from './contexts/ToastContext';
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
const BroadcastSettings = lazy(() => import('./pages/BroadcastSettings'));
const TournamentDayStats = lazy(() => import('./pages/TournamentDayStats'));
const TournamentControl = lazy(() => import('./pages/TournamentControl'));
const CaixaGeral = lazy(() => import('./pages/CaixaGeral'));
const Relatorios = lazy(() => import('./pages/Relatorios'));

const PageFallback = () => (
  <div className="page-loading-skeleton">
    <div className="skeleton-bar skeleton-bar--wide" />
    <div className="skeleton-bar skeleton-bar--medium" />
    <div className="skeleton-bar skeleton-bar--narrow" />
  </div>
);

const PrivateRoute = ({ children }) => {
  const { user, loading } = useAuth();

  if (loading) {
    return <div className="loading">Carregando...</div>;
  }

  return user ? children : <Navigate to="/login" />;
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
          <PrivateRoute>
            <Etapas />
          </PrivateRoute>
        }
      />
      <Route
        path="/torneios"
        element={
          <PrivateRoute>
            <Torneios />
          </PrivateRoute>
        }
      />
      <Route
        path="/torneios/:id"
        element={
          <PrivateRoute>
            <TournamentDetail />
          </PrivateRoute>
        }
      />
      <Route
        path="/torneios/:tournamentId/dia/novo"
        element={
          <PrivateRoute>
            <TournamentDayForm />
          </PrivateRoute>
        }
      />
      <Route
        path="/torneios/:tournamentId/dia/editar/:dayId"
        element={
          <PrivateRoute>
            <TournamentDayForm />
          </PrivateRoute>
        }
      />
      <Route
        path="/torneios/:tournamentId/dia/:dayId/broadcast"
        element={
          <PrivateRoute>
            <BroadcastSettings />
          </PrivateRoute>
        }
      />
      <Route
        path="/torneios/dia/:dayId/estatisticas"
        element={
          <PrivateRoute>
            <TournamentDayStats />
          </PrivateRoute>
        }
      />
      <Route
        path="/jogadores"
        element={
          <PrivateRoute>
            <Players />
          </PrivateRoute>
        }
      />
      <Route
        path="/caixa"
        element={
          <PrivateRoute>
            <Caixa />
          </PrivateRoute>
        }
      />
      <Route
        path="/caixa-geral"
        element={
          <PrivateRoute>
            <CaixaGeral />
          </PrivateRoute>
        }
      />
      <Route
        path="/relatorios"
        element={
          <PrivateRoute>
            <Relatorios />
          </PrivateRoute>
        }
      />
      <Route
        path="/alocacao/:tournamentId"
        element={
          <PrivateRoute>
            <ManualAllocation />
          </PrivateRoute>
        }
      />
      <Route
        path="/alocacao/dia/:dayId"
        element={
          <PrivateRoute>
            <TableManagement />
          </PrivateRoute>
        }
      />
      <Route
        path="/ranking/:tournamentId"
        element={
          <PrivateRoute>
            <TournamentRankings />
          </PrivateRoute>
        }
      />
      <Route
        path="/blinds/:dayId"
        element={
          <PrivateRoute>
            <BlindManagement />
          </PrivateRoute>
        }
      />
      <Route
        path="/control/:dayId"
        element={
          <PrivateRoute>
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
          <PrivateRoute>
            <PremiacaoSelector />
          </PrivateRoute>
        }
      />
      <Route
        path="/premiacao/:tournamentId"
        element={
          <PrivateRoute>
            <Premiacao />
          </PrivateRoute>
        }
      />
      {/* Placeholder routes — show ComingSoon instead of silent redirect (ISSUE-003) */}
      {['/sit-and-go', '/vagas', '/rankings', '/financeiro', '/imprensa', '/templates', '/funcionarios', '/eliminacao'].map((path) => (
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
      {/* Catch-all 404 — redirect unknown routes to dashboard */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </Suspense>
  );
}

function App() {
  return (
    <Router>
      <AuthProvider>
        <StageProvider>
          <ToastProvider>
            {/* B2.2: ErrorBoundary global envolve toda a aplicação */}
            <ErrorBoundary title="Erro na aplicação" subtitle="Recarregue a página para continuar.">
              <AppRoutes />
            </ErrorBoundary>
          </ToastProvider>
        </StageProvider>
      </AuthProvider>
    </Router>
  );
}

export default App;
