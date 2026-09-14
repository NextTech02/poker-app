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

  it('a segunda verificação NÃO segura a tela', async () => {
    // O BUG QUE ISTO PROTEGE.
    //
    // `verificando` faz o PrivateRoute mostrar "Carregando", e mostrar isso é
    // DESMONTAR a página aberta. A verificação roda de novo toda vez que o
    // token é renovado — ao voltar para a aba, por exemplo — e na ativação do
    // 2FA isso apagava o QR code e o factorId no meio do processo.
    //
    // O estrago não era do 2FA: qualquer tela com formulário aberto perdia o
    // preenchimento ao trocar de aba.
    nivel('aal1', 'aal1');
    const { result, rerender } = renderHook(({ u }) => useMfaGate(u), {
      initialProps: { u: { id: 'u1' } },
    });
    await waitFor(() => expect(result.current.verificando).toBe(false));

    // Token renovado: o AuthContext entrega um objeto novo para a MESMA pessoa.
    rerender({ u: { id: 'u1' } });
    expect(result.current.verificando).toBe(false);
  });

  it('a primeira verificação SEGURA a tela', async () => {
    // A primeira precisa segurar: pintar a tela antes de saber se falta o
    // segundo fator mostraria o sistema a quem ainda não passou por ele.
    //
    // A consulta fica PENDENTE de propósito. A primeira versão deste teste
    // afirmava `verificando === true` logo após o render e passava por sorte
    // de temporização — o `.finally()` da correção adia a resolução num tique
    // de microtask, e era esse tique que a asserção enxergava. Um teste que
    // depende de ordem de microtask não protege nada.
    let resolver;
    supabase.auth.mfa.getAuthenticatorAssuranceLevel.mockReturnValue(
      new Promise((r) => { resolver = r; }),
    );

    const { result } = renderHook(() => useMfaGate({ id: 'u1' }));
    expect(result.current.verificando).toBe(true);

    resolver({ data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null });
    await waitFor(() => expect(result.current.verificando).toBe(false));
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
