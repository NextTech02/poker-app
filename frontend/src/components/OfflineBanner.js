import React from 'react';
import { useTranslation } from 'react-i18next';
import { useConnectivity } from '../contexts/ConnectivityContext';
import './OfflineBanner.css';

/**
 * Barra fixa no topo que avisa quando o app está OFFLINE (as ações continuam,
 * ficam na fila) ou quando há pendências sincronizando. Fica oculta quando online
 * e sem pendências.
 */
const OfflineBanner = () => {
  const { t } = useTranslation();
  const { isOnline, pendingCount } = useConnectivity();

  if (isOnline && pendingCount === 0) return null;

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

  return (
    <div className="offline-banner offline-banner--sync" role="status">
      <span className="offline-banner__spinner" />
      {t('offline.syncing', 'Sincronizando…')}
      {pending}
    </div>
  );
};

export default OfflineBanner;
