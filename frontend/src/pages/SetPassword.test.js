/**
 * Tela de definir senha — destino de DOIS fluxos que chegam por e-mail:
 * convite (cadastro inicial, uso único) e recuperação (só a senha, quantas
 * vezes precisar).
 *
 * O que decide se ainda falta CADASTRO é a conta nunca ter concluído
 * (`onboarded_at`), **não** o caminho pelo qual a pessoa chegou. Isso é o
 * ponto mais importante daqui, e veio de um problema real: com o convite
 * expirado, a pessoa recorre a "Esqueci minha senha". Se esse caminho apenas
 * trocasse a senha, `onboarded_at` nunca seria gravado e o guard do app
 * devolveria para esta tela a cada entrada — laço sem saída e sem mensagem.
 *
 * O outro ponto são as mensagens de erro do Supabase, que vêm em inglês e
 * confundem justamente quem acha que nunca definiu senha: "deve ser diferente
 * da anterior" na verdade significa "seu cadastro já deu certo, entre com
 * ela".
 */
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import SetPassword from './SetPassword';
import { supabase } from '../config/supabase';

jest.mock('../config/supabase', () => ({
  supabase: {
    auth: { getSession: jest.fn(), onAuthStateChange: jest.fn(), updateUser: jest.fn() },
    rpc: jest.fn(),
  },
}));
jest.mock('../components/LanguageSelector', () => () => <div data-testid="idiomas" />);
jest.mock('../assets/aceblind-logo-white.png', () => 'logo.png');

const mockNavegar = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavegar,
}));

