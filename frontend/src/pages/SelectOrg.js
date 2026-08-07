import React, { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { supabase } from '../config/supabase';
import { useAuth } from '../contexts/AuthContext';
import api from '../config/api';
import LanguageSelector from '../components/LanguageSelector';
import aceblindLogo from '../assets/aceblind-logo-white.png';
import './Login.css';
import './SelectOrg.css';

/**
 * Escolha da organização logo após o login — para quem trabalha em mais de um
 * clube. Evita começar a operar no clube errado (o risco real: registrar um
 * buy-in na organização de outro cliente).
 *
 * Trocar de organização exige TOKEN NOVO: o isolamento (RLS) decide pelo claim
 * assinado, então gravamos a escolha, pedimos `refreshSession()` e recarregamos
 * a aplicação — mesmo fluxo do seletor do menu lateral.
 *
 * Quem pertence a uma única organização nunca vê esta tela.
 */
const SelectOrg = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { signOut } = useAuth();

  // A lista costuma vir da tela de login (evita uma segunda chamada).
  const [orgs, setOrgs] = useState(location.state?.orgs || null);
  const [entering, setEntering] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (orgs) return;
    let alive = true;
    api.get('/organizations/mine', { _silentError: true })
      .then((res) => {
        if (!alive) return;
        const list = res.data || [];
        // Sem escolha a fazer: segue direto para o app.
        if (list.length < 2) navigate('/', { replace: true });
        else setOrgs(list);
      })
      .catch(() => { if (alive) navigate('/', { replace: true }); });
    return () => { alive = false; };
  }, [orgs, navigate]);

  const enter = useCallback(async (org) => {
    if (entering) return;
    setError('');
    setEntering(org.id);
    try {
      // Já é a organização do token atual: não precisa emitir outro.
      if (!org.is_active_org) {
        await api.post('/organizations/switch', { organization_id: org.id });
        const { error: refErr } = await supabase.auth.refreshSession();
        if (refErr) throw refErr;
      }
      // Recarrega para o app inteiro nascer com a organização escolhida.
      window.location.href = '/';
    } catch (err) {
      setError(err.userMessage || t('selectOrg.error', 'Não foi possível entrar nesta organização.'));
      setEntering(null);
    }
  }, [entering, t]);

  const handleSignOut = async () => {
    await signOut();
    navigate('/login', { replace: true });
  };

  return (
    <div className="login-container">
      <div className="login-language-selector">
        <LanguageSelector />
      </div>

      <div className="login-card so-card">
        <div className="login-header">
          <img src={aceblindLogo} alt="AceBlind" className="login-logo" />
        </div>

        <h2 className="so-title">{t('selectOrg.title', 'Escolha a organização')}</h2>
        <p className="so-hint">
          {t('selectOrg.subtitle', 'Você tem acesso a mais de um clube. Selecione onde quer trabalhar agora.')}
        </p>

        {error && <div className="error-message">{error}</div>}

        {!orgs ? (
          <p className="so-loading">{t('common.loading', 'Carregando...')}</p>
        ) : (
          <ul className="so-list">
            {orgs.map((o) => (
              <li key={o.id}>
                <button
                  type="button"
                  className={`so-item ${entering === o.id ? 'loading' : ''}`}
                  onClick={() => enter(o)}
                  disabled={!!entering}
                >
                  <span className="so-avatar" aria-hidden="true">
                    {(o.name || '?').trim().charAt(0).toUpperCase()}
                  </span>
                  <span className="so-info">
                    <span className="so-name">{o.name}</span>
                    <span className="so-meta">
                      {o.group_name || t('selectOrg.noRole', 'Sem grupo')}
                      {o.is_active_org && (
                        <span className="so-badge">{t('selectOrg.lastUsed', 'Última usada')}</span>
                      )}
                    </span>
                  </span>
                  <span className="so-arrow" aria-hidden="true">
                    {entering === o.id ? '…' : '›'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <button type="button" className="so-signout" onClick={handleSignOut} disabled={!!entering}>
          {t('selectOrg.signOut', 'Sair')}
        </button>
      </div>
    </div>
  );
};

export default SelectOrg;
