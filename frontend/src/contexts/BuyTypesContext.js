import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { supabase } from '../config/supabase';
import { useStage } from './StageContext';

const BuyTypesContext = createContext({});

export const useBuyTypes = () => useContext(BuyTypesContext);

// Tipos de buy são por ETAPA: a lista acompanha a etapa selecionada.
export const BuyTypesProvider = ({ children }) => {
  const { selectedStage } = useStage();
  const stageId = selectedStage?.id || null;

  const [buyTypes, setBuyTypes] = useState([]);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!stageId) {
      setBuyTypes([]);
      return;
    }
    setLoading(true);
    try {
      const { data } = await supabase
        .from('buy_types')
        .select('*')
        .eq('stage_id', stageId)
        .order('category', { ascending: true })
        .order('sort_order', { ascending: true })
        .order('name', { ascending: true });
      setBuyTypes(data || []);
    } catch (e) {
      /* não logado / offline */
    } finally {
      setLoading(false);
    }
  }, [stageId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const activeBuyTypes = buyTypes.filter((b) => b.active);

  const byId = useCallback((id) => buyTypes.find((b) => b.id === id) || null, [buyTypes]);

  const createBuyType = useCallback(
    async ({ name, category, rake_percentage }) => {
      if (!stageId) throw new Error('no-stage');
      const maxOrder = buyTypes.reduce((mx, b) => Math.max(mx, b.sort_order || 0), 0);
      // amount fica 0: o valor da entrada vem da configuração do torneio (dia),
      // não do tipo de buy. O tipo define só nome/categoria/rake.
      const { error } = await supabase.from('buy_types').insert({
        stage_id: stageId,
        name: (name || '').trim(),
        category,
        amount: 0,
        rake_percentage: Number(rake_percentage) || 0,
        active: true,
        sort_order: maxOrder + 1,
      });
      if (error) throw error;
      await reload();
    },
    [stageId, buyTypes, reload]
  );

  const updateBuyType = useCallback(
    async (id, patch) => {
      const { error } = await supabase
        .from('buy_types')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;
      await reload();
    },
    [reload]
  );

  const deleteBuyType = useCallback(
    async (id) => {
      const { error } = await supabase.from('buy_types').delete().eq('id', id);
      if (error) throw error;
      await reload();
    },
    [reload]
  );

  return (
    <BuyTypesContext.Provider
      value={{
        stageId,
        buyTypes,
        activeBuyTypes,
        loading,
        reload,
        byId,
        createBuyType,
        updateBuyType,
        deleteBuyType,
      }}
    >
      {children}
    </BuyTypesContext.Provider>
  );
};
