/**
 * Tamanho de fonte da transmissão ajustado NA PRÓPRIA TV.
 *
 * O telão tem botões +/− no canto. Quem clica pode estar logado (o operador,
 * no próprio notebook) ou não (a TV do salão, aberta pelo código em /tv).
 * Logado, o valor vai para o servidor como `broadcast_font_size` do dia e o
 * slider das Configurações passa a refletir. Sem login, não há como gravar
 * no servidor — então o valor fica aqui, só neste aparelho, por dia. É até
 * desejável: cada TV tem seu tamanho e sua distância do público.
 *
 * Modo anônimo / storage bloqueado não pode derrubar o telão: tudo em
 * try/catch, e sem storage o ajuste vale só até recarregar.
 */

const PREFIXO = 'aceblind:broadcastFontSize:';

export const FONTE_MIN = 50;
export const FONTE_MAX = 200;
export const FONTE_PASSO = 10;

const chave = (id) => `${PREFIXO}${id}`;

const ehValida = (n) => Number.isInteger(n) && n >= FONTE_MIN && n <= FONTE_MAX;

/** O valor guardado neste aparelho para este dia/torneio, ou null. */
export const lerFonteLocal = (id) => {
  if (!id) return null;
  try {
    const salvo = parseInt(window.localStorage.getItem(chave(id)), 10);
    return ehValida(salvo) ? salvo : null;
  } catch (e) {
    return null;
  }
};

export const gravarFonteLocal = (id, valor) => {
  if (!id || !ehValida(valor)) return;
  try {
    window.localStorage.setItem(chave(id), String(valor));
  } catch (e) {
    /* sem storage o ajuste vale só nesta sessão — melhor que quebrar */
  }
};

export const limparFonteLocal = (id) => {
  if (!id) return;
  try {
    window.localStorage.removeItem(chave(id));
  } catch (e) {
    /* idem */
  }
};

/** Soma `delta` ao tamanho atual, respeitando passo e limites. */
export const proximaFonte = (atual, delta) => {
  const base = Math.round((Number(atual) || 100) / FONTE_PASSO) * FONTE_PASSO;
  return Math.min(FONTE_MAX, Math.max(FONTE_MIN, base + delta));
};
