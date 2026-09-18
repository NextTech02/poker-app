import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../config/supabase';
import api from '../config/api';
import Button from '../components/Button';
import LanguageSelector from '../components/LanguageSelector';
import Captcha, { captchaAtivo } from '../components/Captcha';
import aceblindLogo from '../assets/aceblind-logo-white.png';
import './Login.css';
import Icon from '../components/Icon';

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
  const captchaRef = useRef(null);

  /**
   * Link de e-mail expirado cai AQUI, não na tela de cadastro: quando o
   * Supabase não consegue validar o link, ele manda para a URL do site com o
   * erro no fragmento. Sem tratar, a pessoa via só o formulário de login e
   * não entendia por que o convite "não funcionou".
   */
  useEffect(() => {
    const frag = window.location.hash || '';
    const busca = window.location.search || '';
    if (!frag.includes('error') && !busca.includes('error')) return;

    const p = new URLSearchParams((frag.startsWith('#') ? frag.slice(1) : frag) || busca.slice(1));
    const code = p.get('error_code') || '';
    const desc = p.get('error_description') || '';

    setError(
      code.includes('expired') || desc.toLowerCase().includes('expired')
        ? t('login.linkExpired',
             'Este link expirou. Peça um novo convite ao administrador, ou use "Esqueci minha senha" para receber outro link.')
        : t('login.linkInvalid',
             'Não foi possível validar este link. Peça um novo ao administrador.')
    );
    // Limpa a URL para o aviso não voltar a cada recarga.
    window.history.replaceState({}, '', window.location.pathname);
  }, [t]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    let captchaToken;
    try {
      captchaToken = await captchaRef.current?.getToken();
    } catch (_) {
      setLoading(false);
      setError(t('login.captchaFailed', 'Não foi possível concluir a verificação de segurança. Tente de novo.'));
      return;
    }

    const { data, error } = await signIn(email, password, captchaToken);

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

    let captchaToken;
    try {
      captchaToken = await captchaRef.current?.getToken();
    } catch (_) {
      setLoading(false);
      setError(t('login.captchaFailed', 'Não foi possível concluir a verificação de segurança. Tente de novo.'));
      return;
    }

    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/definir-senha`,
      captchaToken,
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
      {/* Painel da marca: a assinatura do manual de identidade e os três
          módulos. É a primeira tela que um clube novo vê. */}
      <aside className="login-brand" aria-hidden="true">
        <img src={aceblindLogo} alt="" className="login-brand-logo" />
        <div>
          <p className="login-tagline">
            {t('login.tagline1', 'Mais controle.')}<br />{t('login.tagline2', 'Menos complicação.')}
          </p>
          <p className="login-tagline-sub">
            {t('login.taglineSub', 'O sistema operacional do poker que mantém sua operação em jogo — torneios, cash game e bar num só lugar.')}
          </p>
          <div className="login-modules">
            <span><Icon name="trophy-cup" />{t('modules.tournamentTitle', 'Torneios')}</span>
            <span><Icon name="chips" />{t('modules.cashTitle', 'Cash Game')}</span>
            <span><Icon name="cocktail" />{t('modules.barTitle', 'Bar')}</span>
          </div>
        </div>
        <div className="login-brand-foot">aceblind.net · Poker Management</div>
      </aside>

      <div className="login-side">
      <div className="login-language-selector">
        <LanguageSelector />
      </div>
      <div className="login-card">
        <div className="login-header">
          <img src={aceblindLogo} alt="AceBlind" className="login-logo" />
          <h1>{mode === 'signin' ? t('login.enter', 'Entrar') : t('login.forgotPassword')}</h1>
          {mode === 'signin' && <p>{t('login.enterHint', 'Use o e-mail cadastrado pelo administrador do seu clube.')}</p>}
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

        {/* Fora dos dois formulários de propósito: eles se alternam, e um
            captcha dentro de cada seria desmontado a cada troca de modo,
            invalidando a referência no meio do envio. */}
        <Captcha ref={captchaRef} />

        {/* No modo invisível não existe widget na tela. O aviso é exigido pelo
            hCaptcha nesse formato — e serve para o operador saber que a
            proteção está ativa, já que nada aparece até haver desafio. */}
        {captchaAtivo() && (
          <p className="login-captcha-aviso">
            {t('login.captchaNotice', 'Protegido por hCaptcha —')}{' '}
            <a href="https://hcaptcha.com/privacy" target="_blank" rel="noreferrer noopener">
              {t('login.captchaPrivacy', 'Privacidade')}
            </a>
            {' · '}
            <a href="https://hcaptcha.com/terms" target="_blank" rel="noreferrer noopener">
              {t('login.captchaTerms', 'Termos')}
            </a>
          </p>
        )}
      </div>
      </div>
    </div>
  );
};

export default Login;
