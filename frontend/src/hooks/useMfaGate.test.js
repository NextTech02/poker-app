/**
 * Quando a sessão precisa passar pelo segundo fator.
 *
 * O que estes testes travam:
 *
 * 1. **Só trava quem tem 2FA e ainda não confirmou.** Travar quem não usa
 *    deixaria os 15 funcionários fora do sistema.
 * 2. **Falha ao ler o nível NÃO trava.** Aqui errar para o lado de deixar
 *    passar é o lado seguro, porque a recusa de verdade está no banco — uma
 *    política RESTRICTIVE em todas as tabelas. Errar para o lado de travar
 *    poria todo mundo fora por um problema de biblioteca.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { useMfaGate } from './useMfaGate';
import { supabase } from '../config/supabase';

jest.mock('../config/supabase', () => ({
  supabase: { auth: { mfa: { getAuthenticatorAssuranceLevel: jest.fn() } } },
}));

const nivel = (currentLevel, nextLevel) =>
  supabase.auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue({
    data: { currentLevel, nextLevel }, error: null,
  });

const USUARIO = { id: 'u1' };

const montar = async (user = USUARIO) => {
  const r = renderHook(() => useMfaGate(user));
  await waitFor(() => expect(r.result.current.verificando).toBe(false));
  return r;
};

describe('useMfaGate', () => {
  it('tem 2FA e ainda não confirmou: TRAVA', async () => {
    nivel('aal1', 'aal2');
    const { result } = await montar();
    expect(result.current.precisaConfirmar).toBe(true);
  });

  it('não usa 2FA: não trava', async () => {
    // É o caso de todos os funcionários hoje.
    nivel('aal1', 'aal1');
    const { result } = await montar();
    expect(result.current.precisaConfirmar).toBe(false);
  });

  it('já confirmou nesta sessão: não trava', async () => {
    nivel('aal2', 'aal2');
    const { result } = await montar();
    expect(result.current.precisaConfirmar).toBe(false);
  });

  it('desligou o 2FA com o token velho na mão: não trava', async () => {
    // aal2 atual, aal1 seguinte. A sessão vale mais do que a conta exige.
    nivel('aal2', 'aal1');
    const { result } = await montar();
    expect(result.current.precisaConfirmar).toBe(false);
  });

  it('sem usuário não pergunta nada', async () => {
    const { result } = await montar(null);
    expect(result.current.precisaConfirmar).toBe(false);
    expect(supabase.auth.mfa.getAuthenticatorAssuranceLevel).not.toHaveBeenCalled();
  });

  it('falha ao ler o nível NÃO tranca o sistema', async () => {
    // Versão do Supabase sem MFA, token ilegível, qualquer defeito de
    // biblioteca: a tela deixa passar, e quem recusa é o banco. O contrário
    // poria os 15 funcionários fora por causa de um erro de leitura.
    supabase.auth.mfa.getAuthenticatorAssuranceLevel.mockRejectedValue(new Error('boom'));
    const { result } = await montar();
    expect(result.current.precisaConfirmar).toBe(false);
  });

  it('erro devolvido no lugar de exceção também não tranca', async () => {
    supabase.auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: null, error: { message: 'nope' },
    });
    const { result } = await montar();
    expect(result.current.precisaConfirmar).toBe(false);
  });

  it('reavaliar relê o nível — é como a tela destrava depois do código', async () => {
    nivel('aal1', 'aal2');
    const { result } = await montar();
    expect(result.current.precisaConfirmar).toBe(true);

    nivel('aal2', 'aal2');
    await result.current.reavaliar();
    await waitFor(() => expect(result.current.precisaConfirmar).toBe(false));
  });
});
