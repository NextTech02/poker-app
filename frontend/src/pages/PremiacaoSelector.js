import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import api from '../config/api';
import './PremiacaoSelector.css';

const formatDate = (dateStr) => {
  if (!dateStr) return null;
  return new Date(dateStr).toLocaleDateString('pt-BR', {
    day: '2-digit', month: 'long', year: 'numeric',
  });
};

const CARD_ACCENTS = [
  { from: '#d4af37', to: '#b8960a' }, // gold
  { from: '#60a5fa', to: '#2563eb' }, // blue
  { from: '#a78bfa', to: '#7c3aed' }, // purple
  { from: '#34d399', to: '#059669' }, // green
  { from: '#f87171', to: '#dc2626' }, // red
  { from: '#fb923c', to: '#ea580c' }, // orange
];

const PremiacaoSelector = () => {
  const navigate = useNavigate();
  const [tournaments, setTournaments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await api.get('/tournaments');
        const data = res.data || [];
        setTournaments(data);
        if (data.length === 1) {
          navigate(`/premiacao/${data[0].id}`, { replace: true });
        }
      } catch {
        setError('Erro ao carregar torneios');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [navigate]);

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content">

        {/* Header */}
        <div className="psel-header">
          <div className="psel-title-block">
            <div className="psel-trophy-icon">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94.63 1.5 1.98 2.63 3.61 2.96V17H7v2h10v-2h-4v-1.1c1.63-.33 2.98-1.46 3.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z"/>
              </svg>
            </div>
            <div>
              <h1>Premiações</h1>
              <p className="psel-subtitle">Selecione o torneio para registrar pagamentos</p>
            </div>
          </div>
        </div>

        {/* States */}
        {loading && <div className="psel-loading">Carregando torneios...</div>}
        {error   && <div className="psel-error">{error}</div>}

        {!loading && !error && tournaments.length === 0 && (
          <div className="psel-empty">
            <div className="psel-empty-icon">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94.63 1.5 1.98 2.63 3.61 2.96V17H7v2h10v-2h-4v-1.1c1.63-.33 2.98-1.46 3.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z"/>
              </svg>
            </div>
            <h3>Nenhum torneio encontrado</h3>
            <p>Não há torneios disponíveis nesta etapa</p>
          </div>
        )}

        {/* Grid */}
        {!loading && !error && tournaments.length > 0 && (
          <div className="psel-grid">
            {tournaments.map((t, i) => {
              const accent = CARD_ACCENTS[i % CARD_ACCENTS.length];
              const date = formatDate(t.created_at);
              return (
                <button
                  key={t.id}
                  className="psel-card"
                  style={{ '--accent-from': accent.from, '--accent-to': accent.to }}
                  onClick={() => navigate(`/premiacao/${t.id}`)}
                >
                  <div className="psel-card-accent-bar" />

                  <div className="psel-card-body">
                    <div className="psel-card-icon">
                      <svg viewBox="0 0 24 24" fill="currentColor">
                        <path d="M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94.63 1.5 1.98 2.63 3.61 2.96V17H7v2h10v-2h-4v-1.1c1.63-.33 2.98-1.46 3.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z"/>
                      </svg>
                    </div>
                    <div className="psel-card-info">
                      <div className="psel-card-name">{t.name}</div>
                      {date && <div className="psel-card-date">Criado em {date}</div>}
                    </div>
                  </div>

                  <div className="psel-card-cta">
                    <span>Registrar premiação</span>
                    <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                      <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z"/>
                    </svg>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
};

export default PremiacaoSelector;
