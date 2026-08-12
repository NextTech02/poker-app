/**
 * Sessão do usuário.
 *
 * O comportamento não óbvio e mais importante daqui: **sessão nula estando
 * OFFLINE não desloga**. O supabase-js tenta renovar o token periodicamente;
 * sem rede, essa renovação falha e ele emite uma sessão nula. Tratar isso
 * como logout jogaria o operador na tela de login no meio do evento — com a
 * fila de operações offline presa e sem como sincronizar depois.
 *
 * Logout de verdade (o botão) remove o token diretamente, então continua
 * funcionando.
 */
import { render, screen, act, waitFor } from '@testing-library/react';
import { AuthProvider, useAuth } from './AuthContext';
import { supabase } from '../config/supabase';
import { clearCache } from '../utils/apiCache';
import { isOnline } from '../offline/connectivity';

jest.mock('../config/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(),
      onAuthStateChange: jest.fn(),
      signInWithPassword: jest.fn(),
      signUp: jest.fn(),
      signOut: jest.fn(),
    },
  },
}));
jest.mock('../utils/apiCache', () => ({ clearCache: jest.fn() }));
jest.mock('../offline/connectivity', () => ({ isOnline: jest.fn() }));

const USUARIO = { id: 'u1', email: 'operador@clube.com' };
const SESSAO = { user: USUARIO, access_token: 'token-abc' };

let emitirMudanca;
let cancelarAssinatura;

function Sonda() {
  const auth = useAuth();
  return (
    <div>
      <span data-testid="email">{auth.user?.email || 'sem usuário'}</span>
      <span data-testid="loading">{String(auth.loading)}</span>
    </div>
  );
}

const montar = () => render(<AuthProvider><Sonda /></AuthProvider>);

beforeEach(() => {
  localStorage.clear();
  cancelarAssinatura = jest.fn();
  supabase.auth.getSession.mockResolvedValue({ data: { session: null } });
  supabase.auth.onAuthStateChange.mockImplementation((fn) => {
    emitirMudanca = fn;
    return { data: { subscription: { unsubscribe: cancelarAssinatura } } };
  });
  isOnline.mockReturnValue(true);
});

describe('sessão inicial', () => {
  it('sem sessão o usuário fica vazio', async () => {
    montar();
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(screen.getByTestId('email')).toHaveTextContent('sem usuário');
  });

  it('com sessão carrega o usuário e guarda o token', async () => {
    // O token no localStorage é o que o interceptor do axios usa em toda
    // chamada; sem ele, a aplicação abre logada e recebe 401 em tudo.
    supabase.auth.getSession.mockResolvedValue({ data: { session: SESSAO } });
    montar();
    await waitFor(() =>
      expect(screen.getByTestId('email')).toHaveTextContent('operador@clube.com')
    );
    expect(localStorage.getItem('supabase_token')).toBe('token-abc');
  });

  it('cancela a assinatura ao desmontar', async () => {
    const { unmount } = montar();
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    unmount();
    expect(cancelarAssinatura).toHaveBeenCalled();
  });
});

describe('mudanças de sessão', () => {
  it('sessão nova atualiza usuário e token', async () => {
    montar();
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    act(() => emitirMudanca('SIGNED_IN', SESSAO));
    expect(screen.getByTestId('email')).toHaveTextContent('operador@clube.com');
    expect(localStorage.getItem('supabase_token')).toBe('token-abc');
  });

  it('sessão nula ONLINE desloga', async () => {
    supabase.auth.getSession.mockResolvedValue({ data: { session: SESSAO } });
    montar();
    await waitFor(() =>
      expect(screen.getByTestId('email')).toHaveTextContent('operador@clube.com')
    );
    act(() => emitirMudanca('SIGNED_OUT', null));
    expect(screen.getByTestId('email')).toHaveTextContent('sem usuário');
    expect(localStorage.getItem('supabase_token')).toBeNull();
  });

  it('sessão nula OFFLINE NÃO desloga', async () => {
    // Renovação de token falhou por falta de rede. Deslogar aqui jogaria o
    // operador na tela de login no meio do evento, com a fila offline presa.
    supabase.auth.getSession.mockResolvedValue({ data: { session: SESSAO } });
    isOnline.mockReturnValue(false);
    montar();
    await waitFor(() =>
      expect(screen.getByTestId('email')).toHaveTextContent('operador@clube.com')
    );
    act(() => emitirMudanca('TOKEN_REFRESHED', null));
    expect(screen.getByTestId('email')).toHaveTextContent('operador@clube.com');
    expect(localStorage.getItem('supabase_token')).toBe('token-abc');
  });
});

