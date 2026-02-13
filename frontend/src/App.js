import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { StageProvider } from './contexts/StageContext';
import { ToastProvider } from './contexts/ToastContext';
import SelectedStageBar from './components/SelectedStageBar';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Etapas from './pages/Etapas';
import Torneios from './pages/Torneios';
import TournamentBroadcast from './pages/TournamentBroadcast';
import TournamentDetail from './pages/TournamentDetail';
import ManualAllocation from './pages/ManualAllocation';
import TournamentRankings from './pages/TournamentRankings';
import BlindManagement from './pages/BlindManagement';
import Premiacao from './pages/Premiacao';
import TournamentDayForm from './pages/TournamentDayForm';
import TournamentDayStats from './pages/TournamentDayStats';
import TournamentControl from './pages/TournamentControl';
import Players from './pages/Players';
import Caixa from './pages/Caixa';
import CaixaGeral from './pages/CaixaGeral';
import Relatorios from './pages/Relatorios';
import './styles/App.css';

const PrivateRoute = ({ children }) => {
  const { user, loading } = useAuth();

  if (loading) {
    return <div className="loading">Carregando...</div>;
  }

  return user ? children : <Navigate to="/login" />;
};

function AppRoutes() {
  const { user } = useAuth();

  return (
    <>
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
        path="/premiacao/:tournamentId"
        element={
          <PrivateRoute>
            <Premiacao />
          </PrivateRoute>
        }
      />
      <Route
        path="/sit-and-go"
        element={
          <PrivateRoute>
            <Dashboard />
          </PrivateRoute>
        }
      />
      <Route
        path="/vagas"
        element={
          <PrivateRoute>
            <Dashboard />
          </PrivateRoute>
        }
      />
      <Route
        path="/rankings"
        element={
          <PrivateRoute>
            <Dashboard />
          </PrivateRoute>
        }
      />
      <Route
        path="/financeiro"
        element={
          <PrivateRoute>
            <Dashboard />
          </PrivateRoute>
        }
      />
      <Route
        path="/imprensa"
        element={
          <PrivateRoute>
            <Dashboard />
          </PrivateRoute>
        }
      />
      <Route
        path="/templates"
        element={
          <PrivateRoute>
            <Dashboard />
          </PrivateRoute>
        }
      />
      <Route
        path="/funcionarios"
        element={
          <PrivateRoute>
            <Dashboard />
          </PrivateRoute>
        }
      />
    </Routes>
    </>
  );
}

function App() {
  return (
    <Router>
      <AuthProvider>
        <StageProvider>
          <ToastProvider>
            <AppRoutes />
          </ToastProvider>
        </StageProvider>
      </AuthProvider>
    </Router>
  );
}

export default App;
