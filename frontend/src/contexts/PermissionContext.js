import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useAuth } from './AuthContext';
import api from '../config/api';

// Piso de módulos. Toda organização que existia antes do módulo de cash fazia
// torneio, então é o único padrão que não muda o mundo de ninguém — e é o que
// impede a sidebar de ficar EM BRANCO quando esta chamada falha (o `catch`
// abaixo já trata o usuário como admin; com `modules: []` ele veria um menu
// vazio, que é indistinguível de um sistema quebrado).
const MODULOS_PADRAO = ['tournament'];

const PermissionContext = createContext({
  permissions: [],
  isAdmin: false,
  isPlatformAdmin: false,
  modules: MODULOS_PADRAO,
  loading: true,
  hasPermission: () => true,
});

export const usePermissions = () => useContext(PermissionContext);

export const PermissionProvider = ({ children }) => {
  const { user, loading: authLoading } = useAuth();
  const [permissions, setPermissions] = useState([]);
  const [isAdmin, setIsAdmin] = useState(true);
  // Platform admin (NextHub): quem enxerga o cadastro de organizações. Começa
  // false — o backend valida o mesmo claim, então esconder a tela é só UX.
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  const [groupName, setGroupName] = useState(null);
  // Nome do clube, para o cabeçalho do menu (backend antigo não manda: fica vazio).
  const [organizationName, setOrganizationName] = useState(null);
  // Módulos contratados pelo clube (tournament/cash). Entitlement comercial,
  // não permissão: decide QUAIS telas existem, não quem pode usá-las.
  const [modules, setModules] = useState(MODULOS_PADRAO);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // A sessão ainda está sendo restaurada (`getSession` no F5). Aqui `user` é
    // null por FALTA DE RESPOSTA, não por logout — e tratar os dois casos igual
    // faz este contexto anunciar "carregou" com um padrão fabricado.
    //
    // Quem pagou por isso foi o ModuleContext: ele confia neste `loading` para
    // saber quando a lista de módulos é real. Recebendo `['tournament']` como
    // se fosse definitivo, ele descartava o cash guardado pelo usuário e
    // gravava a troca — a escolha morria a cada F5.
    if (authLoading) {
      setLoading(true);
      return;
    }

    if (!user) {
      setPermissions([]);
      setIsAdmin(true);
      setIsPlatformAdmin(false);
      setModules(MODULOS_PADRAO);
      setLoading(false);
      return;
    }

    const loadPermissions = async (retryCount = 0) => {
      try {
        const res = await api.get('/staff/me/permissions', { _silentError: true });
        setPermissions(res.data.permissions || []);
        setIsAdmin(res.data.is_admin);
        setIsPlatformAdmin(res.data.is_platform_admin === true);
        setGroupName(res.data.group_name);
        setOrganizationName(res.data.organization_name || null);
        // Backend antigo (deploy não é atômico) não manda o campo: cair no
        // padrão mantém o app exatamente como era.
        setModules(res.data.modules?.length ? res.data.modules : MODULOS_PADRAO);
      } catch (err) {
        // Retry once after 3s on server errors (503, 500)
        const status = err?.response?.status;
        if (retryCount === 0 && (!status || status >= 500)) {
          setTimeout(() => loadPermissions(1), 3000);
          return; // Don't set loading=false yet, wait for retry
        }
        // If endpoint fails (e.g. table doesn't exist yet), treat as admin
        setPermissions([]);
        setIsAdmin(true);
        setModules(MODULOS_PADRAO);
      } finally {
        setLoading(false);
      }
    };

    loadPermissions();
  }, [user, authLoading]);

  // Set, e nao o array cru: `hasPermission` e chamado uma vez por item da
  // barra lateral, uma por aba e uma por botao protegido — dezenas de vezes por
  // render. Com `includes` isso era uma varredura linear sobre ~40 permissoes a
  // cada chamada; aqui e uma consulta de tabela hash.
  const conjunto = useMemo(() => new Set(permissions), [permissions]);

  const hasPermission = useCallback(
    (permission) => {
      if (isAdmin) return true;
      if (!permission) return true;
      return conjunto.has(permission);
    },
    [isAdmin, conjunto],
  );

  // O value era um objeto literal montado direto no JSX: identidade nova a cada
  // render, e com ela um re-render de TODA tela que le permissao.
  const value = useMemo(
    () => ({ permissions, isAdmin, isPlatformAdmin, modules, groupName, organizationName, loading, hasPermission }),
    [permissions, isAdmin, isPlatformAdmin, modules, groupName, organizationName, loading, hasPermission],
  );

  return (
    <PermissionContext.Provider value={value}>
      {children}
    </PermissionContext.Provider>
  );
};
