import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { usePermissions } from './PermissionContext';
import { clearCache } from '../utils/apiCache';

/**
 * Módulo ativo: torneio ou cash game.
 *
 * O clube contrata um, o outro ou os dois. O módulo NÃO é permissão nem
 * isolamento de dados (isso continua sendo organization_id + RLS) — ele decide
 * qual menu a sidebar monta e quais rotas existem.
 *
 * POR QUE TROCAR DE MÓDULO É BARATO (e trocar de organização não é):
 * o `OrgSwitcher` precisa de `refreshSession()` + reload porque o RLS lê a
 * organização de um CLAIM ASSINADO — enquanto o token velho estiver na mão, o
 * banco continua devolvendo os dados do clube anterior. Módulo não é claim: o
 * servidor decide pela organização, não pelo que a tela escolheu. Então aqui
 * basta trocar o estado, limpar o cache e navegar.
 *
 * O `clearCache()` existe pelo mesmo motivo do StageContext: as respostas em
 * cache são de outro contexto e não podem vazar para a tela seguinte.
 */
const ModuleContext = createContext({});

export const MODULO_TORNEIO = 'tournament';
export const MODULO_CASH = 'cash';

const ARMAZENAMENTO = 'selected_module';

/** Onde cada módulo começa. Usado na troca e pelo guard de rota.
 *
 * O torneio aponta para `/home`, não para `/`. A raiz virou NEUTRA: ela
 * redireciona para a casa do módulo aberto, e apontá-la de volta para si mesma
 * seria um laço. `/home` sempre foi o Dashboard de torneio — é o item "Início"
 * do menu — então isto não inventa tela nenhuma, só deixa de usar a raiz como
 * apelido dele. */
export const HOME_DO_MODULO = {
  [MODULO_TORNEIO]: '/home',
  [MODULO_CASH]: '/cash',
};

export const useModule = () => useContext(ModuleContext);

export const ModuleProvider = ({ children }) => {
  const { modules, loading: permsLoading } = usePermissions();
  const [stored, setStored] = useState(() => {
    try {
      return localStorage.getItem(ARMAZENAMENTO);
    } catch {
      // Navegador com storage bloqueado: o app segue, só não lembra a escolha.
      return null;
    }
  });

  const disponiveis = useMemo(
    () => (modules?.length ? modules : [MODULO_TORNEIO]),
    [modules],
  );

  // O módulo guardado só vale enquanto o clube ainda o tem. Se o cash foi
  // desligado (ou o funcionário mudou de clube), a escolha antiga apontaria
  // para telas que o backend recusa — cair no primeiro disponível é o que
  // mantém a sessão utilizável sem exigir logout.
  const module = disponiveis.includes(stored) ? stored : disponiveis[0];

  // NÃO existe efeito que grave `module` de volta no localStorage, e isso é
  // deliberado: só uma ESCOLHA EXPLÍCITA (`selectModule`) grava.
  //
  // Havia um, que normalizava o armazenamento quando o módulo guardado não
  // estava mais disponível. O problema é que "não disponível" também acontece
  // por um instante enquanto a lista real não chegou — e naquele instante ele
  // apagava a escolha do usuário de forma permanente. Um valor derivado
  // sobrescrevendo um valor escolhido é sempre uma troca ruim: o derivado se
  // recalcula, o escolhido não volta.
  //
  // Deixar `stored` desatualizado não custa nada: `module` já resolve para o
  // primeiro disponível a cada render. Se o clube recontratar o cash, o
  // usuário volta para onde estava, em vez de ter de escolher de novo.

  const selectModule = useCallback((proximo) => {
    if (!disponiveis.includes(proximo) || proximo === module) return;
    clearCache();
    setStored(proximo);
    try {
      localStorage.setItem(ARMAZENAMENTO, proximo);
    } catch {
      /* storage bloqueado */
    }
  }, [disponiveis, module]);

  // O modulo decide QUAL barra lateral existe: este value e lido no topo da
  // arvore, entao recria-lo a cada render custava o app inteiro.
  const value = useMemo(
    () => ({
      module,
      modules: disponiveis,
      // Só faz sentido oferecer a troca (e a tela de escolha) para quem tem mais
      // de um. Com um módulo só, o clube nunca vê que isso existe.
      hasMultipleModules: disponiveis.length > 1,
      hasModule: (nome) => disponiveis.includes(nome),
      homePath: HOME_DO_MODULO[module] || '/',
      selectModule,
      loading: permsLoading,
    }),
    [module, disponiveis, selectModule, permsLoading],
  );

  return <ModuleContext.Provider value={value}>{children}</ModuleContext.Provider>;
};
