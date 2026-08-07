import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../config/supabase';
import api from '../config/api';
import Button from '../components/Button';
import LanguageSelector from '../components/LanguageSelector';
import aceblindLogo from '../assets/aceblind-logo-white.png';
import './Login.css';

const Login = () => {
  const { t } = useTranslation();
  const [mode, setMode] = useState('signin'); // signin | forgot
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const { signIn } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    const { data, error } = await signIn(email, password);

    if (error) {
      setError(t('login.invalidCredentials'));
      setLoading(false);
      return;
    }

    // Grava o token já com a resposta do login: o interceptor do axios lê do
    // localStorage e o AuthContext pode ainda não ter processado o evento.
    const token = data?.session?.access_token;
    if (token) localStorage.setItem('supabase_token', token);

    // Quem trabalha em mais de um clube escolhe onde entrar — evita operar na
    // organização errada. Falha ao consultar não bloqueia o login.
    try {
      const res = await api.get('/organizations/mine', { _silentError: true });
      const orgs = res.data || [];
      if (orgs.length > 1) {
        navigate('/selecionar-organizacao', { state: { orgs } });
        return;
      }
    } catch (_) { /* segue para o app */ }

    navigate('/');
  };

  const handleForgot = async (e) => {
    e.preventDefault();
    setError('');
    setNotice('');
    setLoading(true);

    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/definir-senha`,
    });

    // Resposta idêntica exista ou não a conta: confirmar um e-mail cadastrado
    // entregaria a lista de usuários a quem tentasse adivinhar.
    setLoading(false);
    setNotice(t('login.resetSent', 'Se houver uma conta com esse e-mail, enviamos o link para redefinir a senha.'));
  };

  const goForgot = () => {
    setMode('forgot');
    setError('');
    setNotice('');
    setPassword('');
  };

  const goSignin = () => {
    setMode('signin');
    setError('');
    setNotice('');
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

        {mode === 'signin' ? (
          <form onSubmit={handleSubmit} className="login-form">
            {error && <div className="error-message">{error}</div>}

            <div className="form-group">
              <label htmlFor="email">{t('login.email')}</label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder={t('login.emailPlaceholder')}
              />
            </div>

            <div className="form-group">
              <label htmlFor="password">{t('login.password')}</label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                placeholder={t('login.passwordPlaceholder')}
              />
            </div>

            <Button type="submit" disabled={loading} className="login-btn">
              {loading ? t('login.submitting') : t('login.submit')}
            </Button>

            <button type="button" className="login-link" onClick={goForgot}>
              {t('login.forgotPassword', 'Esqueci minha senha')}
            </button>
          </form>
        ) : (
          <form onSubmit={handleForgot} className="login-form">
            {error && <div className="error-message">{error}</div>}
            {notice && <div className="login-notice">{notice}</div>}

            <p className="login-forgot-hint">
              {t('login.forgotHint', 'Informe seu e-mail e enviaremos um link para criar uma nova senha.')}
            </p>

            <div className="form-group">
              <label htmlFor="forgot-email">{t('login.email')}</label>
              <input
                id="forgot-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder={t('login.emailPlaceholder')}
              />
            </div>

            <Button type="submit" disabled={loading} className="login-btn">
              {loading ? t('login.sending', 'Enviando...') : t('login.sendResetLink', 'Enviar link')}
            </Button>

            <button type="button" className="login-link" onClick={goSignin}>
              {t('login.backToSignin', 'Voltar para o login')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
};

export default Login;
