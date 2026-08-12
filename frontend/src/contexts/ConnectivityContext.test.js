/**
 * Estado de conectividade exposto à interface.
 *
 * A fonte da verdade é o singleton `offline/connectivity` (heartbeat ao
 * backend), não este contexto — ele só traduz para React e acrescenta a
 * contagem de pendências.
 *
 * A contagem é atualizada por EVENTO, não por polling: a fila dispara
 * `OFFLINE_QUEUE_EVENT` quando muda. Um `setInterval` faria o operador ver o
 * número desatualizado por alguns segundos justamente depois de registrar
 * alguém — o momento em que ele mais precisa da confirmação de que a
 * operação foi guardada.
 */
import { render, screen, act, waitFor } from '@testing-library/react';
import {
  ConnectivityProvider,
  useConnectivity,
  OFFLINE_QUEUE_EVENT,
} from './ConnectivityContext';
import {
  isOnline,
  subscribe,
  startHeartbeat,
  recheck,
} from '../offline/connectivity';
import { getPendingCount, getConflicts } from '../offline/db';
import { startSyncEngine } from '../offline/syncEngine';

jest.mock('../offline/connectivity', () => ({
  isOnline: jest.fn(),
  subscribe: jest.fn(),
  startHeartbeat: jest.fn(),
  recheck: jest.fn(),
  OFFLINE_QUEUE_EVENT: 'offline-queue-changed',
}));
jest.mock('../offline/db', () => ({
  getPendingCount: jest.fn(),
  getConflicts: jest.fn(),
}));
jest.mock('../offline/syncEngine', () => ({ startSyncEngine: jest.fn() }));

let ctx;
let avisarMudanca;
let cancelar;

function Sonda() {
  ctx = useConnectivity();
  return (
    <div>
      <span data-testid="online">{String(ctx.isOnline)}</span>
      <span data-testid="pendentes">{ctx.pendingCount}</span>
      <span data-testid="conflitos">{ctx.conflictCount}</span>
    </div>
  );
}

const montar = async () => {
  render(<ConnectivityProvider><Sonda /></ConnectivityProvider>);
  await waitFor(() => expect(ctx).toBeTruthy());
};

beforeEach(() => {
  cancelar = jest.fn();
  isOnline.mockReturnValue(true);
  getPendingCount.mockResolvedValue(0);
  getConflicts.mockResolvedValue([]);
  subscribe.mockImplementation((fn) => {
    avisarMudanca = fn;
    return cancelar;
  });
});

describe('inicialização', () => {
  it('liga o heartbeat e o motor de sync', async () => {
    // Sem isso, a fila de uma sessão anterior nunca subiria.
    await montar();
    expect(startHeartbeat).toHaveBeenCalled();
    expect(startSyncEngine).toHaveBeenCalled();
  });

  it('parte do estado atual do singleton', async () => {
    isOnline.mockReturnValue(false);
    await montar();
    expect(screen.getByTestId('online')).toHaveTextContent('false');
  });

  it('lê as pendências ao montar', async () => {
    // Sessão anterior pode ter deixado operações na fila.
    getPendingCount.mockResolvedValue(3);
    getConflicts.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }]);
    await montar();
    await waitFor(() => expect(screen.getByTestId('pendentes')).toHaveTextContent('3'));
    expect(screen.getByTestId('conflitos')).toHaveTextContent('2');
  });

  it('IndexedDB indisponível não derruba a aplicação', async () => {
    // Navegador em modo privado: a contagem some, o app continua de pé.
    getPendingCount.mockRejectedValue(new Error('indisponível'));
    await montar();
    expect(screen.getByTestId('pendentes')).toHaveTextContent('0');
  });

  it('cancela a assinatura ao desmontar', async () => {
    const { unmount } = render(<ConnectivityProvider><Sonda /></ConnectivityProvider>);
    await waitFor(() => expect(subscribe).toHaveBeenCalled());
    unmount();
    expect(cancelar).toHaveBeenCalled();
  });
});

describe('mudança de conectividade', () => {
  it('cair reflete na interface', async () => {
    await montar();
    act(() => avisarMudanca(false));
    expect(screen.getByTestId('online')).toHaveTextContent('false');
  });

  it('voltar registra o instante da reconexão', async () => {
    // É o que a tela usa para mostrar "sincronizado há X".
    isOnline.mockReturnValue(false);
    await montar();
    act(() => avisarMudanca(true));
    expect(screen.getByTestId('online')).toHaveTextContent('true');
    expect(ctx.lastSyncAt).toBeGreaterThan(0);
  });

  it('cair NÃO registra instante de sincronização', async () => {
    await montar();
    act(() => avisarMudanca(false));
    expect(ctx.lastSyncAt).toBeNull();
  });
});

describe('contagem de pendências', () => {
  it('o evento da fila atualiza o número', async () => {
    // Por evento, não por polling: o operador precisa ver na hora que a
    // operação foi guardada.
    await montar();
    getPendingCount.mockResolvedValue(5);
    await act(async () => {
      window.dispatchEvent(new Event(OFFLINE_QUEUE_EVENT));
    });
    await waitFor(() => expect(screen.getByTestId('pendentes')).toHaveTextContent('5'));
  });

  it('deixa de ouvir o evento depois de desmontar', async () => {
    const { unmount } = render(<ConnectivityProvider><Sonda /></ConnectivityProvider>);
    await waitFor(() => expect(getPendingCount).toHaveBeenCalled());
    unmount();
    getPendingCount.mockClear();
    window.dispatchEvent(new Event(OFFLINE_QUEUE_EVENT));
    expect(getPendingCount).not.toHaveBeenCalled();
  });
});

describe('re-checagem manual', () => {
  it('é repassada do singleton', async () => {
    // Usada ao voltar o foco da aba e depois do re-login, para não esperar
    // o próximo heartbeat.
    await montar();
    ctx.recheck();
    expect(recheck).toHaveBeenCalled();
  });
});