jest.mock('react-i18next', () => {
  const t = (chave, padrao, vars) => {
    let texto = typeof padrao === 'string' ? padrao : chave;
    if (vars) {
      Object.entries(vars).forEach(([k, v]) => {
        texto = texto.replace(`{{${k}}}`, v);
      });
    }
    return texto;
  };
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

let emitirEvento;

const sessao = (meta = {}) => ({
  user: { id: 'u1', email: 'novo@clube.com', user_metadata: meta },
});

const montar = async ({ hash = '', sess = sessao() } = {}) => {
  window.location.hash = hash;
  supabase.auth.getSession.mockResolvedValue({ data: { session: sess } });
  render(<MemoryRouter><SetPassword /></MemoryRouter>);
  // Com erro no fragmento o componente sai antes de consultar a sessao —
  // esperar pelo getSession travaria o teste.
  if (!hash.includes('error=')) {
    await waitFor(() => expect(supabase.auth.getSession).toHaveBeenCalled());
  }
};

const preencher = async ({ nome, senha = 'senhaforte1', confirma = 'senhaforte1' }) => {
  if (nome !== undefined) {
    await userEvent.type(screen.getByLabelText('Seu nome'), nome);
  }
  await userEvent.type(screen.getByLabelText('Nova senha'), senha);
  await userEvent.type(screen.getByLabelText('Confirme a senha'), confirma);
};

const enviar = () =>
  userEvent.click(document.querySelector('button[type="submit"]'));

beforeEach(() => {
  jest.useRealTimers();
  mockNavegar.mockClear();
  window.location.hash = '';
  supabase.auth.onAuthStateChange.mockImplementation((fn) => {
    emitirEvento = fn;
    return { data: { subscription: { unsubscribe: jest.fn() } } };
  });
  supabase.auth.updateUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
  supabase.rpc.mockResolvedValue({ data: null });
  delete window.location;
  window.location = { href: '', hash: '' };
});

describe('estado do link', () => {
  it('link com erro no fragmento é recusado de cara', async () => {
    // Link expirado ou já usado volta sem sessão; esperar 4s seria só atraso.
    await montar({ hash: '#error=access_denied', sess: null });
    expect(await screen.findByText('Link inválido ou expirado')).toBeInTheDocument();
  });

  it('sem sessão em 4 segundos o link é dado como inválido', async () => {
    jest.useFakeTimers();
    supabase.auth.getSession.mockResolvedValue({ data: { session: null } });
    render(<MemoryRouter><SetPassword /></MemoryRouter>);
    await act(async () => {});
    await act(async () => {
      jest.advanceTimersByTime(4000);
    });
    expect(screen.getByText('Link inválido ou expirado')).toBeInTheDocument();
    jest.useRealTimers();
  });

  it('enquanto valida, mostra o carregamento', () => {
    supabase.auth.getSession.mockReturnValue(new Promise(() => {}));
    render(<MemoryRouter><SetPassword /></MemoryRouter>);
    expect(screen.getByText('Carregando...')).toBeInTheDocument();
  });

  it('link inválido oferece o caminho para o login', async () => {
    await montar({ hash: '#error=x', sess: null });
    await userEvent.click(await screen.findByRole('button', { name: 'Ir para o login' }));
    expect(mockNavegar).toHaveBeenCalledWith('/login');
  });

  it('a sessão pode chegar pelo evento, não só pelo getSession', async () => {
    // O supabase-js às vezes autentica depois de ler o fragmento.
    supabase.auth.getSession.mockResolvedValue({ data: { session: null } });
    render(<MemoryRouter><SetPassword /></MemoryRouter>);
    await waitFor(() => expect(emitirEvento).toBeTruthy());
    await act(async () => emitirEvento('SIGNED_IN', sessao()));
    expect(screen.getByLabelText('Nova senha')).toBeInTheDocument();
  });
});

describe('convite (cadastro inicial)', () => {
  it('pede nome e senha', async () => {
    await montar();
    expect(await screen.findByLabelText('Seu nome')).toBeInTheDocument();
    expect(screen.getByText(/Complete seu cadastro/)).toBeInTheDocument();
  });

  it('mostra de quem é o acesso sendo criado', async () => {
    // Evita a pessoa cadastrar a conta de outro por engano num computador
    // compartilhado.
    await montar();
    expect(await screen.findByText(/novo@clube.com/)).toBeInTheDocument();
  });

  it('pré-preenche o nome que veio no convite', async () => {
    await montar({ sess: sessao({ full_name: 'Ana Souza' }) });
    expect(await screen.findByLabelText('Seu nome')).toHaveValue('Ana Souza');
  });

  it('convite já concluído é de uso único', async () => {
    // Sem isso, um link antigo reabriria o cadastro e reescreveria o nome.
    await montar({ sess: sessao({ onboarded_at: '2026-06-01T00:00:00Z' }) });
    expect(await screen.findByText('Convite já utilizado')).toBeInTheDocument();
    expect(screen.queryByLabelText('Nova senha')).toBeNull();
  });

  it('grava nome e a marca de cadastro concluído', async () => {
    await montar();
    await screen.findByLabelText('Seu nome');
    await preencher({ nome: 'Ana Souza' });
    await enviar();
    await waitFor(() =>
      expect(supabase.auth.updateUser).toHaveBeenCalledWith({
        password: 'senhaforte1',
        data: { full_name: 'Ana Souza', onboarded_at: expect.any(String) },
      })
    );
  });

  it('fecha o vínculo de "aguardando cadastro" por RPC', async () => {
    // Vai por RPC porque o token ainda é o do convite e pode não ter o claim
    // de organização — o RLS recusaria um UPDATE direto em `staff`, e o nome
    // sumiria com o status preso.
    await montar();
    await screen.findByLabelText('Seu nome');
    await preencher({ nome: 'Ana Souza' });
    await enviar();
    await waitFor(() =>
      expect(supabase.rpc).toHaveBeenCalledWith('complete_staff_signup', {
        p_user: 'u1',
        p_name: 'Ana Souza',
      })
    );
  });

  it('falha na RPC não impede a entrada', async () => {
    // A senha já foi definida; travar aqui deixaria a pessoa sem acesso.
    supabase.rpc.mockRejectedValue(new Error('403'));
    await montar();
    await screen.findByLabelText('Seu nome');
    await preencher({ nome: 'Ana' });
    await enviar();
    await waitFor(() => expect(window.location.href).toBe('/'));
  });

  it('nome vazio é recusado antes de chamar o servidor', async () => {
    await montar();
    await screen.findByLabelText('Seu nome');
    await preencher({ nome: '   ' });
    await enviar();
    expect(await screen.findByText('Informe seu nome.')).toBeInTheDocument();
    expect(supabase.auth.updateUser).not.toHaveBeenCalled();
  });

  it('recarrega a aplicação ao concluir', async () => {
    // O app precisa nascer com a sessão e o perfil definitivos.
    await montar();
    await screen.findByLabelText('Seu nome');
    await preencher({ nome: 'Ana' });
    await enviar();
    await waitFor(() => expect(window.location.href).toBe('/'));
  });
});

describe('recuperação de senha', () => {
  it('conta já cadastrada só pede a nova senha', async () => {
    await montar({
      hash: '#type=recovery',
      sess: sessao({ onboarded_at: '2026-06-01T00:00:00Z' }),
    });
    expect(await screen.findByText('Escolha uma nova senha')).toBeInTheDocument();
    expect(screen.queryByLabelText('Seu nome')).toBeNull();
  });

  it('recuperação NÃO é bloqueada pelo "convite já utilizado"', async () => {
    // Trocar a senha pode ser feito quantas vezes precisar.
    await montar({
      hash: '#type=recovery',
      sess: sessao({ onboarded_at: '2026-06-01T00:00:00Z' }),
    });
    expect(await screen.findByLabelText('Nova senha')).toBeInTheDocument();
    expect(screen.queryByText('Convite já utilizado')).toBeNull();
  });

  it('o evento PASSWORD_RECOVERY também libera a tela', async () => {
    // Sinal confiável mesmo depois de o SDK limpar o fragmento da URL.
    await montar({ sess: sessao({ onboarded_at: '2026-06-01T00:00:00Z' }) });
    await screen.findByText('Convite já utilizado');
    await act(async () =>
      emitirEvento('PASSWORD_RECOVERY', sessao({ onboarded_at: '2026-06-01T00:00:00Z' }))
    );
    expect(await screen.findByLabelText('Nova senha')).toBeInTheDocument();
  });

  it('só a senha é enviada, sem reescrever o cadastro', async () => {
    await montar({
      hash: '#type=recovery',
      sess: sessao({ onboarded_at: '2026-06-01T00:00:00Z', full_name: 'Ana' }),
    });
    await screen.findByLabelText('Nova senha');
    await preencher({ senha: 'novasenha1', confirma: 'novasenha1' });
    await enviar();
    await waitFor(() =>
      expect(supabase.auth.updateUser).toHaveBeenCalledWith({ password: 'novasenha1' })
    );
  });

  it('quem NUNCA concluiu o cadastro completa por aqui também', async () => {
    // É o caso do convite expirado: a pessoa recorre a "esqueci a senha". Se
    // só trocasse a senha, `onboarded_at` nunca seria gravado e o app
    // devolveria para esta tela a cada entrada.
    await montar({ hash: '#type=recovery', sess: sessao({}) });
    expect(await screen.findByLabelText('Seu nome')).toBeInTheDocument();
    await preencher({ nome: 'Ana' });
    await enviar();
    await waitFor(() =>
      expect(supabase.auth.updateUser).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ onboarded_at: expect.any(String) }) })
      )
    );
  });
});

