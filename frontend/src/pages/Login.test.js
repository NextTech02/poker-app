/**
 * Tela de login.
 *
 * Quatro decisões dela têm consequência direta e são o que os testes travam:
 *
 * 1. **Link de e-mail expirado cai AQUI.** Quando o Supabase não valida o
 *    link do convite, ele manda para a URL do site com o erro no fragmento.
 *    Sem tratar, a pessoa via só o formulário e não entendia por que o
 *    convite "não funcionou".
 * 2. **"Esqueci a senha" responde igual exista ou não a conta.** Confirmar
 *    um e-mail cadastrado entregaria a lista de usuários a quem tentasse
 *    adivinhar.
 * 3. **Quem trabalha em mais de um clube escolhe onde entrar.** Ir direto
 *    para o último faria o operador mexer no caixa da organização errada.
 * 4. **O token é gravado com a resposta do login**, não esperando o
 *    contexto: o interceptor do axios lê do localStorage e a chamada
 *    seguinte sairia sem autenticação.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Login from './Login';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../config/supabase';
import api from '../config/api';

jest.mock('../contexts/AuthContext', () => ({ useAuth: jest.fn() }));
jest.mock('../config/supabase', () => ({
  supabase: { auth: { resetPasswordForEmail: jest.fn() } },
}));
jest.mock('../config/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('../components/LanguageSelector', () => () => <div data-testid="idiomas" />);
jest.mock('../assets/aceblind-logo-white.png', () => 'logo.png');

const mockCaptcha = { getToken: jest.fn() };
jest.mock('../components/Captcha', () => {
  const { forwardRef, useImperativeHandle } = require('react');
  return {
    __esModule: true,
    default: forwardRef((props, ref) => {
      useImperativeHandle(ref, () => mockCaptcha);
      return <div data-testid="captcha" />;
    }),
    captchaAtivo: () => true,
  };
});

const mockNavegar = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavegar,
}));

jest.mock('react-i18next', () => {
  const t = (chave, padrao) => (typeof padrao === 'string' ? padrao : chave);
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

let entrar;

const montar = () => render(<MemoryRouter><Login /></MemoryRouter>);

const preencherEEnviar = async (email = 'operador@clube.com', senha = 'segredo') => {
  await userEvent.type(screen.getByLabelText('login.email'), email);
  await userEvent.type(screen.getByLabelText('login.password'), senha);
  await userEvent.click(screen.getByRole('button', { name: 'login.submit' }));
};

beforeEach(() => {
  localStorage.clear();
  mockNavegar.mockClear();
  entrar = jest.fn().mockResolvedValue({
    data: { session: { access_token: 'token-abc' } },
    error: null,
  });
  useAuth.mockReturnValue({ signIn: entrar });
  mockCaptcha.getToken.mockResolvedValue('captcha-ok');
  api.get.mockResolvedValue({ data: [{ id: 'org-a' }] });
  supabase.auth.resetPasswordForEmail.mockResolvedValue({});
  window.history.replaceState({}, '', '/login');
});

describe('entrada', () => {
  it('envia e-mail, senha e o token do captcha', async () => {
    montar();
    await preencherEEnviar();
    await waitFor(() =>
      expect(entrar).toHaveBeenCalledWith('operador@clube.com', 'segredo', 'captcha-ok')
    );
  });

  it('grava o token junto com a resposta do login', async () => {
    // O interceptor do axios lê do localStorage; esperar o contexto faria a
    // chamada seguinte sair sem autenticação.
    montar();
    await preencherEEnviar();
    await waitFor(() => expect(localStorage.getItem('supabase_token')).toBe('token-abc'));
  });

  it('com uma organização só entra direto', async () => {
    montar();
    await preencherEEnviar();
    await waitFor(() => expect(mockNavegar).toHaveBeenCalledWith('/'));
  });

  it('com mais de uma organização pede para escolher', async () => {
    // Ir direto para a última faria o operador mexer no caixa do clube errado.
    api.get.mockResolvedValue({ data: [{ id: 'org-a' }, { id: 'org-b' }] });
    montar();
    await preencherEEnviar();
    await waitFor(() =>
      expect(mockNavegar).toHaveBeenCalledWith('/selecionar-organizacao', {
        state: { orgs: [{ id: 'org-a' }, { id: 'org-b' }] },
      })
    );
  });

  it('falha ao consultar as organizações não bloqueia o login', async () => {
    // O operador precisa entrar mesmo com esse endpoint fora do ar.
    api.get.mockRejectedValue(new Error('500'));
    montar();
    await preencherEEnviar();
    await waitFor(() => expect(mockNavegar).toHaveBeenCalledWith('/'));
  });

  it('credencial errada mostra o aviso e libera o botão', async () => {
    entrar.mockResolvedValue({ data: null, error: { message: 'Invalid login' } });
    montar();
    await preencherEEnviar();
    expect(await screen.findByText('login.invalidCredentials')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'login.submit' })).not.toBeDisabled();
    expect(mockNavegar).not.toHaveBeenCalled();
  });

  it('login sem sessão na resposta não grava token', async () => {
    entrar.mockResolvedValue({ data: {}, error: null });
    montar();
    await preencherEEnviar();
    await waitFor(() => expect(mockNavegar).toHaveBeenCalled());
    expect(localStorage.getItem('supabase_token')).toBeNull();
  });

  it('captcha que falha avisa em vez de travar o botão', async () => {
    // Sem isso, o botão ficaria em "Entrando..." para sempre e o operador
    // não saberia o motivo.
    mockCaptcha.getToken.mockRejectedValue(new Error('CAPTCHA_TEMPO_ESGOTADO'));
    montar();
    await preencherEEnviar();
    expect(
      await screen.findByText(/verificação de segurança/)
    ).toBeInTheDocument();
    expect(entrar).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'login.submit' })).not.toBeDisabled();
  });

  it('mostra o aviso exigido pelo hCaptcha', async () => {
    // No modo invisível não há widget na tela: sem o aviso, o operador não
    // saberia que a proteção existe.
    montar();
    expect(screen.getByText(/Protegido por hCaptcha/)).toBeInTheDocument();
  });
});

describe('link de e-mail com erro', () => {
  it('link expirado explica o que fazer', async () => {
    // A pessoa clicou no convite e caiu no login; sem a mensagem, ela acha
    // que o sistema está quebrado.
    window.history.replaceState({}, '', '/login#error=access_denied&error_code=otp_expired');
    montar();
    expect(await screen.findByText(/Este link expirou/)).toBeInTheDocument();
  });

  it('reconhece a expiração pela descrição também', async () => {
    window.history.replaceState(
      {}, '', '/login#error=access_denied&error_description=Email+link+is+expired'
    );
    montar();
    expect(await screen.findByText(/Este link expirou/)).toBeInTheDocument();
  });

  it('outro erro de link tem mensagem própria', async () => {
    window.history.replaceState({}, '', '/login#error=access_denied&error_code=invalid_request');
    montar();
    expect(await screen.findByText(/Não foi possível validar este link/)).toBeInTheDocument();
  });

  it('erro na query string também é tratado', async () => {
    window.history.replaceState({}, '', '/login?error=access_denied&error_code=otp_expired');
    montar();
    expect(await screen.findByText(/Este link expirou/)).toBeInTheDocument();
  });

  it('limpa a URL para o aviso não voltar a cada recarga', async () => {
    window.history.replaceState({}, '', '/login#error=access_denied&error_code=otp_expired');
    montar();
    await screen.findByText(/Este link expirou/);
    expect(window.location.hash).toBe('');
  });

  it('URL limpa não mostra aviso nenhum', () => {
    montar();
    expect(document.querySelector('.error-message')).toBeNull();
  });
});

describe('esqueci minha senha', () => {
  const irParaEsqueci = async () => {
    montar();
    await userEvent.click(screen.getByRole('button', { name: /Esqueci minha senha/ }));
  };

  it('troca para o formulário de recuperação', async () => {
    await irParaEsqueci();
    expect(screen.getByLabelText('login.email')).toBeInTheDocument();
    expect(screen.queryByLabelText('login.password')).toBeNull();
  });

  it('envia o link com destino e captcha', async () => {
    await irParaEsqueci();
    await userEvent.type(screen.getByLabelText('login.email'), 'a@b.com');
    await userEvent.click(screen.getByRole('button', { name: /Enviar link/ }));
    await waitFor(() =>
      expect(supabase.auth.resetPasswordForEmail).toHaveBeenCalledWith('a@b.com', {
        redirectTo: expect.stringContaining('/definir-senha'),
        captchaToken: 'captcha-ok',
      })
    );
  });

  it('a resposta é a mesma exista ou não a conta', async () => {
    // Confirmar um e-mail cadastrado entregaria a lista de usuários a quem
    // tentasse adivinhar.
    await irParaEsqueci();
    await userEvent.type(screen.getByLabelText('login.email'), 'nao-existe@x.com');
    await userEvent.click(screen.getByRole('button', { name: /Enviar link/ }));
    expect(await screen.findByText(/Se houver uma conta com esse e-mail/)).toBeInTheDocument();
  });

  it('captcha que falha avisa e não envia', async () => {
    mockCaptcha.getToken.mockRejectedValue(new Error('falhou'));
    await irParaEsqueci();
    await userEvent.type(screen.getByLabelText('login.email'), 'a@b.com');
    await userEvent.click(screen.getByRole('button', { name: /Enviar link/ }));
    expect(await screen.findByText(/verificação de segurança/)).toBeInTheDocument();
    expect(supabase.auth.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it('voltar limpa os avisos da tela anterior', async () => {
    // Um "link enviado" pendurado sobre o formulário de login confundiria.
    await irParaEsqueci();
    await userEvent.type(screen.getByLabelText('login.email'), 'a@b.com');
    await userEvent.click(screen.getByRole('button', { name: /Enviar link/ }));
    await screen.findByText(/Se houver uma conta/);
    await userEvent.click(screen.getByRole('button', { name: /Voltar para o login/ }));
    expect(screen.queryByText(/Se houver uma conta/)).toBeNull();
    expect(screen.getByLabelText('login.password')).toBeInTheDocument();
  });

  it('ir para recuperação limpa a senha digitada', async () => {
    // Ela ficaria em memória sem uso, e voltaria preenchida ao retornar.
    montar();
    await userEvent.type(screen.getByLabelText('login.password'), 'segredo');
    await userEvent.click(screen.getByRole('button', { name: /Esqueci minha senha/ }));
    await userEvent.click(screen.getByRole('button', { name: /Voltar para o login/ }));
    expect(screen.getByLabelText('login.password')).toHaveValue('');
  });
});
