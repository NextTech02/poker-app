import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { currentOrgId, enterOrg } from '../utils/orgScope';
import './OrgSwitcher.css';

/**
 * Seletor de organização — para quem pertence a mais de um clube.
 *
 * Trocar exige um TOKEN NOVO: o RLS decide a partir do claim assinado, então
 * não basta avisar o backend. O fluxo é gravar a escolha, chamar
 * `refreshSession()` (o Auth Hook roda de novo e emite o token com a nova
 * organização) e recarregar para limpar todo o estado da org anterior.
 *
 * Só aparece com 2+ organizações — quem tem uma só não vê ruído na tela.
 */
const OrgSwitcher = ({ collapsed }) => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [orgs, setOrgs] = useState([]);
  const [current, setCurrent] = useState(null);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    let alive = true;
    api.get('/organizations/mine', { _silentError: true })
      .then((res) => {
        if (!alive) return;
        const list = res.data || [];
        setOrgs(list);
        // A org do token é a fonte da verdade do que está ativo agora.
        const activeId = currentOrgId();
        setCurrent(list.find((o) => o.id === activeId) || list.find((o) => o.is_active_org) || list[0] || null);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const switchTo = async (orgId) => {
    if (!orgId || orgId === current?.id || switching) return;
    setSwitching(true);
    try {
      await enterOrg(orgId);   // token novo + limpa etapa/cache + recarrega
    } catch (err) {
      toast.error(err.userMessage || t('organizations.errorSwitch', 'Não foi possível trocar de organização'));
      setSwitching(false);
    }
  };

  if (orgs.length < 2) return null;

  return (
    <div className={`org-switcher ${collapsed ? 'collapsed' : ''}`}>
      {!collapsed && (
        <span className="org-switcher-label">{t('organizations.current', 'Organização')}</span>
      )}
      <select
        className="org-switcher-select"
        value={current?.id || ''}
        onChange={(e) => switchTo(e.target.value)}
        disabled={switching}
        title={current?.name || ''}
      >
        {orgs.map((o) => (
          <option key={o.id} value={o.id}>{o.name}</option>
        ))}
      </select>
    </div>
  );
};

export default OrgSwitcher;
