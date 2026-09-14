/**
 * A segunda etapa do login.
 *
 * O que estes testes travam:
 *
 * 1. **O caminho de quem perdeu o celular existe e funciona.** Sem ele a pessoa
 *    fica presa numa tela que não tem como preencher — de madrugada, com a sala
 *    cheia. É a parte que mais importa desta tela.
 * 2. **O código de recuperação passa pelo NOSSO backend**, não pelo Supabase:
 *    ele remove o fator, não promove a sessão.
 * 3. **Sempre há uma saída.** Sair precisa estar na tela.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MfaChallenge from './MfaChallenge';
import { supabase } from '../config/supabase';
import api from '../config/api';

jest.mock('../config/supabase', () => ({
  supabase: {
    auth: {
      mfa: { listFactors: jest.fn(), challenge: jest.fn(), verify: jest.fn() },
      refreshSession: jest.fn(),
    },
  },
}));
jest.mock('../config/api', () => ({ __esModule: true, default: { post: jest.fn() } }));

const mockSignOut = jest.fn();
jest.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ signOut: mockSignOut }) }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (chave, padrao) => padrao || chave }),
}));

const FATOR = { id: 'f1', friendly_name: 'Celular' };

const montar = async (aoConfirmar = jest.fn()) => {
  supabase.auth.mfa.listFactors.mockResolvedValue({ data: { totp: [FATOR] }, error: null });
  render(<MfaChallenge aoConfirmar={aoConfirmar} />);
  await waitFor(() => expect(screen.queryByText('Carregando...')).toBeNull());
  return aoConfirmar;
};

beforeEach(() => {
  jest.clearAllMocks();
  supabase.auth.refreshSession.mockResolvedValue({});
});

describe('confirmar pelo aplicativo', () => {
  it('código certo confirma e libera a tela', async () => {
    const aoConfirmar = await montar();
    supabase.auth.mfa.challenge.mockResolvedValue({ data: { id: 'c1' }, error: null });
    supabase.auth.mfa.verify.mockResolvedValue({ data: {}, error: null });

    await userEvent.type(screen.getByLabelText('Código do aplicativo'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar' }));

    await waitFor(() => expect(aoConfirmar).toHaveBeenCalled());
    expect(supabase.auth.mfa.verify).toHaveBeenCalledWith(
      expect.objectContaining({ factorId: 'f1', challengeId: 'c1', code: '123456' }),
    );
  });

  it('código errado mostra o motivo e limpa o campo', async () => {
    // Deixar o número errado no campo faz a pessoa tentar de novo com ele.
    const aoConfirmar = await montar();
    supabase.auth.mfa.challenge.mockResolvedValue({ data: { id: 'c1' }, error: null });
    supabase.auth.mfa.verify.mockResolvedValue({ data: null, error: { message: 'Invalid TOTP code entered' } });

    await userEvent.type(screen.getByLabelText('Código do aplicativo'), '000000');
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(aoConfirmar).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Código do aplicativo')).toHaveValue('');
  });
});

describe('perdi o celular', () => {
  it('a saída existe na tela', async () => {
    // Sem ela, quem perdeu o aparelho não tem o que fazer aqui.
    await montar();
    expect(screen.getByRole('button', { name: 'Perdi o celular' })).toBeInTheDocument();
  });

  it('o código de recuperação vai para o NOSSO backend, não para o Supabase', async () => {
    // Ele remove o fator — não promove a sessão. Só o `mfa.verify` do Supabase
    // promove, e ele exige justamente o aparelho que a pessoa perdeu.
    const aoConfirmar = await montar();
    api.post.mockResolvedValue({ data: { removed_factors: 1, recovery_codes_remaining: 7 } });

    await userEvent.click(screen.getByRole('button', { name: 'Perdi o celular' }));
    await userEvent.type(screen.getByLabelText('Código de recuperação'), 'ABCDE-FGHIJ');
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar' }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/auth/mfa/recover', { code: 'ABCDE-FGHIJ' }));
    expect(supabase.auth.mfa.verify).not.toHaveBeenCalled();
    // O token precisa ser renovado: sem isso o banco continuaria exigindo o
    // segundo fator de um fator que não existe mais.
    expect(supabase.auth.refreshSession).toHaveBeenCalled();
    expect(aoConfirmar).toHaveBeenCalled();
  });

  it('o aviso diz que a recuperação DESLIGA o segundo fator', async () => {
    // A pessoa precisa saber o que vai acontecer antes de gastar um código.
    await montar();
    await userEvent.click(screen.getByRole('button', { name: 'Perdi o celular' }));
    expect(screen.getByText(/DESLIGAR a verificação em duas etapas/)).toBeInTheDocument();
  });

  it('código de recuperação inválido mostra a mensagem do servidor', async () => {
    await montar();
    api.post.mockRejectedValue({ userMessage: 'Código de recuperação inválido ou já utilizado.' });

    await userEvent.click(screen.getByRole('button', { name: 'Perdi o celular' }));
    await userEvent.type(screen.getByLabelText('Código de recuperação'), 'ZZZZZ-ZZZZZ');
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar' }));

    expect(await screen.findByRole('alert'))
      .toHaveTextContent('Código de recuperação inválido ou já utilizado.');
  });

  it('dá para voltar para o aplicativo', async () => {
    await montar();
    await userEvent.click(screen.getByRole('button', { name: 'Perdi o celular' }));
    await userEvent.click(screen.getByRole('button', { name: 'Usar o aplicativo autenticador' }));
    expect(screen.getByLabelText('Código do aplicativo')).toBeInTheDocument();
  });
});

describe('saídas', () => {
  it('sair está sempre disponível', async () => {
    // Uma tela sem saída nenhuma é um sistema que prende o usuário.
    await montar();
    await userEvent.click(screen.getByRole('button', { name: 'Sair' }));
    expect(mockSignOut).toHaveBeenCalled();
  });
});
