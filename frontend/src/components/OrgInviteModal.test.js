/**
 * Convite de clube para quem JÁ tem conta.
 *
 * O ponto de produto: essa pessoa não refaz cadastro — ela já tem nome e
 * senha. Antes deste fluxo, ela era adicionada ao clube em silêncio, sem
 * aviso e sem escolha. O modal existe para haver uma DECISÃO.
 *
 * Duas decisões técnicas seguem daí:
 *
 * - **Dá para adiar.** Quem está no meio de um torneio não pode ficar preso
 *   numa tela. O adiamento vale só para a sessão: na próxima entrada o
 *   convite reaparece, porque ele não pode ser esquecido para sempre.
 * - **Aceitar exige token novo.** O vínculo entra no claim só na próxima
 *   emissão; sem recarregar, o clube aceito não apareceria no seletor e a
 *   pessoa acharia que o aceite não funcionou.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OrgInviteModal from './OrgInviteModal';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { enterOrg } from '../utils/orgScope';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() },
}));
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../utils/orgScope', () => ({ enterOrg: jest.fn() }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (chave, padrao, vars) => {
      let texto = typeof padrao === 'string' ? padrao : chave;
      if (vars) {
        Object.entries(vars).forEach(([k, v]) => {
          texto = texto.replace(`{{${k}}}`, v);
        });
      }
      return texto;
    },
  }),
}));

const CONVITE = {
  staff_id: 's1',
  organization_id: 'org-b',
  organization_name: 'Clube B',
  group_name: 'Caixa',
};

let toast;

const montar = async (convites = [CONVITE]) => {
  api.get.mockResolvedValue({ data: convites });
  render(<OrgInviteModal />);
  if (convites.length) await screen.findByRole('dialog');
};

beforeEach(() => {
  toast = { success: jest.fn(), error: jest.fn() };
  useToast.mockReturnValue({ toast });
  localStorage.setItem('supabase_token', 'token-abc');
  sessionStorage.clear();
  api.post.mockResolvedValue({});
  enterOrg.mockResolvedValue(undefined);
});

describe('quando aparece', () => {
  it('sem convite não renderiza nada', async () => {
    api.get.mockResolvedValue({ data: [] });
    const { container } = render(<OrgInviteModal />);
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('sem sessão nem pergunta ao servidor', async () => {
    // Telas públicas (login, /tv, transmissão) não têm a quem perguntar.
    localStorage.removeItem('supabase_token');
    render(<OrgInviteModal />);
    await waitFor(() => expect(api.get).not.toHaveBeenCalled());
  });

  it('falha ao consultar não atrapalha a operação', async () => {
    api.get.mockRejectedValue(new Error('403'));
    const { container } = render(<OrgInviteModal />);
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('um convite mostra o título no singular', async () => {
    await montar();
    expect(screen.getByText('Você recebeu um convite')).toBeInTheDocument();
  });

  it('vários convites mostram a quantidade', async () => {
    await montar([CONVITE, { ...CONVITE, staff_id: 's2', organization_name: 'Clube C' }]);
    expect(screen.getByText('Você recebeu 2 convites')).toBeInTheDocument();
  });

  it('mostra o clube e o grupo de permissão', async () => {
    // A pessoa precisa saber para que função está sendo chamada.
    await montar();
    expect(screen.getByText('Clube B')).toBeInTheDocument();
    expect(screen.getByText('Caixa')).toBeInTheDocument();
  });

  it('convite sem grupo diz isso explicitamente', async () => {
    await montar([{ ...CONVITE, group_name: null }]);
    expect(screen.getByText('Sem grupo de permissão')).toBeInTheDocument();
  });

  it('deixa claro que a conta continua a mesma', async () => {
    // É a dúvida imediata de quem recebe: "vou ter que criar outra senha?".
    await montar();
    expect(screen.getByText(/Sua conta continua a mesma/)).toBeInTheDocument();
  });
});

describe('aceitar', () => {
  it('aceita e entra no clube com token novo', async () => {
    // Sem o token novo o clube aceito não apareceria no seletor, e a pessoa
    // acharia que o aceite não funcionou.
    await montar();
    await userEvent.click(screen.getByRole('button', { name: 'Aceitar' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/organizations/invites/s1/accept')
    );
    await waitFor(() => expect(enterOrg).toHaveBeenCalledWith('org-b'));
    expect(toast.success).toHaveBeenCalledWith('Você agora faz parte de Clube B.');
  });

  it('com outro convite pendente, não recarrega ainda', async () => {
    // Recarregar no meio da fila descartaria os convites não respondidos.
    await montar([CONVITE, { ...CONVITE, staff_id: 's2', organization_name: 'Clube C' }]);
    await userEvent.click(screen.getAllByRole('button', { name: 'Aceitar' })[0]);
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(enterOrg).not.toHaveBeenCalled();
    expect(screen.getByText('Clube C')).toBeInTheDocument();
  });

  it('limite de usuários do plano vira mensagem legível', async () => {
    // O convidado precisa saber que o problema é do CLUBE, não dele.
    api.post.mockRejectedValue({
      userMessage: 'Este clube atingiu o limite de usuários do plano.',
    });
    await montar();
    await userEvent.click(screen.getByRole('button', { name: 'Aceitar' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Este clube atingiu o limite de usuários do plano.'
      )
    );
  });

  it('falha sem mensagem usa um texto padrão', async () => {
    api.post.mockRejectedValue(new Error('boom'));
    await montar();
    await userEvent.click(screen.getByRole('button', { name: 'Aceitar' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Não foi possível responder ao convite.'
      )
    );
  });

  it('falha mantém o convite na tela para nova tentativa', async () => {
    api.post.mockRejectedValue(new Error('boom'));
    await montar();
    await userEvent.click(screen.getByRole('button', { name: 'Aceitar' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.getByText('Clube B')).toBeInTheDocument();
  });

  it('os botões travam enquanto responde', async () => {
    // Clicar duas vezes aceitaria o mesmo convite duas vezes.
    let liberar;
    api.post.mockReturnValue(new Promise((r) => { liberar = r; }));
    await montar();
    await userEvent.click(screen.getByRole('button', { name: 'Aceitar' }));
    expect(screen.getByRole('button', { name: 'Recusar' })).toBeDisabled();
    liberar({});
  });
});

describe('recusar', () => {
  it('recusa e some da lista', async () => {
    await montar();
    await userEvent.click(screen.getByRole('button', { name: 'Recusar' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/organizations/invites/s1/decline')
    );
    expect(toast.success).toHaveBeenCalledWith('Convite recusado.');
  });

  it('recusar NÃO recarrega a aplicação', async () => {
    // Não houve mudança de vínculo; recarregar perderia o trabalho em curso.
    await montar();
    await userEvent.click(screen.getByRole('button', { name: 'Recusar' }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(enterOrg).not.toHaveBeenCalled();
  });
});

describe('adiar', () => {
  it('esconde o modal', async () => {
    // Quem está no meio de um torneio não pode ficar preso numa tela.
    await montar();
    await userEvent.click(screen.getByRole('button', { name: 'Decidir depois' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('o adiamento vale só para a sessão', async () => {
    // Na próxima entrada o convite reaparece: ele não pode ser esquecido
    // para sempre.
    await montar();
    await userEvent.click(screen.getByRole('button', { name: 'Decidir depois' }));
    expect(sessionStorage.getItem('orgInvites:adiado')).toBe('1');
    expect(localStorage.getItem('orgInvites:adiado')).toBeNull();
  });

  it('já adiado nesta sessão nem consulta o servidor', async () => {
    sessionStorage.setItem('orgInvites:adiado', '1');
    render(<OrgInviteModal />);
    await waitFor(() => expect(api.get).not.toHaveBeenCalled());
  });
});