describe('operações de conta', () => {
  function SondaAcoes() {
    const { signIn, signUp, signOut } = useAuth();
    acoes = { signIn, signUp, signOut };
    return null;
  }
  let acoes;

  const montarAcoes = async () => {
    render(<AuthProvider><SondaAcoes /></AuthProvider>);
    await waitFor(() => expect(acoes).toBeTruthy());
    return acoes;
  };

  it('entra com e-mail e senha', async () => {
    supabase.auth.signInWithPassword.mockResolvedValue({ data: SESSAO, error: null });
    const { signIn } = await montarAcoes();
    await act(async () => {
      await signIn('operador@clube.com', 'senha');
    });
    expect(supabase.auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'operador@clube.com',
      password: 'senha',
    });
  });

  it('só envia o captcha quando a tela resolveu o desafio', async () => {
    // Mandar `captchaToken: undefined` sempre faria o Supabase recusar o
    // login quando a proteção está desligada.
    supabase.auth.signInWithPassword.mockResolvedValue({ data: SESSAO, error: null });
    const { signIn } = await montarAcoes();
    await act(async () => {
      await signIn('a@b.com', 'x', 'token-captcha');
    });
    expect(supabase.auth.signInWithPassword).toHaveBeenCalledWith(
      expect.objectContaining({ options: { captchaToken: 'token-captcha' } })
    );
  });

  it('devolve o erro de credencial em vez de estourar', async () => {
    const erro = { message: 'Invalid login credentials' };
    supabase.auth.signInWithPassword.mockResolvedValue({ data: null, error: erro });
    const { signIn } = await montarAcoes();
    let r;
    await act(async () => {
      r = await signIn('a@b.com', 'errada');
    });
    expect(r.error).toBe(erro);
  });

  it('cadastra', async () => {
    supabase.auth.signUp.mockResolvedValue({ data: SESSAO, error: null });
    const { signUp } = await montarAcoes();
    await act(async () => {
      await signUp('novo@clube.com', 'senha');
    });
    expect(supabase.auth.signUp).toHaveBeenCalledWith({
      email: 'novo@clube.com',
      password: 'senha',
    });
  });

  it('sair remove o token e limpa o cache', async () => {
    // O cache em memória não é escopado por usuário: mantê-lo mostraria os
    // dados do operador anterior para quem entrar em seguida.
    localStorage.setItem('supabase_token', 'token-abc');
    supabase.auth.signOut.mockResolvedValue({ error: null });
    const { signOut } = await montarAcoes();
    await act(async () => {
      await signOut();
    });
    expect(localStorage.getItem('supabase_token')).toBeNull();
    expect(clearCache).toHaveBeenCalled();
  });

  it('sair limpa o token mesmo se o servidor recusar', async () => {
    // Sessão já expirada no servidor: o operador precisa sair localmente de
    // qualquer forma, senão fica preso numa sessão morta.
    localStorage.setItem('supabase_token', 'token-abc');
    supabase.auth.signOut.mockResolvedValue({ error: { message: 'sessão inválida' } });
    const { signOut } = await montarAcoes();
    await act(async () => {
      await signOut();
    });
    expect(localStorage.getItem('supabase_token')).toBeNull();
  });
});
