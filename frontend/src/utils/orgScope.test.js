/**
 * Troca de organização ativa.
 *
 * O isolamento entre clubes é decidido pelo CLAIM ASSINADO do token, não por
 * nada que o cliente mande. Por isso avisar o backend não basta: sem um token
 * NOVO, o RLS continua enxergando a organização anterior e a tela abriria
 * mostrando dados do clube errado. A sequência é gravar a escolha → renovar a
 * sessão → recarregar.
 *
 * A limpeza no meio existe por um motivo concreto: a etapa selecionada e o
 * cache em memória pertencem à organização ANTERIOR. Mantê-los faria as telas
 * pedirem uma etapa que o RLS da nova organização não devolve — a operação
 * abriria vazia, sem erro nenhum.
 */
import { currentOrgId, isPlatformAdminToken, enterOrg } from './orgScope';
import api from '../config/api';
import { supabase } from '../config/supabase';
import { clearCache } from './apiCache';

jest.mock('../config/api', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('../config/supabase', () => ({
  supabase: { auth: { refreshSession: jest.fn() } },
}));
jest.mock('./apiCache', () => ({ clearCache: jest.fn() }));

const ORG_A = '33333333-3333-3333-3333-333333333333';
const ORG_B = '44444444-4444-4444-4444-444444444444';

/** Monta um JWT de mentira: só o payload importa (nunca é verificado aqui). */
function tokenCom(payload) {
  const base64 = btoa(JSON.stringify(payload));
  return `cabecalho.${base64}.assinatura`;
}

beforeEach(() => {
  localStorage.clear();
  jest.clearAllMocks();
  api.post.mockResolvedValue({});
  supabase.auth.refreshSession.mockResolvedValue({ error: null });
  delete window.location;
  window.location = { href: '' };
});

describe('leitura do token atual', () => {
  it('devolve a organização do claim', () => {
    localStorage.setItem('supabase_token', tokenCom({ organization_id: ORG_A }));
    expect(currentOrgId()).toBe(ORG_A);
  });

  it('sem token devolve null', () => {
    expect(currentOrgId()).toBeNull();
  });

  it('token malformado devolve null em vez de estourar', () => {
    // Token truncado por um logout parcial não pode derrubar o menu.
    localStorage.setItem('supabase_token', 'isso-nao-e-um-jwt');
    expect(currentOrgId()).toBeNull();
  });

  it('token sem o claim de organização devolve null', () => {
    localStorage.setItem('supabase_token', tokenCom({ sub: 'u1' }));
    expect(currentOrgId()).toBeNull();
  });

  it('reconhece o admin da plataforma', () => {
    localStorage.setItem('supabase_token', tokenCom({ platform_admin: true }));
    expect(isPlatformAdminToken()).toBe(true);
  });

  it('exige o valor booleano exato', () => {
    // Um claim "true" em texto não pode passar por verdadeiro: o admin da
    // plataforma atravessa organizações.
    localStorage.setItem('supabase_token', tokenCom({ platform_admin: 'true' }));
    expect(isPlatformAdminToken()).toBe(false);
  });

  it('sem token não é admin da plataforma', () => {
    expect(isPlatformAdminToken()).toBe(false);
  });

  it('token malformado não é admin da plataforma', () => {
    localStorage.setItem('supabase_token', 'quebrado');
    expect(isPlatformAdminToken()).toBe(false);
  });
});

describe('entrada em outra organização', () => {
  it('grava a escolha, renova a sessão e recarrega', async () => {
    await enterOrg(ORG_B);
    expect(api.post).toHaveBeenCalledWith('/organizations/switch', {
      organization_id: ORG_B,
    });
    expect(supabase.auth.refreshSession).toHaveBeenCalled();
    expect(window.location.href).toBe('/');
  });

  it('recarrega no destino informado', async () => {
    await enterOrg(ORG_B, '/torneios');
    expect(window.location.href).toBe('/torneios');
  });

  it('descarta a etapa da organização anterior', async () => {
    // Sem isso, a operação abriria vazia: o RLS da nova organização não
    // devolve a etapa antiga, e nenhuma mensagem explicaria o motivo.
    localStorage.setItem('selected_stage', JSON.stringify({ id: 'etapa-antiga' }));
    await enterOrg(ORG_B);
    expect(localStorage.getItem('selected_stage')).toBeNull();
  });

  it('limpa o cache em memória', async () => {
    // As chaves do cache não são escopadas por organização.
    await enterOrg(ORG_B);
    expect(clearCache).toHaveBeenCalled();
  });

  it('falha ao renovar a sessão aborta a troca', async () => {
    // Recarregar com o token velho deixaria a interface dizendo um clube e o
    // RLS respondendo outro — o pior estado possível.
    supabase.auth.refreshSession.mockResolvedValue({ error: new Error('sem rede') });
    await expect(enterOrg(ORG_B)).rejects.toThrow('sem rede');
    expect(window.location.href).toBe('');
  });

  it('falha ao gravar a escolha não renova nem recarrega', async () => {
    api.post.mockRejectedValue(new Error('403'));
    await expect(enterOrg(ORG_B)).rejects.toThrow('403');
    expect(supabase.auth.refreshSession).not.toHaveBeenCalled();
    expect(window.location.href).toBe('');
  });

  it('a etapa só é descartada depois de a sessão ser renovada', async () => {
    // Se limpasse antes e a renovação falhasse, o operador perderia a etapa
    // selecionada sem ter trocado de organização.
    localStorage.setItem('selected_stage', JSON.stringify({ id: 'etapa-antiga' }));
    supabase.auth.refreshSession.mockResolvedValue({ error: new Error('sem rede') });
    await expect(enterOrg(ORG_B)).rejects.toThrow();
    expect(localStorage.getItem('selected_stage')).not.toBeNull();
  });
});
