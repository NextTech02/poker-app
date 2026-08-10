import api from '../config/api';
import { supabase } from '../config/supabase';
import { clearCache } from './apiCache';

/**
 * Troca da organização ativa — ponto único usado pelo seletor do menu, pela
 * tela de seleção do login e pela inspeção do admin da plataforma.
 *
 * O isolamento (RLS) decide pelo CLAIM assinado, então avisar o backend não
 * basta: é preciso um TOKEN NOVO. O fluxo é gravar a escolha, pedir
 * `refreshSession()` (o Auth Hook roda de novo e emite o token com a
 * organização escolhida) e recarregar a aplicação.
 */

/** Organização do token atual (fonte da verdade do que o RLS enxerga agora). */
export function currentOrgId() {
  try {
    const token = localStorage.getItem('supabase_token');
    return JSON.parse(atob(token.split('.')[1])).organization_id || null;
  } catch (_) {
    return null;
  }
}

/** `true` quando o token carrega o claim de admin da plataforma. */
export function isPlatformAdminToken() {
  try {
    const token = localStorage.getItem('supabase_token');
    return JSON.parse(atob(token.split('.')[1])).platform_admin === true;
  } catch (_) {
    return false;
  }
}

/**
 * Entra numa organização e recarrega o app já escopado nela.
 *
 * @param {string} organizationId
 * @param {string} [redirectTo='/'] para onde ir depois da troca.
 */
export async function enterOrg(organizationId, redirectTo = '/') {
  await api.post('/organizations/switch', { organization_id: organizationId });

  const { error } = await supabase.auth.refreshSession();
  if (error) throw error;

  // A etapa selecionada pertence à organização ANTERIOR. Mantê-la faria as
  // telas pedirem uma etapa que o RLS da nova organização não devolve — a
  // operação abriria vazia sem explicação. O cache em memória tem o mesmo
  // problema: as chaves não são escopadas por organização.
  localStorage.removeItem('selected_stage');
  clearCache();

  // Recarga completa: zera todo o estado em memória da organização anterior.
  window.location.href = redirectTo;
}
