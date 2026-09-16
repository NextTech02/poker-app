import React from 'react';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import EmptyState from '../components/EmptyState';

/**
 * Home do módulo de bar (POS de comandas). Esqueleto da Fase 0: garante a rota
 * e o pouso do cargo "Bar"; a operação chega nas fases seguintes.
 */
const BarPOS = () => {
  const { t } = useTranslation();
  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div>
            <h1>{t('bar.pos', 'Comandas')}</h1>
          </div>
        </div>
        <EmptyState
          icon="🍹"
          title={t('bar.title', 'Bar')}
          subtitle={t('comingSoon.subtitle', 'Esta funcionalidade está sendo desenvolvida e em breve estará disponível.')}
        />
      </main>
    </div>
  );
};

export default BarPOS;
