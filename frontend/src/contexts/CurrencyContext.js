import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import i18n from '../config/i18n';
import { supabase } from '../config/supabase';
import {
  CURRENCIES,
  getStoredCurrency,
  setStoredCurrency,
  formatCurrency as fmt,
} from '../utils/currencyUtils';
import {
  IDIOMAS_SUPORTADOS,
  aplicarIdiomaDaOrganizacao,
  marcarEscolhaDoUsuario,
} from '../utils/idiomaDoUsuario';

const CurrencyContext = createContext({});

export const useCurrency = () => useContext(CurrencyContext);

/**
 * Moeda e idioma do clube.
 *
 * Os dois moram na MESMA linha de `app_settings` (uma por organização), então
 * uma leitura serve para ambos — daí o idioma vir junto neste contexto em vez
 * de ganhar um provider próprio que faria um segundo round-trip.
 *
 * Sobre `.eq('id', 1)`, que estava aqui antes: `app_settings` deixou de ser uma
 * tabela de linha única quando o sistema virou multi-clube. Hoje cada
 * organização tem a sua linha, com id próprio (1, 20, 21, ...). Filtrar por
 * id = 1 lia a linha de UM clube específico — o primeiro — e para todos os
 * outros a consulta voltava vazia (o RLS esconde a linha alheia), caindo no
 * padrão do localStorage. Era por isso que os clubes colombianos, com COP
 * gravado no banco, continuavam exibindo R$: a preferência deles nunca era
 * lida. E o `update` com o mesmo filtro atingia zero linhas, sem erro nenhum,
 * então trocar a moeda na tela também não gravava.
 *
 * A correção é não filtrar: o RLS já entrega exatamente uma linha, a do clube
 * de quem está logado.
 */
// Uma leitura, os dois ajustes. O RLS já limita à linha do clube de quem está
// logado, então não há filtro: é justamente o filtro que estava errado antes.
const lerConfiguracoes = () =>
  supabase.from('app_settings').select('id, currency, language').limit(1).maybeSingle();

export const CurrencyProvider = ({ children }) => {
  // Start from the cached value (instant), then sync from the shared DB setting.
  const [currency, setCurrencyState] = useState(getStoredCurrency());
  const [language, setLanguageState] = useState(null);
  // Em ref, não em state: quem precisa do id são os gravadores, e mudá-lo não
  // muda nada na tela.
  const idDasConfiguracoes = useRef(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const { data } = await lerConfiguracoes();
        if (!active || !data) return;
        idDasConfiguracoes.current = data.id;
        if (data.currency && CURRENCIES[data.currency]) {
          setStoredCurrency(data.currency);
          setCurrencyState(data.currency);
        }
        if (IDIOMAS_SUPORTADOS.includes(data.language)) {
          setLanguageState(data.language);
          aplicarIdiomaDaOrganizacao(i18n, data.language);
        }
      } catch (e) {
        /* not logged in / offline — keep the localStorage default */
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  /**
   * O id da linha a gravar. Se a carga inicial não chegou (rede instável,
   * sessão que acabou de abrir), busca na hora — sem isto a troca de moeda
   * viraria um clique que não grava nada e não avisa.
   */
  const garantirId = useCallback(async () => {
    if (idDasConfiguracoes.current != null) return idDasConfiguracoes.current;
    const { data } = await lerConfiguracoes();
    idDasConfiguracoes.current = data?.id ?? null;
    return idDasConfiguracoes.current;
  }, []);

  const setCurrency = useCallback(async (code) => {
    if (!CURRENCIES[code]) return;
    setStoredCurrency(code); // keep the synchronous util in sync immediately
    setCurrencyState(code); // re-render all consumers
    try {
      const id = await garantirId();
      if (id == null) return;
      await supabase
        .from('app_settings')
        .update({ currency: code, updated_at: new Date().toISOString() })
        .eq('id', id);
    } catch (e) {
      /* localStorage already updated; DB write best-effort */
    }
  }, [garantirId]);

  /**
   * Troca o idioma do clube — o padrão de quem nunca escolheu o seu.
   *
   * Vale também para quem fez a troca, mesmo que essa pessoa já tenha uma
   * preferência própria: ela acabou de pedir este idioma, na tela, de propósito.
   * Sem isso o admin trocaria o idioma e não veria nada mudar. Os DEMAIS
   * operadores que já clicaram numa bandeira continuam com a deles — o padrão do
   * clube não desfaz preferência pessoal alheia.
   */
  const setLanguage = useCallback(async (code) => {
    if (!IDIOMAS_SUPORTADOS.includes(code)) return;
    setLanguageState(code);
    marcarEscolhaDoUsuario(code);
    i18n.changeLanguage(code);
    try {
      const id = await garantirId();
      if (id == null) return;
      await supabase
        .from('app_settings')
        .update({ language: code, updated_at: new Date().toISOString() })
        .eq('id', id);
    } catch (e) {
      /* a tela já mudou; a gravação é best-effort, como a da moeda */
    }
  }, [garantirId]);

  // Presa à moeda atual (para os consumidores re-renderizarem na troca) e
  // memoizada: várias telas a listam em dependências de useEffect, e uma
  // identidade nova a cada render viraria laço infinito.
  const formatCurrency = useCallback((value) => fmt(value, currency), [currency]);

  return (
    <CurrencyContext.Provider
      value={{
        currency,
        setCurrency,
        formatCurrency,
        currencies: CURRENCIES,
        language,
        setLanguage,
      }}
    >
      {children}
    </CurrencyContext.Provider>
  );
};
