import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '../config/supabase';
import { getAllByTable } from '../offline/db';

const BuyTypesContext = createContext({});

export const useBuyTypes = () => useContext(BuyTypesContext);

/** Últimos meios de entrada vistos neste DIA, guardados na réplica offline. */
const lerDaReplica = async (dayId) => {
  try {
    const linhas = await getAllByTable('buy_types');
    return (linhas || []).filter((b) => b && b.tournament_day_id === dayId);
  } catch (e) {
    return [];
  }
};

// Os meios de entrada são por DIA do torneio: cada dia configura os seus, com
// nome, valor, rake e FICHAS próprios. Antes eram por etapa e só diziam o rake
// — e por isso "rebuy duplo" precisava ser rebuy × 2, o que nunca foi verdade:
// ele tem valor e fichas próprios.
//
// O dia não vem do StageContext porque não existe "dia selecionado" global: o
// dia é escolhido dentro do formulário de venda do Caixa. Quem sabe qual é
// avisa por `selectDay`, no mesmo formato de `selectStage` do StageContext.
export const BuyTypesProvider = ({ children }) => {
  const [dayId, setDayId] = useState(null);

  const [buyTypes, setBuyTypes] = useState([]);
  const [loading, setLoading] = useState(false);
  // DE ONDE veio a lista atual. Lista vazia não é uma informação só: pode ser
  // "o dia não cadastrou nenhum meio de entrada" (o Caixa avisa e vende pela
  // categoria) ou "a consulta não voltou" (sem rede, sessão expirada, RLS) — e
  // nesse segundo caso travar a venda pararia o clube achando que falta cadastro.
  //   'servidor' = veio do banco  |  'replica' = último visto, offline
  //   'erro'     = não deu para saber  |  null = sem dia / ainda carregando
  const [origem, setOrigem] = useState(null);

  // Setter estável: o Caixa avisa o dia escolhido a cada mudança do formulário,
  // e uma função recriada a cada render faria o efeito dele rodar sem parar.
  const selectDay = useCallback((id) => setDayId(id || null), []);

  const reload = useCallback(async () => {
    if (!dayId) {
      setBuyTypes([]);
      setOrigem(null);
      return;
    }
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('buy_types')
        .select('*')
        .eq('tournament_day_id', dayId)
        .order('category', { ascending: true })
        .order('sort_order', { ascending: true })
        .order('name', { ascending: true });
      // O supabase-js NÃO lança em erro de RLS/sessão: devolve `error` com
      // `data` nulo. Sem esta linha, uma sessão expirada virava "nenhum meio de
      // entrada cadastrado" em silêncio.
      if (error) throw error;
      setBuyTypes(data || []);
      setOrigem('servidor');
    } catch (e) {
      // Sem rede a consulta falha — justamente o cenário em que o modo offline
      // do Caixa precisa continuar vendendo. A réplica local tem os tipos
      // gravados enquanto havia conexão.
      // O erro precisa aparecer no console: engolido, uma falha de rede/sessão
      // virava "este dia não tem meio de entrada cadastrado" na tela do Caixa.
      console.error(`[BuyTypes] falha ao carregar os meios de entrada do dia ${dayId}; usando réplica local:`, e);
      const locais = await lerDaReplica(dayId);
      setBuyTypes(locais);
      setOrigem(locais.length ? 'replica' : 'erro');
    } finally {
      setLoading(false);
    }
  }, [dayId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const activeBuyTypes = useMemo(() => buyTypes.filter((b) => b.active), [buyTypes]);

  // Indice por id. A lista de vendas do Caixa resolve o tipo de CADA linha por
  // aqui: com `.find()` o custo do render era (linhas x tipos cadastrados).
  const porId = useMemo(() => new Map(buyTypes.map((b) => [b.id, b])), [buyTypes]);

  const byId = useCallback((id) => porId.get(id) || null, [porId]);

  const createBuyType = useCallback(
    async ({ name, category, amount, rake_percentage, chips }) => {
      if (!dayId) throw new Error('no-day');
      const maxOrder = buyTypes.reduce((mx, b) => Math.max(mx, b.sort_order || 0), 0);
      // Valor, rake e fichas ficam NO meio de entrada: é o que permite um
      // "rebuy duplo" existir como coisa própria, e não como rebuy vezes dois.
      const { error } = await supabase.from('buy_types').insert({
        tournament_day_id: dayId,
        name: (name || '').trim(),
        category,
        amount: Number(amount) || 0,
        rake_percentage: Number(rake_percentage) || 0,
        chips: Number(chips) || 0,
        active: true,
        sort_order: maxOrder + 1,
      });
      if (error) throw error;
      await reload();
    },
    [dayId, buyTypes, reload]
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

  const value = useMemo(
    () => ({
      dayId,
      selectDay,
      buyTypes,
      activeBuyTypes,
      loading,
      origem,
        // Só com a lista confirmada pelo servidor dá para afirmar "este dia
        // não tem nenhum meio de entrada cadastrado".
      tiposCarregados: origem === 'servidor',
      reload,
      byId,
      createBuyType,
      updateBuyType,
      deleteBuyType,
    }),
    [dayId, selectDay, buyTypes, activeBuyTypes, loading, origem, reload, byId,
     createBuyType, updateBuyType, deleteBuyType],
  );

  return (
    <BuyTypesContext.Provider value={value}>
      {children}
    </BuyTypesContext.Provider>
  );
};
