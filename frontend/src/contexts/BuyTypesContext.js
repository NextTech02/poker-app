import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '../config/supabase';
import { getAllByTable } from '../offline/db';

const BuyTypesContext = createContext({});

export const useBuyTypes = () => useContext(BuyTypesContext);

/** Últimos meios de entrada vistos neste TORNEIO, guardados na réplica offline. */
const lerDaReplica = async (tournamentId) => {
  try {
    const linhas = await getAllByTable('buy_types');
    return (linhas || []).filter((b) => b && b.tournament_id === tournamentId);
  } catch (e) {
    return [];
  }
};

// Os meios de entrada são do TORNEIO: uma lista, com nome, valor, rake e FICHAS
// próprios, que vale para todos os dias dele. Já foram da etapa (quando só
// diziam o rake) e do dia (quando um torneio de três dias repetia a mesma lista
// três vezes). Um flight mais caro é um meio a mais na lista, não uma lista à
// parte.
//
// O torneio não vem do StageContext porque não existe "torneio selecionado"
// global: ele é escolhido dentro do formulário de venda do Caixa. Quem sabe qual
// é avisa por `selectTournament`, no mesmo formato de `selectStage`.
export const BuyTypesProvider = ({ children }) => {
  const [tournamentId, setTournamentId] = useState(null);

  const [buyTypes, setBuyTypes] = useState([]);
  const [loading, setLoading] = useState(false);
  // DE ONDE veio a lista atual. Lista vazia não é uma informação só: pode ser
  // "o torneio não cadastrou nenhum meio de entrada" (o Caixa avisa e vende
  // pela categoria) ou "a consulta não voltou" (sem rede, sessão expirada,
  // RLS) — e nesse segundo caso travar a venda pararia o clube achando que
  // falta cadastro.
  //   'servidor' = veio do banco  |  'replica' = último visto, offline
  //   'erro'     = não deu para saber  |  null = sem torneio / ainda carregando
  const [origem, setOrigem] = useState(null);

  // Setter estável: o Caixa avisa o torneio escolhido a cada mudança do
  // formulário, e uma função recriada a cada render faria o efeito dele rodar
  // sem parar.
  const selectTournament = useCallback((id) => setTournamentId(id || null), []);

  const reload = useCallback(async () => {
    if (!tournamentId) {
      setBuyTypes([]);
      setOrigem(null);
      return;
    }
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('buy_types')
        .select('*')
        .eq('tournament_id', tournamentId)
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
      // virava "este torneio não tem meio de entrada cadastrado" na tela do Caixa.
      console.error(`[BuyTypes] falha ao carregar os meios de entrada do torneio ${tournamentId}; usando réplica local:`, e);
      const locais = await lerDaReplica(tournamentId);
      setBuyTypes(locais);
      setOrigem(locais.length ? 'replica' : 'erro');
    } finally {
      setLoading(false);
    }
  }, [tournamentId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const activeBuyTypes = useMemo(() => buyTypes.filter((b) => b.active), [buyTypes]);

  // Indice por id. A lista de vendas do Caixa resolve o tipo de CADA linha por
  // aqui: com `.find()` o custo do render era (linhas x tipos cadastrados).
  const porId = useMemo(() => new Map(buyTypes.map((b) => [b.id, b])), [buyTypes]);

  const byId = useCallback((id) => porId.get(id) || null, [porId]);

  // Só leitura, de propósito: quem GRAVA a lista é o backend
  // (PUT /tournaments/{id}/buy-types), que sabe não apagar um meio já vendido.
  const value = useMemo(
    () => ({
      tournamentId,
      selectTournament,
      buyTypes,
      activeBuyTypes,
      loading,
      origem,
      // Só com a lista confirmada pelo servidor dá para afirmar "este torneio
      // não tem nenhum meio de entrada cadastrado".
      tiposCarregados: origem === 'servidor',
      reload,
      byId,
    }),
    [tournamentId, selectTournament, buyTypes, activeBuyTypes, loading, origem, reload, byId],
  );

  return (
    <BuyTypesContext.Provider value={value}>
      {children}
    </BuyTypesContext.Provider>
  );
};
