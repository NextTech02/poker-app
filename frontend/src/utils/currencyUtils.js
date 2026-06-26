/**
 * App-wide currency formatting. The selected currency is a GLOBAL setting
 * (stored in the DB table `app_settings`, mirrored to localStorage for instant,
 * synchronous formatting). Display-only: it changes the symbol + number format,
 * it does NOT convert amounts.
 */

export const CURRENCIES = {
  BRL: { code: 'BRL', symbol: 'R$', locale: 'pt-BR', name: 'Real (R$)' },
  USD: { code: 'USD', symbol: 'US$', locale: 'en-US', name: 'Dólar (US$)' },
  EUR: { code: 'EUR', symbol: '€', locale: 'pt-PT', name: 'Euro (€)' },
  ARS: { code: 'ARS', symbol: 'AR$', locale: 'es-AR', name: 'Peso Argentino (AR$)' },
  CLP: { code: 'CLP', symbol: 'CLP$', locale: 'es-CL', name: 'Peso Chileno (CLP$)' },
  COP: { code: 'COP', symbol: 'COP$', locale: 'es-CO', name: 'Peso Colombiano (COP$)' },
  PEN: { code: 'PEN', symbol: 'S/', locale: 'es-PE', name: 'Sol (S/)' },
  MXN: { code: 'MXN', symbol: 'MX$', locale: 'es-MX', name: 'Peso Mexicano (MX$)' },
  PYG: { code: 'PYG', symbol: '₲', locale: 'es-PY', name: 'Guarani (₲)' },
  UYU: { code: 'UYU', symbol: '$U', locale: 'es-UY', name: 'Peso Uruguaio ($U)' },
  GBP: { code: 'GBP', symbol: '£', locale: 'en-GB', name: 'Libra (£)' },
};

export const DEFAULT_CURRENCY = 'BRL';
const STORAGE_KEY = 'app_currency';

export const getStoredCurrency = () => {
  try {
    const c = localStorage.getItem(STORAGE_KEY);
    return c && CURRENCIES[c] ? c : DEFAULT_CURRENCY;
  } catch (e) {
    return DEFAULT_CURRENCY;
  }
};

export const setStoredCurrency = (code) => {
  try {
    if (CURRENCIES[code]) localStorage.setItem(STORAGE_KEY, code);
  } catch (e) {
    /* ignore */
  }
};

export const currencySymbol = (code) =>
  (CURRENCIES[code] || CURRENCIES[DEFAULT_CURRENCY]).symbol;

/**
 * Format a numeric value as "SYMBOL 1.234,56" using the given currency code
 * (or the stored global currency when omitted).
 */
export const formatCurrency = (value, code) => {
  const c =
    CURRENCIES[code] || CURRENCIES[getStoredCurrency()] || CURRENCIES[DEFAULT_CURRENCY];
  const num = parseFloat(value) || 0;
  return `${c.symbol} ${num.toLocaleString(c.locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};
