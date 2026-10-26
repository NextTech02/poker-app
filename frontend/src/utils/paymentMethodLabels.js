// Os métodos de pagamento "embutidos" (universais) têm rótulo via i18n, então
// traduzem junto com o idioma do app. Métodos personalizados criados pelo
// cliente (ex.: Yape, Nequi) usam o rótulo salvo no banco como está.
export const BUILTIN_PAYMENT_CODES = {
  cash: 'financial.paymentCash',
  pix: 'financial.paymentPix',
  card: 'financial.paymentCard',
  transfer: 'financial.paymentTransfer',
};

export const isBuiltinMethod = (code) =>
  Object.prototype.hasOwnProperty.call(BUILTIN_PAYMENT_CODES, code);

// Rótulo de um método (objeto {code,label}) — i18n para embutidos, label para o resto.
export const methodLabel = (t, method) => {
  if (!method) return '--';
  if (BUILTIN_PAYMENT_CODES[method.code]) return t(BUILTIN_PAYMENT_CODES[method.code]);
  // Código reservado do pagamento dividido: não é um meio cadastrado, é a
  // venda paga em mais de um (as partes ficam na própria venda).
  if (method.code === 'split') return t('financial.paymentSplit', 'Dividido');
  return method.label || method.code || '--';
};
