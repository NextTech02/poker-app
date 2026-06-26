import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { supabase } from '../config/supabase';
import {
  CURRENCIES,
  getStoredCurrency,
  setStoredCurrency,
  formatCurrency as fmt,
} from '../utils/currencyUtils';

const CurrencyContext = createContext({});

export const useCurrency = () => useContext(CurrencyContext);

export const CurrencyProvider = ({ children }) => {
  // Start from the cached value (instant), then sync from the shared DB setting.
  const [currency, setCurrencyState] = useState(getStoredCurrency());

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const { data } = await supabase
          .from('app_settings')
          .select('currency')
          .eq('id', 1)
          .single();
        if (active && data?.currency && CURRENCIES[data.currency]) {
          setStoredCurrency(data.currency);
          setCurrencyState(data.currency);
        }
      } catch (e) {
        /* not logged in / offline — keep the localStorage default */
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const setCurrency = useCallback(async (code) => {
    if (!CURRENCIES[code]) return;
    setStoredCurrency(code); // keep the synchronous util in sync immediately
    setCurrencyState(code); // re-render all consumers
    try {
      await supabase
        .from('app_settings')
        .update({ currency: code, updated_at: new Date().toISOString() })
        .eq('id', 1);
    } catch (e) {
      /* localStorage already updated; DB write best-effort */
    }
  }, []);

  // Bound to the current currency so components using it re-render on change.
  const formatCurrency = useCallback((value) => fmt(value, currency), [currency]);

  return (
    <CurrencyContext.Provider
      value={{ currency, setCurrency, formatCurrency, currencies: CURRENCIES }}
    >
      {children}
    </CurrencyContext.Provider>
  );
};
