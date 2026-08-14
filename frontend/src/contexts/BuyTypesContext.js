import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { supabase } from '../config/supabase';
import { getAllByTable } from '../offline/db';
import { useStage } from './StageContext';

const BuyTypesContext = createContext({});

export const useBuyTypes = () => useContext(BuyTypesContext);

/** Últimos tipos vistos desta etapa, guardados na réplica offline. */
const lerDaReplica = async (stageId) => {
  try {
    const linhas = await getAllByTable('buy_types');
    return (linhas || []).filter((b) => b && b.stage_id === stageId);
  } catch (e) {
    return [];
  }
};

// Tipos de buy são por ETAPA: a lista acompanha a etapa selecionada.
export const BuyTypesProvider = ({ children }) => {
  const { selectedStage } = useStage();
  const stageId = selectedStage?.id || null;

  const [buyTypes, setBuyTypes] = useState([]);
  const [loading, setLoading] = useState(false);
  // DE ONDE veio a lista atual. Lista vazia não é uma informação só: pode ser
  // "a etapa não cadastrou nenhum tipo" (o Caixa avisa e vende pela categoria)
  // ou "a consulta não voltou" (sem rede, sessão expirada, RLS) — e nesse
  // segundo caso travar a venda pararia o clube achando que falta cadastro.
  //   'servidor' = veio do banco  |  'replica' = último visto, offline
  //   'erro'     = não deu para saber  |  null = sem etapa / ainda carregando
  const [origem, setOrigem] = useState(null);

  const reload = useCallback(async () => {
    if (!stageId) {
      setBuyTypes([]);
      setOrigem(null);
      return;
    }
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('buy_types')
        .select('*')
        .eq('stage_id', stageId)
        .order('category', { ascending: true })
        .order('sort_order', { ascending: true })
        .order('name', { ascending: true });
      // O supabase-js NÃO lança em erro de RLS/sessão: devolve `error` com
      // `data` nulo. Sem esta linha, uma sessão expirada virava "nenhum tipo
      // cadastrado" em silêncio.
      if (error) throw error;
      setBuyTypes(data || []);
      setOrigem('servidor');
    } catch (e) {
      // Sem rede a consulta falha — justamente o cenário em que o modo offline
      // do Caixa precisa continuar vendendo. A réplica local tem os tipos
      // gravados enquanto havia conexão.
      // O erro precisa aparecer no console: engolido, uma falha de rede/sessão
      // virava "esta etapa não tem tipo de buy cadastrado" na tela do Caixa.
      console.error(`[BuyTypes] falha ao carregar tipos de buy da etapa ${stageId}; usando réplica local:`, e);
      const locais = await lerDaReplica(stageId);
      setBuyTypes(locais);
      setOrigem(locais.length ? 'replica' : 'erro');
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
        origem,
        // Só com a lista confirmada pelo servidor dá para afirmar "esta etapa
        // não tem nenhum tipo cadastrado".
        tiposCarregados: origem === 'servidor',
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
