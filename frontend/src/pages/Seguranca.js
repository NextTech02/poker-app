import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import { SkeletonBlock } from '../components/SkeletonLoader';
import { useToast } from '../contexts/ToastContext';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { supabase } from '../config/supabase';
import api from '../config/api';
import './Seguranca.css';

/**
 * SEGURANÇA DA CONTA — ativar e desativar a verificação em duas etapas.
 *
 * É opcional: quem liga passa a ser obrigado a usar, quem não liga segue
 * entrando só com a senha. Essa escolha é do clube, e está registrada na
 * migração `database_migration_mfa_2fa.sql`.
 *
 * O SEGREDO NUNCA PASSA PELO NOSSO BACKEND: o `enroll` é uma chamada direta do
 * navegador ao Supabase, e o QR code vem de lá. Nosso servidor não tem por que
 * conhecer o segredo TOTP de ninguém.
 *
 * OS CÓDIGOS DE RECUPERAÇÃO aparecem UMA vez, aqui, e nunca mais: o banco
 * guarda só o hash. É por isso que a tela insiste tanto neles — quem fechar sem
 * anotar e perder o celular depois fica dependendo de suporte.
 */
const Seguranca = () => {
  const { t } = useTranslation();
  const { toast, confirm } = useToast();

  const [status, setStatus] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [ativando, setAtivando] = useState(null);   // {factorId, qr, secret}
  const [codigo, setCodigo] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [codigosNovos, setCodigosNovos] = useState(null);

  useEscapeKey(!!codigosNovos, () => setCodigosNovos(null));

  const carregar = useCallback(async () => {
    try {
      const res = await api.get('/auth/mfa/status');
      setStatus(res.data);
    } catch {
      setStatus({ enabled: false, factors: [], recovery_codes_remaining: 0 });
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => { carregar(); }, [carregar]);

  // ── Ativar ────────────────────────────────────────────────────────────
  const comecarAtivacao = async () => {
    setEnviando(true);
    try {
      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: `AceBlind ${new Date().toLocaleDateString()}`,
      });
      if (error) throw error;
      setAtivando({
        factorId: data.id,
        qr: data.totp.qr_code,
        secret: data.totp.secret,
      });
    } catch (err) {
      toast.error(t('security.errorStartEnroll', 'Não foi possível iniciar a ativação.'));
    } finally {
      setEnviando(false);
    }
  };

  const confirmarAtivacao = async (e) => {
    e.preventDefault();
    setEnviando(true);
    try {
      const desafio = await supabase.auth.mfa.challenge({ factorId: ativando.factorId });
      if (desafio.error) throw desafio.error;
      const ok = await supabase.auth.mfa.verify({
        factorId: ativando.factorId,
        challengeId: desafio.data.id,
        code: codigo.trim(),
      });
      if (ok.error) throw ok.error;

      // A sessão já está em aal2 — é o que o backend exige para gerar os
      // códigos. Gerar AGORA, e não depois, é o que garante que ninguém fica
      // com 2FA ligado e nenhuma forma de recuperar a conta.
      const res = await api.post('/auth/mfa/recovery-codes');
      setCodigosNovos(res.data.codes);

      setAtivando(null);
      setCodigo('');
      await carregar();
      toast.success(t('security.enabled', 'Verificação em duas etapas ativada'));
    } catch (err) {
      toast.error(err.userMessage
        || t('security.errorInvalidCode', 'Código inválido. Confira o aplicativo e tente de novo.'));
      setCodigo('');
    } finally {
      setEnviando(false);
    }
  };

  // ── Desativar ─────────────────────────────────────────────────────────
  const desativar = async (factorId) => {
    const certeza = await confirm(
      t('security.confirmDisable',
        'Desativar a verificação em duas etapas? Sua conta volta a ser protegida apenas pela senha.'),
      { title: t('security.disable', 'Desativar') },
    );
    if (!certeza) return;
    try {
      const { error } = await supabase.auth.mfa.unenroll({ factorId });
      if (error) throw error;
      await carregar();
      toast.success(t('security.disabled', 'Verificação em duas etapas desativada'));
    } catch {
      toast.error(t('security.errorDisable', 'Não foi possível desativar.'));
    }
  };

  const gerarNovosCodigos = async () => {
    try {
      const res = await api.post('/auth/mfa/recovery-codes');
      setCodigosNovos(res.data.codes);
      await carregar();
    } catch (err) {
      toast.error(err.userMessage
        || t('security.errorCodes', 'Não foi possível gerar novos códigos.'));
    }
  };

  const copiarCodigos = () => {
    navigator.clipboard?.writeText(codigosNovos.join('\n'))
      .then(() => toast.success(t('security.copied', 'Códigos copiados')))
      .catch(() => {});
  };

  const poucosCodigos = status && status.enabled && status.recovery_codes_remaining <= 2;

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div>
            <h1>{t('security.title', 'Segurança da conta')}</h1>
            <p className="subtitle">
              {t('security.subtitle',
                 'A verificação em duas etapas pede um código do seu celular além da senha.')}
            </p>
          </div>
        </div>

        {carregando ? (
          <SkeletonBlock height="10rem" />
        ) : (
          <section className="sec-card">
            <header className="sec-card-head">
              <h2>{t('security.twoFactor', 'Verificação em duas etapas')}</h2>
              <span className={`sec-badge ${status.enabled ? 'on' : 'off'}`}>
                {status.enabled
                  ? t('security.on', 'Ativa')
                  : t('security.off', 'Desativada')}
              </span>
            </header>

            {!status.enabled && !ativando && (
              <>
                <p className="sec-texto">
                  {t('security.offHint',
                     'Com ela ligada, alguém que descubra sua senha ainda não entra na sua conta sem o seu celular.')}
                </p>
                <button type="button" className="btn btn-primary"
                        onClick={comecarAtivacao} disabled={enviando}>
                  {t('security.enable', 'Ativar')}
                </button>
              </>
            )}

            {ativando && (
              <form onSubmit={confirmarAtivacao} className="sec-ativacao">
                <p className="sec-texto">
                  {t('security.scanHint',
                     'Leia o código com seu aplicativo autenticador (Google Authenticator, Authy, 1Password) e digite o número de 6 dígitos que ele mostrar.')}
                </p>
                {/* O QR vem do Supabase já como imagem. */}
                <img src={ativando.qr} alt={t('security.qrAlt', 'QR code para o aplicativo autenticador')}
                     className="sec-qr" />
                <details className="sec-manual">
                  <summary>{t('security.cantScan', 'Não consigo ler o código')}</summary>
                  {/* A chave escrita é a saída de quem usa gerenciador no
                      computador, sem câmera à mão. */}
                  <code className="sec-secret">{ativando.secret}</code>
                </details>

                <label className="sec-label" htmlFor="sec-codigo">
                  {t('security.codeLabel', 'Código do aplicativo')}
                </label>
                <input id="sec-codigo" className="sec-input" value={codigo}
                       onChange={(e) => setCodigo(e.target.value)}
                       inputMode="numeric" autoComplete="one-time-code"
                       placeholder="000000" disabled={enviando} />

                <div className="modal-actions">
                  <button type="button" className="btn btn-secondary"
                          onClick={() => { setAtivando(null); setCodigo(''); }}
                          disabled={enviando}>
                    {t('common.cancel', 'Cancelar')}
                  </button>
                  <button type="submit" className="btn btn-primary"
                          disabled={enviando || codigo.trim().length < 6}>
                    {t('security.confirmEnable', 'Confirmar e ativar')}
                  </button>
                </div>
              </form>
            )}

            {status.enabled && (
              <>
                <ul className="sec-fatores">
                  {status.factors.map((f) => (
                    <li key={f.id}>
                      <span>{f.friendly_name || t('security.device', 'Aparelho')}</span>
                      <button type="button" className="btn btn-danger btn-sm"
                              onClick={() => desativar(f.id)}>
                        {t('security.disable', 'Desativar')}
                      </button>
                    </li>
                  ))}
                </ul>

                <div className={`sec-recuperacao ${poucosCodigos ? 'alerta' : ''}`}>
                  <p className="sec-texto">
                    {t('security.codesRemaining',
                       '{{count}} códigos de recuperação restantes.',
                       { count: status.recovery_codes_remaining })}
                    {' '}
                    {poucosCodigos && t('security.codesLow',
                       'Gere uma lista nova enquanto ainda consegue entrar.')}
                  </p>
                  <button type="button" className="btn btn-secondary btn-sm"
                          onClick={gerarNovosCodigos}>
                    {t('security.newCodes', 'Gerar novos códigos')}
                  </button>
                </div>
              </>
            )}
          </section>
        )}

        {codigosNovos && (
          <div className="modal-overlay"
               onClick={(ev) => { if (ev.target === ev.currentTarget) setCodigosNovos(null); }}>
            <div className="modal" role="dialog" aria-modal="true">
              <h2>{t('security.yourCodes', 'Seus códigos de recuperação')}</h2>
              {/* O aviso é o ponto da tela, não decoração: depois que ela
                  fecha, estes códigos não existem em lugar nenhum. */}
              <p className="sec-aviso">
                {t('security.codesWarning',
                   'Anote estes códigos agora e guarde fora do celular. Eles não serão mostrados de novo, e cada um serve uma vez. Sem eles, perder o celular significa perder o acesso à conta.')}
              </p>
              <ul className="sec-lista-codigos">
                {codigosNovos.map((c) => <li key={c}><code>{c}</code></li>)}
              </ul>
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={copiarCodigos}>
                  {t('security.copy', 'Copiar')}
                </button>
                <button type="button" className="btn btn-primary"
                        onClick={() => setCodigosNovos(null)}>
                  {t('security.savedThem', 'Guardei os códigos')}
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default Seguranca;
