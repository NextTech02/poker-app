/**
 * Permissões da interface.
 *
 * Este contexto é **UX, não segurança**. O backend valida as mesmas
 * permissões em toda rota — esconder um botão só evita que o operador clique
 * em algo que vai levar 403. Por isso o fallback aqui é permissivo: se o
 * endpoint falhar de vez, a interface libera as telas e deixa o servidor
 * recusar o que precisa ser recusado. O contrário (esconder tudo) deixaria o
 * clube sem sistema por causa de uma falha de leitura.
 *
 * `isPlatformAdmin` é a exceção: começa em `false` e só liga com resposta
 * explícita. Ele controla a tela de cadastro de CLIENTES — mostrá-la por
 * engano seria expor a existência dos outros clubes.
 */
import { render, screen, act, waitFor } from '@testing-library/react';
import { PermissionProvider, usePermissions } from './PermissionContext';
import { useAuth } from './AuthContext';
import api from '../config/api';

jest.mock('./AuthContext', () => ({ useAuth: jest.fn() }));
jest.mock('../config/api', () => ({ __esModule: true, default: { get: jest.fn() } }));

let ctx;

function Sonda() {
  ctx = usePermissions();
  return (
    <div>
      <span data-testid="admin">{String(ctx.isAdmin)}</span>
      <span data-testid="plataforma">{String(ctx.isPlatformAdmin)}</span>
      <span data-testid="loading">{String(ctx.loading)}</span>
      <span data-testid="perms">{ctx.permissions.join(',')}</span>
    </div>
  );
}

const montar = async () => {
  render(<PermissionProvider><Sonda /></PermissionProvider>);
  await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
};

const resposta = (dados) => ({ data: dados });

beforeEach(() => {
  useAuth.mockReturnValue({ user: { id: 'u1' } });
  api.get.mockResolvedValue(
    resposta({ permissions: [], is_admin: true, is_platform_admin: false, group_name: null })
  );
});

describe('sem usuário logado', () => {
  it('não consulta o servidor', async () => {
    useAuth.mockReturnValue({ user: null });
    await montar();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('não é admin da plataforma', async () => {
    useAuth.mockReturnValue({ user: null });
    await montar();
    expect(screen.getByTestId('plataforma')).toHaveTextContent('false');
  });
});

describe('permissões carregadas', () => {
  it('operador comum recebe só o próprio grupo', async () => {
    api.get.mockResolvedValue(
      resposta({
        permissions: ['cashier', 'players'],
        is_admin: false,
        is_platform_admin: false,
        group_name: 'Caixa',
      })
    );
    await montar();
    expect(screen.getByTestId('admin')).toHaveTextContent('false');
    expect(screen.getByTestId('perms')).toHaveTextContent('cashier,players');
    expect(ctx.groupName).toBe('Caixa');
  });

  it('admin passa por qualquer permissão', async () => {
    await montar();
    expect(ctx.hasPermission('financial')).toBe(true);
    expect(ctx.hasPermission('qualquer-coisa')).toBe(true);
  });

  it('operador só passa nas permissões que tem', async () => {
    api.get.mockResolvedValue(
      resposta({ permissions: ['cashier'], is_admin: false, is_platform_admin: false })
    );
    await montar();
    expect(ctx.hasPermission('cashier')).toBe(true);
    expect(ctx.hasPermission('financial')).toBe(false);
  });

  it('tela sem permissão exigida é liberada', async () => {
    // Telas comuns (dashboard, perfil) não declaram permissão.
    api.get.mockResolvedValue(
      resposta({ permissions: [], is_admin: false, is_platform_admin: false })
    );
    await montar();
    expect(ctx.hasPermission(null)).toBe(true);
    expect(ctx.hasPermission(undefined)).toBe(true);
  });

  it('resposta sem lista de permissões vira lista vazia', async () => {
    api.get.mockResolvedValue(resposta({ is_admin: false, is_platform_admin: false }));
    await montar();
    expect(ctx.permissions).toEqual([]);
  });

  it('admin da plataforma exige o valor booleano exato', async () => {
    // O claim é assinado pelo servidor; um "true" em texto seria dado
    // inesperado e não pode abrir a tela de cadastro de clientes.
    api.get.mockResolvedValue(
      resposta({ permissions: [], is_admin: false, is_platform_admin: 'true' })
    );
    await montar();
    expect(screen.getByTestId('plataforma')).toHaveTextContent('false');
  });

  it('admin da plataforma reconhecido', async () => {
    api.get.mockResolvedValue(
      resposta({ permissions: [], is_admin: true, is_platform_admin: true })
    );
    await montar();
    expect(screen.getByTestId('plataforma')).toHaveTextContent('true');
  });
});

describe('falhas ao carregar', () => {
  it('erro de servidor é retentado uma vez', async () => {
    // 503 durante um deploy não pode travar a interface do clube.
    jest.useFakeTimers();
    api.get
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockResolvedValueOnce(
        resposta({ permissions: ['cashier'], is_admin: false, is_platform_admin: false })
      );
    render(<PermissionProvider><Sonda /></PermissionProvider>);
    // deixa a PRIMEIRA rejeicao resolver antes de adiantar o relogio; senao o
    // setTimeout do retry ainda nem foi agendado.
    await act(async () => {});
    await act(async () => {
      jest.advanceTimersByTime(3000);
    });
    await waitFor(() => expect(screen.getByTestId('perms')).toHaveTextContent('cashier'));
    expect(api.get).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it('erro de rede também é retentado', async () => {
    jest.useFakeTimers();
    api.get
      .mockRejectedValueOnce(new Error('Network Error'))
      .mockResolvedValueOnce(
        resposta({ permissions: [], is_admin: true, is_platform_admin: false })
      );
    render(<PermissionProvider><Sonda /></PermissionProvider>);
    // deixa a PRIMEIRA rejeicao resolver antes de adiantar o relogio; senao o
    // setTimeout do retry ainda nem foi agendado.
    await act(async () => {});
    await act(async () => {
      jest.advanceTimersByTime(3000);
    });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    jest.useRealTimers();
  });

  it('erro do cliente NÃO é retentado', async () => {
    // 403 não melhora tentando de novo; insistir só atrasaria a tela.
    api.get.mockRejectedValue({ response: { status: 403 } });
    await montar();
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('falha definitiva libera a interface e deixa o servidor recusar', async () => {
    // Esconder tudo deixaria o clube sem sistema por causa de uma leitura;
    // o backend valida as mesmas permissões em toda rota.
    api.get.mockRejectedValue({ response: { status: 403 } });
    await montar();
    expect(screen.getByTestId('admin')).toHaveTextContent('true');
    expect(ctx.hasPermission('financial')).toBe(true);
  });

  it('falha definitiva NÃO liga o admin da plataforma', async () => {
    // Ele controla a tela de cadastro de clientes: ligar por engano exporia
    // a existência dos outros clubes.
    api.get.mockRejectedValue({ response: { status: 500 } });
    jest.useFakeTimers();
    render(<PermissionProvider><Sonda /></PermissionProvider>);
    // deixa a PRIMEIRA rejeicao resolver antes de adiantar o relogio; senao o
    // setTimeout do retry ainda nem foi agendado.
    await act(async () => {});
    await act(async () => {
      jest.advanceTimersByTime(3000);
    });
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(screen.getByTestId('plataforma')).toHaveTextContent('false');
    jest.useRealTimers();
  });
});
