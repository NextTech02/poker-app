import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../config/supabase';

/**
 * A sessão precisa passar pelo segundo fator agora?
 *
 * O Supabase responde isso com dois níveis:
 *
 *   atual  próximo   significado
 *   aal1   aal1      a pessoa não usa 2FA
 *   aal1   aal2      usa, e ainda NÃO confirmou nesta sessão   <- é o nosso caso
 *   aal2   aal2      já confirmou
 *   aal2   aal1      desligou o 2FA (token velho)
 *
 * `getAuthenticatorAssuranceLevel()` lê o PRÓPRIO token, sem ir à rede — custa
 * microssegundos, então dá para chamar em toda montagem de rota.
 *
 * ISTO É CONVENIÊNCIA, NÃO SEGURANÇA. Quem recusa de verdade é o banco: há uma
 * política RESTRICTIVE em todas as tabelas exigindo `aal2` de quem tem fator
 * verificado. Se alguém contornar esta tela, encontra telas vazias e escritas
 * recusadas — não dados. O papel daqui é dizer "falta confirmar o código" em
 * vez de deixar a pessoa diante de um sistema que parece quebrado.
 */
export function useMfaGate(user) {
  const [precisaConfirmar, setPrecisaConfirmar] = useState(false);
  const [verificando, setVerificando] = useState(true);

  const reavaliar = useCallback(async () => {
    if (!user) {
      setPrecisaConfirmar(false);
      setVerificando(false);
      return;
    }
    try {
      const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (error) throw error;
      setPrecisaConfirmar(
        data?.nextLevel === 'aal2' && data?.nextLevel !== data?.currentLevel,
      );
    } catch {
      // Versão do Supabase sem MFA, ou falha ao ler o token: NÃO trava a tela.
      // Errar para o lado de deixar entrar é seguro aqui justamente porque a
      // recusa de verdade está no banco — errar para o lado de travar
      // deixaria todo mundo fora por um problema de biblioteca.
      setPrecisaConfirmar(false);
    } finally {
      setVerificando(false);
    }
  }, [user]);

  useEffect(() => {
    setVerificando(true);
    reavaliar();
  }, [reavaliar]);

  return { precisaConfirmar, verificando, reavaliar };
}

export default useMfaGate;
