import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '../config/supabase';

const PaymentMethodsContext = createContext({});

export const usePaymentMethods = () => useContext(PaymentMethodsContext);

// Gera um código estável a partir do rótulo (ex.: "Yape Perú" -> "yape-peru").
const slugify = (s) =>
  (s || '')
    .toString()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'metodo';

export const PaymentMethodsProvider = ({ children }) => {
  const [methods, setMethods] = useState([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const { data } = await supabase
        .from('payment_methods')
        .select('*')
        .order('sort_order', { ascending: true })
        .order('label', { ascending: true });
      setMethods(data || []);
    } catch (e) {
      /* não logado / offline — mantém o que tiver */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // Apenas os ativos vão para o dropdown do Caixa.
  // Memoizado: sem isso o array nasce com identidade nova a cada render e
  // qualquer `<select>` ou `useEffect` que dependa dele refaz trabalho a toa.
  const activeMethods = useMemo(() => methods.filter((m) => m.active), [methods]);

  // Indice por codigo. O Extrato chama `labelFor` uma vez por linha; com
  // `.find()` cada linha varria a lista inteira de meios de pagamento.
  const porCodigo = useMemo(() => new Map(methods.map((m) => [m.code, m])), [methods]);

  // Resolve código -> rótulo (usado no Extrato). Inclui inativos para não
  // "perder" o rótulo de transações antigas.
  const labelFor = useCallback(
    (code) => {
      if (!code) return null;
      const m = porCodigo.get(code);
      return m ? m.label : null;
    },
    [porCodigo]
  );

  const createMethod = useCallback(
    async (label) => {
      const name = (label || '').trim();
      if (!name) throw new Error('empty-label');
      const base = slugify(name);
      const existing = new Set(methods.map((m) => m.code));
      let code = base;
      let i = 2;
      while (existing.has(code)) code = `${base}-${i++}`;
      const maxOrder = methods.reduce((mx, m) => Math.max(mx, m.sort_order || 0), 0);
      const { error } = await supabase
        .from('payment_methods')
        .insert({ code, label: name, active: true, sort_order: maxOrder + 1 });
      if (error) throw error;
      await reload();
    },
    [methods, reload]
  );

  const updateMethod = useCallback(
    async (id, patch) => {
      const { error } = await supabase
        .from('payment_methods')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;
      await reload();
    },
    [reload]
  );

  const deleteMethod = useCallback(
    async (id) => {
      const { error } = await supabase.from('payment_methods').delete().eq('id', id);
      if (error) throw error;
      await reload();
    },
    [reload]
  );

  const value = useMemo(
    () => ({
      methods, activeMethods, loading, reload, labelFor,
      createMethod, updateMethod, deleteMethod,
    }),
    [methods, activeMethods, loading, reload, labelFor,
     createMethod, updateMethod, deleteMethod],
  );

  return (
    <PaymentMethodsContext.Provider value={value}>
      {children}
    </PaymentMethodsContext.Provider>
  );
};
