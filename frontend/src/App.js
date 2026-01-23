import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { StageProvider } from './contexts/StageContext';
import SelectedStageBar from './components/SelectedStageBar';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Etapas from './pages/Etapas';
import Torneios from './pages/Torneios';
import TournamentBroadcast from './pages/TournamentBroadcast';
import TournamentDetail from './pages/TournamentDetail';
import EliminacaoJogadores from './pages/EliminacaoJogadores';
import ManualAllocation from './pages/ManualAllocation';
import TournamentRankings from './pages/TournamentRankings';
import BlindManagement from './pages/BlindManagement';
import Premiacao from './pages/Premiacao';
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
        path="/eliminacao"
        element={
          <PrivateRoute>
            <EliminacaoJogadores />
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
        path="/broadcast/:id"
        element={<TournamentBroadcast />}
      />
      <Route
        path="/periodos"
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
          <AppRoutes />
        </StageProvider>
      </AuthProvider>
    </Router>
  );
}

export default App;
