import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '../config/supabase';
import { useAuth } from './AuthContext';

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
  const { user, loading: carregandoSessao } = useAuth();
  const userId = user?.id;
  const [methods, setMethods] = useState([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('payment_methods')
        .select('*')
        .order('sort_order', { ascending: true })
        .order('label', { ascending: true });
      // O supabase-js NÃO lança: devolve `error` com `data` nulo, e lido como
      // resposta vazia isso apagava a lista por causa de uma falha passageira.
      if (error) throw error;
      setMethods(data || []);
    } catch (e) {
      /* offline ou falha passageira — mantém o que tiver */
    } finally {
      setLoading(false);
    }
  }, []);

  // Relê a cada entrada e saída. Este provider fica acima das rotas e o login só
  // troca de rota, sem recarregar a página: lido só ao montar, quem abriu o app
  // deslogado ficava com a lista vazia (o RLS não devolve nada), o Caixa só
  // oferecia dinheiro e cadastrar um método existente batia no código repetido.
  useEffect(() => {
    if (!carregandoSessao) reload();
  }, [carregandoSessao, userId, reload]);

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
      // 'split' é o código RESERVADO do pagamento dividido (o banco recusa):
      // um meio chamado "Split" vira 'split-2'.
      existing.add('split');
      let code = base;
      let i = 2;
      while (existing.has(code)) code = `${base}-${i++}`;
      const maxOrder = methods.reduce((mx, m) => Math.max(mx, m.sort_order || 0), 0);
      const { error } = await supabase
        .from('payment_methods')
        .insert({ code, label: name, active: true, sort_order: maxOrder + 1 });
      // Antes do `throw`: código repetido quer dizer que a lista da tela está
      // atrasada, e recarregar faz o método que já existe aparecer.
      await reload();
      if (error) throw error;
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
