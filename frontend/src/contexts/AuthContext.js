import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { supabase } from '../config/supabase';
import { clearCache } from '../utils/apiCache';
import { isOnline } from '../offline/connectivity';

const AuthContext = createContext({});

export const useAuth = () => useContext(AuthContext);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Check active session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      if (session?.access_token) {
        localStorage.setItem('supabase_token', session.access_token);
      }
      setLoading(false);
    });

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.access_token) {
        // MESMA PESSOA => MESMO OBJETO.
        //
        // O token é renovado sozinho o tempo todo — ao voltar para a aba, a
        // cada hora, depois de suspender o aparelho. Cada renovação traz um
        // objeto `user` novo, e trocar a identidade por um objeto diferente
        // com o mesmo conteúdo fazia todo efeito que depende de `user` rodar
        // de novo, em cascata, até desmontar a página aberta e apagar o
        // formulário que estava sendo preenchido.
        //
        // `updated_at` entra na comparação junto com o id: metadados mudam de
        // verdade (é assim que `onboarded_at` aparece depois que o convidado
        // define a senha), e comparar só o id faria essa mudança passar batida.
        setUser((anterior) => {
          const novo = session.user ?? null;
          if (anterior && novo
              && anterior.id === novo.id
              && anterior.updated_at === novo.updated_at) {
            return anterior;
          }
          return novo;
        });
        localStorage.setItem('supabase_token', session.access_token);
      } else if (isOnline()) {
        // Sessão nula ESTANDO ONLINE = logout real → limpa.
        setUser(null);
        localStorage.removeItem('supabase_token');
      }
      // Sessão nula OFFLINE = falha transitória de refresh (sem rede). NÃO desloga:
      // mantém user/token para o operador continuar offline e sincronizar depois.
      // O logout explícito (signOut) remove o token diretamente, então funciona.
    });

    return () => subscription.unsubscribe();
  }, []);

  const signIn = useCallback(async (email, password, captchaToken) => {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
      // Só vai quando a tela resolveu o desafio. Se o captcha estiver
      // desligado no Supabase, o campo é ignorado — então enviar não atrapalha.
      ...(captchaToken ? { options: { captchaToken } } : {}),
    });
    return { data, error };
  }, []);

  const signUp = useCallback(async (email, password) => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
    });
    return { data, error };
  }, []);

  const signOut = useCallback(async () => {
    const { error } = await supabase.auth.signOut();
    localStorage.removeItem('supabase_token');
    clearCache(); // B3: limpa cache ao sair
    return { error };
  }, []);

  // As tres funcoes sao estaveis (useCallback sem dependencias), entao na
  // pratica o value so muda quando `user` ou `loading` mudam — que e
  // exatamente quando um consumidor precisa mesmo re-renderizar.
  const value = useMemo(
    () => ({ user, signIn, signUp, signOut, loading }),
    [user, loading, signIn, signUp, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
