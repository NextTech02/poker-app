import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { supabase } from '../config/supabase';
import Button from '../components/Button';
import LanguageSelector from '../components/LanguageSelector';
import aceblindLogo from '../assets/aceblind-logo-white.png';
import './Login.css';
import './SetPassword.css';

/**
 * Destino do link de convite (e do "esqueci minha senha").
 *
 * O Supabase manda o usuário para cá com a sessão no fragmento da URL; o
 * supabase-js detecta e autentica sozinho. Em vez de já jogar o usuário no app
 * (que era o efeito de apontar o convite para /login), aqui ele DEFINE a própria
 * senha antes de entrar — o convite deixa de ser um login automático.
 */
const SetPassword = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [status, setStatus] = useState('checking'); // checking | ready | invalid
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let done = false;

    // Link expirado/já usado volta com erro no fragmento, sem sessão.
    const hash = window.location.hash || '';
    if (hash.includes('error=')) {
      setStatus('invalid');
      return undefined;
    }

    const accept = (session) => {
      if (done || !session) return;
      done = true;
      setEmail(session.user?.email || '');
      setStatus('ready');
    };

    supabase.auth.getSession().then(({ data }) => accept(data?.session));

    // A sessão do convite pode chegar logo depois (o SDK processa a URL).
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => accept(session)
    );

    // Sem sessão em alguns segundos = link inválido ou expirado.
    const timer = setTimeout(() => { if (!done) setStatus('invalid'); }, 4000);

    return () => { subscription.unsubscribe(); clearTimeout(timer); };
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (password.length < 8) {
      setError(t('setPassword.tooShort', 'A senha precisa ter pelo menos 8 caracteres.'));
      return;
    }
    if (password !== confirm) {
      setError(t('setPassword.mismatch', 'As senhas não coincidem.'));
      return;
    }

    setSaving(true);
    const { error: upErr } = await supabase.auth.updateUser({ password });
    setSaving(false);

    if (upErr) {
      setError(upErr.message || t('setPassword.saveError', 'Não foi possível definir a senha.'));
      return;
    }
    navigate('/');
  };

  return (
    <div className="login-container">
      <div className="login-language-selector">
        <LanguageSelector />
      </div>
      <div className="login-card">
        <div className="login-header">
          <img src={aceblindLogo} alt="AceBlind" className="login-logo" />
        </div>

        {status === 'checking' && (
          <p className="sp-state">{t('common.loading', 'Carregando...')}</p>
        )}

        {status === 'invalid' && (
          <div className="sp-state">
            <h2 className="sp-title">{t('setPassword.invalidTitle', 'Link inválido ou expirado')}</h2>
            <p className="sp-hint">
              {t('setPassword.invalidHint', 'Peça um novo convite ao administrador ou use "esqueci minha senha" na tela de login.')}
            </p>
            <Button type="button" className="login-btn" onClick={() => navigate('/login')}>
              {t('setPassword.goToLogin', 'Ir para o login')}
            </Button>
          </div>
        )}

        {status === 'ready' && (
          <>
            <h2 className="sp-title">{t('setPassword.title', 'Bem-vindo! Defina sua senha')}</h2>
            <p className="sp-hint">
              {email
                ? t('setPassword.subtitleEmail', 'Você está criando o acesso de {{email}}.', { email })
                : t('setPassword.subtitle', 'Escolha uma senha para acessar sua conta.')}
            </p>

            <form onSubmit={handleSubmit} className="login-form">
              {error && <div className="error-message">{error}</div>}

              <div className="form-group">
                <label htmlFor="sp-password">{t('setPassword.newPassword', 'Nova senha')}</label>
                <input
                  id="sp-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="new-password"
                  placeholder={t('setPassword.newPasswordPlaceholder', 'Mínimo de 8 caracteres')}
                />
              </div>

              <div className="form-group">
                <label htmlFor="sp-confirm">{t('setPassword.confirmPassword', 'Confirme a senha')}</label>
                <input
                  id="sp-confirm"
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  autoComplete="new-password"
                  placeholder={t('setPassword.confirmPasswordPlaceholder', 'Repita a senha')}
                />
              </div>

              <Button type="submit" disabled={saving} className="login-btn">
                {saving ? t('setPassword.saving', 'Salvando...') : t('setPassword.submit', 'Definir senha e entrar')}
              </Button>
            </form>
          </>
        )}
      </div>
    </div>
  );
};

export default SetPassword;
