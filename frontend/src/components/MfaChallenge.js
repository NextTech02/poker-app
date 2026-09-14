import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '../config/supabase';
import api from '../config/api';
import { useAuth } from '../contexts/AuthContext';
import './MfaChallenge.css';

/**
 * A segunda etapa do login.
 *
 * Aparece depois da senha, para quem ativou a verificação em duas etapas, e
 * ocupa a tela inteira: não há "pular". Quem contornasse esta tela encontraria
 * o banco recusando tudo (a política RESTRICTIVE exige `aal2`), o que pareceria
 * um sistema quebrado em vez de uma etapa que falta.
 *
 * O CAMINHO DE QUEM PERDEU O CELULAR é a parte que mais importa aqui. Sem ele a
 * pessoa fica trancada fora da própria conta olhando um campo que ela não tem
 * como preencher — e é sábado à noite, com a sala cheia. O código de
 * recuperação REMOVE o segundo fator e devolve a conta ao estado de senha; ele
 * não "entra" no lugar do aplicativo, porque só o `mfa.verify` do Supabase
 * promove a sessão.
 */
const MfaChallenge = ({ aoConfirmar }) => {
  const { t } = useTranslation();
  const { signOut } = useAuth();

  const [fator, setFator] = useState(null);
  const [codigo, setCodigo] = useState('');
  const [erro, setErro] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [modo, setModo] = useState('app');   // 'app' | 'recuperacao'
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const { data, error } = await supabase.auth.mfa.listFactors();
        if (error) throw error;
        setFator((data?.totp || [])[0] || null);
      } catch {
        setErro(t('mfa.errorLoadFactors', 'Não foi possível carregar seus métodos de verificação.'));
      } finally {
        setCarregando(false);
      }
    })();
  }, [t]);

  const confirmarPeloApp = useCallback(async (e) => {
    e.preventDefault();
    if (!fator || codigo.trim().length < 6) return;
    setErro('');
    setEnviando(true);
    try {
      const desafio = await supabase.auth.mfa.challenge({ factorId: fator.id });
      if (desafio.error) throw desafio.error;

      const conferido = await supabase.auth.mfa.verify({
        factorId: fator.id,
        challengeId: desafio.data.id,
        code: codigo.trim(),
      });
      if (conferido.error) throw conferido.error;

      // O `verify` já devolve uma sessão em aal2; o contexto acima relê o
      // nível e libera a tela.
      await aoConfirmar();
    } catch (err) {
      // A mensagem do Supabase vem em inglês e fala de "factor"/"challenge" —
      // vocabulário que não diz nada para quem opera o caixa.
      setErro(t('mfa.errorInvalidCode', 'Código inválido ou expirado. Confira o aplicativo e tente de novo.'));
      setCodigo('');
    } finally {
      setEnviando(false);
    }
  }, [fator, codigo, aoConfirmar, t]);

  const usarCodigoDeRecuperacao = useCallback(async (e) => {
    e.preventDefault();
    if (!codigo.trim()) return;
    setErro('');
    setEnviando(true);
    try {
      await api.post('/auth/mfa/recover', { code: codigo.trim() });
      // O fator saiu da conta: a sessão de senha que já está na mão passa a
      // bastar. `refreshSession` atualiza o token para o banco parar de exigir
      // o segundo fator na mesma hora.
      await supabase.auth.refreshSession();
      await aoConfirmar();
    } catch (err) {
      setErro(err.userMessage
        || t('mfa.errorInvalidRecovery', 'Código de recuperação inválido ou já utilizado.'));
      setCodigo('');
    } finally {
      setEnviando(false);
    }
  }, [codigo, aoConfirmar, t]);

  const trocarModo = () => {
    setModo(modo === 'app' ? 'recuperacao' : 'app');
    setCodigo('');
    setErro('');
  };

  return (
    <div className="mfa-gate">
      <div className="mfa-card">
        <h1>{t('mfa.challengeTitle', 'Verificação em duas etapas')}</h1>

        {carregando ? (
          <p className="mfa-hint">{t('common.loading', 'Carregando...')}</p>
        ) : (
          <>
            <p className="mfa-hint">
              {modo === 'app'
                ? t('mfa.challengeHint', 'Digite o código de 6 dígitos do seu aplicativo autenticador.')
                : t('mfa.recoveryHint', 'Digite um dos códigos de recuperação que você guardou. Ele vale uma vez só e vai DESLIGAR a verificação em duas etapas — você poderá cadastrar um aparelho novo em seguida.')}
            </p>

            <form onSubmit={modo === 'app' ? confirmarPeloApp : usarCodigoDeRecuperacao}>
              <label className="mfa-label" htmlFor="mfa-codigo">
                {modo === 'app'
                  ? t('mfa.codeLabel', 'Código do aplicativo')
                  : t('mfa.recoveryCodeLabel', 'Código de recuperação')}
              </label>
              <input
                id="mfa-codigo"
                className="mfa-input"
                value={codigo}
                onChange={(ev) => setCodigo(ev.target.value)}
                autoComplete="one-time-code"
                // `inputMode` e não `type="number"`: o código de recuperação tem
                // letras, e o teclado numérico do celular deixaria a pessoa sem
                // como digitá-lo.
                inputMode={modo === 'app' ? 'numeric' : 'text'}
                autoFocus
                disabled={enviando}
                placeholder={modo === 'app' ? '000000' : 'ABCDE-FGHIJ'}
              />

              {erro && <p className="mfa-erro" role="alert">{erro}</p>}

              <button type="submit" className="btn btn-primary mfa-submit"
                      disabled={enviando || !codigo.trim()}>
                {enviando
                  ? t('common.loading', 'Carregando...')
                  : t('mfa.confirm', 'Confirmar')}
              </button>
            </form>

            <div className="mfa-saidas">
              <button type="button" className="mfa-link" onClick={trocarModo}>
                {modo === 'app'
                  ? t('mfa.lostDevice', 'Perdi o celular')
                  : t('mfa.useApp', 'Usar o aplicativo autenticador')}
              </button>
              {/* Sair precisa existir: sem isto, quem não consegue passar fica
                  preso numa tela sem nenhuma saída. */}
              <button type="button" className="mfa-link" onClick={signOut}>
                {t('mfa.signOut', 'Sair')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default MfaChallenge;
