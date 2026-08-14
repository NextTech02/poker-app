import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import './ComingSoon.css';

const ComingSoon = ({ variant = 'comingSoon' }) => {
  const navigate = useNavigate();
  const { t } = useTranslation();

  const isNotFound = variant === 'notFound';
  const icon = isNotFound ? '404' : '🚧';
  const title = isNotFound
    ? t('notFound.title', 'Página não encontrada')
    : t('comingSoon.title', 'Em Construção');
  const subtitle = isNotFound
    ? t('notFound.subtitle', 'A página que você tentou acessar não existe ou foi movida.')
    : t('comingSoon.subtitle', 'Esta funcionalidade está sendo desenvolvida e em breve estará disponível.');

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content cs-main">
        <div className="cs-container">
          <div className="cs-icon">{icon}</div>
          <h1 className="cs-title">{title}</h1>
          <p className="cs-subtitle">{subtitle}</p>
          <button type="button" className="cs-btn" onClick={() => navigate('/')}>
            <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
              <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/>
            </svg>
            {t('comingSoon.backHome', 'Voltar ao Início')}
          </button>
        </div>
      </main>
    </div>
  );
};

export default ComingSoon;
