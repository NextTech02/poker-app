import React from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useConnectivity } from '../contexts/ConnectivityContext';
import './OfflineBanner.css';

/**
 * Barra fixa no topo: avisa quando OFFLINE (ações continuam, ficam na fila), quando
 * há pendências sincronizando, ou quando há CONFLITOS a revisar. Oculta quando
 * online, sem pendências e sem conflitos.
 */
const OfflineBanner = () => {
  const { t } = useTranslation();
  const { isOnline, pendingCount, conflictCount } = useConnectivity();

  if (isOnline && pendingCount === 0 && conflictCount === 0) return null;

  const pending = pendingCount > 0
    ? ` · ${pendingCount} ${t('offline.pending', 'pendência(s)')}`
    : '';

  if (!isOnline) {
    return (
      <div className="offline-banner offline-banner--off" role="status">
        <span className="offline-banner__dot" />
        {t('offline.offlineMsg', 'Modo offline — suas ações estão sendo salvas e serão enviadas quando a internet voltar')}
        {pending}
      </div>
    );
  }

  if (conflictCount > 0) {
    return (
      <Link to="/conflitos" className="offline-banner offline-banner--conflict" role="alert">
        <span className="offline-banner__dot" />
        {conflictCount} {t('offline.conflictsBanner', 'conflito(s) de sincronização — revisar')}
      </Link>
    );
  }

  return (
    <div className="offline-banner offline-banner--sync" role="status">
      <span className="offline-banner__spinner" />
      {t('offline.syncing', 'Sincronizando…')}
      {pending}
    </div>
  );
};

export default OfflineBanner;
