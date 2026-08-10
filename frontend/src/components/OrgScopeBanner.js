import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { currentOrgId, isPlatformAdminToken, enterOrg } from '../utils/orgScope';
import './OrgScopeBanner.css';

/**
 * Faixa fixa avisando que o admin da plataforma está DENTRO da organização de
 * um cliente.
 *
 * O risco que isso evita é concreto: escopado num clube, o app fica idêntico
 * ao normal — cadastrar torneio, mexer no caixa e convidar funcionário gravam
 * na organização do CLIENTE. Sem um aviso permanente é fácil operar no clube
 * errado sem perceber.
 *
 * Só aparece quando a organização do token não é uma das do próprio usuário.
 */
const OrgScopeBanner = () => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [scope, setScope] = useState(null);   // { name, homeOrgId }
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (!isPlatformAdminToken()) return;
    const activeId = currentOrgId();
    if (!activeId) return;

    let alive = true;
    (async () => {
      try {
        const [mineRes, allRes] = await Promise.all([
          api.get('/organizations/mine', { _silentError: true }),
          api.get('/organizations', { _silentError: true }),
        ]);
        if (!alive) return;

        const mine = mineRes.data || [];
        // Está numa organização própria: nada a avisar.
        if (mine.some((o) => o.id === activeId)) return;

        const org = (allRes.data || []).find((o) => o.id === activeId);
        setScope({
          name: org?.name || t('organizations.unknownOrg', 'outra organização'),
          homeOrgId: mine[0]?.id || null,
        });
      } catch (_) {
        /* sem permissão ou offline: não atrapalha a operação */
      }
    })();
    return () => { alive = false; };
  }, [t]);

  const leave = useCallback(async () => {
    if (!scope?.homeOrgId || leaving) return;
    setLeaving(true);
    try {
      await enterOrg(scope.homeOrgId, '/organizacoes');
    } catch (err) {
      toast.error(err.userMessage || t('organizations.errorLeave', 'Não foi possível sair desta organização'));
      setLeaving(false);
    }
  }, [scope, leaving, toast, t]);

  if (!scope) return null;

  return (
    <div className="org-scope-banner" role="status">
      <span className="osb-dot" aria-hidden="true" />
      <span className="osb-text">
        {t('organizations.viewingAs', 'Visualizando')}
        {' '}
        <strong>{scope.name}</strong>
      </span>
      {scope.homeOrgId && (
        <button type="button" className="osb-exit" onClick={leave} disabled={leaving}>
          {leaving ? t('common.loading', 'Carregando...') : t('organizations.leave', 'Sair')}
        </button>
      )}
    </div>
  );
};

export default OrgScopeBanner;
