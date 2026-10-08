/**
 * Claims do token de sessão guardado em localStorage (`supabase_token`).
 *
 * O Storage isola os clubes pelo CAMINHO do arquivo: a primeira pasta precisa
 * ser a organização do JWT (`(storage.foldername(name))[1] = current_org_id()`).
 * Por isso quem envia um arquivo precisa saber a organização ANTES de montar
 * o caminho — e ela vem daqui, do mesmo claim assinado que o RLS usa.
 *
 * Nunca levanta: sem token (ou token malformado) devolve null, e quem chama
 * decide o que dizer ao usuário.
 */
const claims = () => {
  try {
    const tok = localStorage.getItem('supabase_token');
    return JSON.parse(atob(tok.split('.')[1])) || {};
  } catch (_) {
    return {};
  }
};

export const currentOrgId = () => claims().organization_id || null;

export const currentUserId = () => claims().sub || null;
