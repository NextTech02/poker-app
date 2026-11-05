import i18n from 'i18next';

/**
 * Transforma o `detail` de uma recusa da API em frase para a tela (ou null).
 *
 * O backend manda três formatos, e só o primeiro pode ir direto para o JSX:
 *   - texto;
 *   - LISTA de objetos: erro de validação (422) do FastAPI,
 *     `{type, loc, msg, input, ctx}`;
 *   - objeto com CÓDIGO: `{code, message, ...extras}` (backend/app/utils/erros.py).
 * Renderizar os dois últimos quebra a tela com "Objects are not valid as a
 * React child". Quem usa: o interceptor de config/api.js (o `userMessage` de
 * todo erro) e o toast, que é a última linha de defesa.
 */
export const textoDoDetalhe = (d) => {
  if (typeof d === 'string') return d;
  if (Array.isArray(d)) {
    // Validação: a frase indica o campo, senão o operador não descobre qual
    // está errado.
    return d
      .map((item) => {
        if (typeof item === 'string') return item;
        const field = Array.isArray(item?.loc)
          ? item.loc.filter((p) => p !== 'body').join('.')
          : null;
        const text = item?.msg || '';
        return field ? `${field}: ${text}` : text;
      })
      .filter(Boolean)
      .join(' · ');
  }
  if (d && typeof d === 'object') {
    /* Recusa com CÓDIGO. O servidor manda `{code, message, ...extras}`
       justamente para NÃO decidir o idioma: o sistema atende clubes no Brasil,
       no Peru e na Colômbia, e uma frase pronta em português chegaria assim
       para todos eles.

       A chave é `errors.<code>` e o padrão inline é a própria `message` do
       servidor — então um código que a tela ainda não conhece aparece em
       português, em vez de virar "erro desconhecido". Os extras entram como
       variáveis da frase ({{name}}, {{nivel}}). */
    if (d.code) return i18n.t(`errors.${d.code}`, d.message, d);
    return d.msg || d.message || null;
  }
  return null;
};
