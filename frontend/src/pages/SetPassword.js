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
 * Destino de DOIS fluxos que chegam por e-mail:
 *
 *  • convite (type=invite)   → cadastro inicial: nome + senha, uso único.
 *  • recuperação (recovery)  → apenas a nova senha, quantas vezes precisar.
 *
 * O Supabase manda o usuário para cá com a sessão no fragmento da URL e o
 * supabase-js autentica sozinho. Em vez de já jogar no app, aqui ele conclui o
 * que precisa antes de entrar.
 *
 * A recuperação é reconhecida pelo evento PASSWORD_RECOVERY (sinal confiável,
 * mesmo depois de o SDK limpar o fragmento) e, como reforço, pelo `type` na URL.
 */
const SetPassword = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [mode, setMode] = useState('invite');       // invite | recovery
  const [status, setStatus] = useState('checking'); // checking | ready | invalid | used
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [onboardedAt, setOnboardedAt] = useState(null);

  useEffect(() => {
    let done = false;

    const hash = window.location.hash || '';
    // Link expirado/já usado volta com erro no fragmento, sem sessão.
    if (hash.includes('error=')) {
      setStatus('invalid');
      return undefined;
    }
    if (hash.includes('type=recovery')) setMode('recovery');

    const accept = (session) => {
      if (done || !session) return;
      done = true;
      const meta = session.user?.user_metadata || {};
      setEmail(session.user?.email || '');
      setName(meta.full_name || '');
      setOnboardedAt(meta.onboarded_at || null);
      // Convite já concluído → uso único. (Se for recuperação, o efeito abaixo
      // libera a tela: trocar a senha pode ser feito quantas vezes precisar.)
      setStatus(meta.onboarded_at ? 'used' : 'ready');
    };

    supabase.auth.getSession().then(({ data }) => accept(data?.session));

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        if (event === 'PASSWORD_RECOVERY') setMode('recovery');
        accept(session);
      }
    );

    // Sem sessão em alguns segundos = link inválido ou expirado.
    const timer = setTimeout(() => { if (!done) setStatus('invalid'); }, 4000);

    return () => { subscription.unsubscribe(); clearTimeout(timer); };
  }, []);

  // Recuperação nunca é bloqueada pelo "já utilizado" do convite.
  useEffect(() => {
    if (mode === 'recovery' && status === 'used') setStatus('ready');
  }, [mode, status]);

  /**
   * O que decide se ainda falta CADASTRO é a conta nunca ter concluído
   * (`onboarded_at`) — não o caminho pelo qual a pessoa chegou.
   *
   * Isso importa porque, com o convite expirado, ela recorre a "Esqueci minha
   * senha". Se esse caminho apenas trocasse a senha, `onboarded_at` nunca seria
   * gravado e o guard do app devolveria para esta tela a cada entrada: laço sem
   * saída e sem mensagem de erro.
   */
  const precisaCadastro = !onboardedAt;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (precisaCadastro && !name.trim()) {
      setError(t('setPassword.nameRequired', 'Informe seu nome.'));
      return;
    }
    if (password.length < 8) {
      setError(t('setPassword.tooShort', 'A senha precisa ter pelo menos 8 caracteres.'));
      return;
    }
    if (password !== confirm) {
      setError(t('setPassword.mismatch', 'As senhas não coincidem.'));
      return;
    }

    setSaving(true);

    // No convite, `onboarded_at` fecha o link; na recuperação só a senha muda.
    const payload = !precisaCadastro
      ? { password }
      : { password, data: { full_name: name.trim(), onboarded_at: new Date().toISOString() } };

    const { data, error: upErr } = await supabase.auth.updateUser(payload);

    if (upErr) {
      setSaving(false);
      const cru = (upErr.message || '').toLowerCase();
      // O Supabase responde em inglês e de um jeito que confunde justamente
      // quem acha que nunca definiu senha: na prática, esta senha JÁ é a da
      // conta — ou seja, o cadastro anterior deu certo e basta entrar.
      if (cru.includes('different from the old password')) {
        setError(t('setPassword.samePassword',
          'Esta já é a sua senha atual — seu cadastro foi concluído antes. Entre normalmente com ela, ou escolha uma senha diferente para trocá-la.'));
      } else if (cru.includes('weak') || cru.includes('easy to guess') || cru.includes('pwned')) {
        // Proteção contra senhas vazadas: o Supabase recusa senhas que já
        // apareceram em vazamentos conhecidos, e responde em inglês.
        setError(t('setPassword.weakPassword',
          'Esta senha aparece em vazamentos conhecidos e não pode ser usada. Escolha outra, de preferência sem palavras comuns.'));
      } else if (cru.includes('expired') || cru.includes('invalid') || cru.includes('token')) {
        setError(t('setPassword.linkExpired',
          'Este link expirou. Peça um novo convite ao administrador, ou use "Esqueci minha senha".'));
      } else {
        setError(upErr.message || t('setPassword.saveError', 'Não foi possível concluir o cadastro.'));
      }
      return;
    }

    // Fecha o cadastro: grava o nome escolhido e tira o vínculo de
    // "aguardando cadastro", para o administrador parar de ver esta pessoa
    // como convite em aberto.
    //
    // Vai por RPC, e não por UPDATE direto: neste ponto o token ainda é o do
    // convite e pode não ter o claim de organização, então o RLS recusaria a
    // escrita em `staff` — o nome sumia e o status ficava preso.
    if (precisaCadastro) {
      try {
        const uid = data?.user?.id;
        if (uid) {
          await supabase.rpc('complete_staff_signup', { p_user: uid, p_name: name.trim() });
        }
      } catch (_) { /* não impede a entrada */ }
    }

    setSaving(false);
    // Recarrega para o app nascer com a sessão e o perfil definitivos.
    window.location.href = '/';
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

        {status === 'used' && (
          <div className="sp-state">
            <h2 className="sp-title">{t('setPassword.usedTitle', 'Convite já utilizado')}</h2>
            <p className="sp-hint">
              {t('setPassword.usedHint', 'Este cadastro já foi concluído. Entre com seu e-mail e a senha que você definiu.')}
            </p>
            <Button type="button" className="login-btn" onClick={() => navigate('/login')}>
              {t('setPassword.goToLogin', 'Ir para o login')}
            </Button>
          </div>
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
            <h2 className="sp-title">
              {!precisaCadastro
                ? t('setPassword.recoveryTitle', 'Escolha uma nova senha')
                : t('setPassword.title', 'Bem-vindo! Complete seu cadastro')}
            </h2>
            <p className="sp-hint">
              {!precisaCadastro
                ? (email
                    ? t('setPassword.recoverySubtitleEmail', 'Definindo uma nova senha para {{email}}.', { email })
                    : t('setPassword.recoverySubtitle', 'Defina uma nova senha para sua conta.'))
                : (email
                    ? t('setPassword.subtitleEmail', 'Você está criando o acesso de {{email}}.', { email })
                    : t('setPassword.subtitle', 'Informe seu nome e escolha uma senha para acessar sua conta.'))}
            </p>

            <form onSubmit={handleSubmit} className="login-form">
              {error && <div className="error-message">{error}</div>}

              {precisaCadastro && (
                <div className="form-group">
                  <label htmlFor="sp-name">{t('setPassword.name', 'Seu nome')}</label>
                  <input
                    id="sp-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    autoComplete="name"
                    placeholder={t('setPassword.namePlaceholder', 'Nome completo')}
                  />
                </div>
              )}

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
                {saving
                  ? t('setPassword.saving', 'Salvando...')
                  : !precisaCadastro
                    ? t('setPassword.recoverySubmit', 'Salvar nova senha')
                    : t('setPassword.submit', 'Definir senha e entrar')}
              </Button>
            </form>
          </>
        )}
      </div>
    </div>
  );
};

export default SetPassword;
