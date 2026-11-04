import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { currentOrgId, enterOrg } from '../utils/orgScope';
import { cachedGet, cachedValue } from '../utils/apiCache';
import './OrgSwitcher.css';

// O menu lateral é remontado a cada tela, e este seletor vai junto: sem cache,
// era uma ida ao servidor por navegação. As organizações de alguém quase nunca
// mudam — e trocar de organização já limpa o cache e recarrega a página.
const URL_DAS_ORGS = '/organizations/mine';
const VALIDADE_DAS_ORGS_MS = 5 * 60 * 1000;

const orgAtual = (list) => {
  // A org do token é a fonte da verdade do que está ativo agora.
  const activeId = currentOrgId();
  return list.find((o) => o.id === activeId) || list.find((o) => o.is_active_org) || list[0] || null;
};

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
  // Começa com o que já está em memória: trocar de tela não pisca o seletor.
  const [orgs, setOrgs] = useState(() => cachedValue(URL_DAS_ORGS) || []);
  const [current, setCurrent] = useState(() => orgAtual(cachedValue(URL_DAS_ORGS) || []));
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    let alive = true;
    cachedGet(api, URL_DAS_ORGS, VALIDADE_DAS_ORGS_MS, null, { _silentError: true })
      .then((data) => {
        if (!alive) return;
        const list = data || [];
        setOrgs(list);
        setCurrent(orgAtual(list));
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
