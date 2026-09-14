import { useCallback, useEffect, useRef, useState } from 'react';
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
  // Só a PRIMEIRA verificação segura a tela.
  //
  // O `verificando` faz o PrivateRoute mostrar "Carregando" — e mostrar isso é
  // DESMONTAR a página que estava aberta. Na primeira vez é o certo: não dá
  // para pintar a tela antes de saber se falta o segundo fator. Nas seguintes
  // seria destrutivo, porque elas acontecem quando o token é renovado (ao
  // voltar para a aba, por exemplo) e apagariam o formulário que a pessoa
  // estava preenchendo.
  const jaVerificou = useRef(false);

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
    if (!jaVerificou.current) setVerificando(true);
    reavaliar().finally(() => { jaVerificou.current = true; });
  }, [reavaliar]);

  return { precisaConfirmar, verificando, reavaliar };
}

export default useMfaGate;
