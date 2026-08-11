import React, { forwardRef, useImperativeHandle, useRef } from 'react';
import HCaptcha from '@hcaptcha/react-hcaptcha';

/**
 * Verificação anti-robô nas telas de autenticação.
 *
 * Modo INVISÍVEL de propósito: o caixa entra no sistema várias vezes por dia,
 * e obrigá-lo a clicar em "não sou um robô" a cada vez seria atrito puro. O
 * desafio só aparece quando o hCaptcha desconfia do acesso.
 *
 * A chave é pública (vai no pacote do navegador de qualquer jeito). Fica com
 * valor padrão embutido, e não só na variável de ambiente, por segurança
 * operacional: se o captcha for ligado no Supabase e o build tiver subido sem a
 * variável, NINGUÉM conseguiria entrar — inclusive para corrigir.
 */
export const CAPTCHA_SITE_KEY =
  process.env.REACT_APP_HCAPTCHA_SITE_KEY || '05a497ee-9f1a-417e-b66e-3d245aa4cb82';

/** `true` quando há chave configurada — as telas usam para decidir se validam. */
export const captchaAtivo = () => Boolean(CAPTCHA_SITE_KEY);

const Captcha = forwardRef((_props, ref) => {
  const widget = useRef(null);

  useImperativeHandle(ref, () => ({
    /**
     * Resolve o desafio e devolve o token de uso único.
     * Lança em caso de falha — quem chama decide a mensagem, em vez de mandar
     * a requisição sem token e receber um erro genérico do servidor.
     */
    async getToken() {
      if (!CAPTCHA_SITE_KEY || !widget.current) return undefined;
      // O token vale uma vez só: sem o reset, uma segunda tentativa de login
      // reenviaria o token já gasto e falharia sem motivo aparente.
      try { widget.current.resetCaptcha(); } catch (_) { /* ainda não montou */ }

      // Teto de tempo: sem ele, um desafio que não conclui (rede bloqueada,
      // serviço fora do ar, usuário que fecha a janelinha) deixa o botão preso
      // em "Entrando..." para sempre, sem nenhuma mensagem. Falhar com aviso é
      // melhor do que travar em silêncio.
      const LIMITE_MS = 90000;   // o desafio de imagens leva tempo; não apertar
      let expirou;
      const token = await Promise.race([
        widget.current.execute({ async: true }).then((r) => r?.response),
        new Promise((_r, rej) => {
          expirou = setTimeout(() => rej(new Error('CAPTCHA_TEMPO_ESGOTADO')), LIMITE_MS);
        }),
      ]).finally(() => clearTimeout(expirou));

      if (!token) throw new Error('CAPTCHA_SEM_TOKEN');
      return token;
    },
  }));

  if (!CAPTCHA_SITE_KEY) return null;

  return (
    <HCaptcha
      ref={widget}
      sitekey={CAPTCHA_SITE_KEY}
      size="invisible"
      // Segue o idioma da interface; sem isso o desafio sai sempre em inglês.
      languageOverride={(document.documentElement.lang || 'pt').slice(0, 2)}
    />
  );
});

Captcha.displayName = 'Captcha';

export default Captcha;