describe('validação da senha', () => {
  it('senha curta é recusada localmente', async () => {
    await montar();
    await screen.findByLabelText('Seu nome');
    await preencher({ nome: 'Ana', senha: 'curta', confirma: 'curta' });
    await enviar();
    expect(await screen.findByText(/pelo menos 8 caracteres/)).toBeInTheDocument();
    expect(supabase.auth.updateUser).not.toHaveBeenCalled();
  });

  it('confirmação diferente é recusada', async () => {
    await montar();
    await screen.findByLabelText('Seu nome');
    await preencher({ nome: 'Ana', senha: 'senhaforte1', confirma: 'outracoisa1' });
    await enviar();
    expect(await screen.findByText('As senhas não coincidem.')).toBeInTheDocument();
    expect(supabase.auth.updateUser).not.toHaveBeenCalled();
  });
});

describe('erros do servidor traduzidos', () => {
  const tentar = async (mensagem) => {
    supabase.auth.updateUser.mockResolvedValue({
      data: null,
      error: { message: mensagem },
    });
    await montar();
    await screen.findByLabelText('Seu nome');
    await preencher({ nome: 'Ana' });
    await enviar();
  };

  it('"diferente da senha anterior" explica que o cadastro já deu certo', async () => {
    // A mensagem crua confunde justamente quem acha que nunca definiu senha.
    await tentar('New password should be different from the old password.');
    expect(
      await screen.findByText(/já é a sua senha atual/)
    ).toBeInTheDocument();
  });

  it('senha vazada é explicada com o que fazer', async () => {
    // A proteção contra senhas vazadas responde em inglês e sem instrução.
    await tentar('Password is known to be weak and easy to guess');
    expect(
      await screen.findByText(/aparece em vazamentos conhecidos/)
    ).toBeInTheDocument();
  });

  it('link expirado no envio manda pedir outro', async () => {
    await tentar('Token has expired or is invalid');
    expect(await screen.findByText(/Este link expirou/)).toBeInTheDocument();
  });

  it('erro desconhecido mostra a mensagem do servidor', async () => {
    // Melhor um texto técnico do que "algo deu errado" sem pista nenhuma.
    await tentar('Rate limit exceeded');
    expect(await screen.findByText('Rate limit exceeded')).toBeInTheDocument();
  });

  it('erro libera o botão para nova tentativa', async () => {
    await tentar('Rate limit exceeded');
    await waitFor(() =>
      expect(document.querySelector('button[type="submit"]')).not.toBeDisabled()
    );
  });

  it('erro NÃO recarrega a aplicação', async () => {
    // Recarregar perderia a mensagem antes de a pessoa conseguir ler.
    await tentar('Rate limit exceeded');
    await screen.findByText('Rate limit exceeded');
    expect(window.location.href).toBe('');
  });
});
