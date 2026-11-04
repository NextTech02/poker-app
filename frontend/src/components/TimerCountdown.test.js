/**
 * O segundo a segundo isolado do relógio. O que importa: ele repinta SOZINHO
 * a cada aviso do relógio (a página em volta não precisa), mostra o mesmo
 * formato de antes e, sem relógio, cai no valor parado do estado.
 */
import { render, screen, act } from '@testing-library/react';
import TimerCountdown from './TimerCountdown';
import { formatTimeHuman } from '../hooks/useTimerSync';

jest.mock('../config/api');

/** Relógio de mentira com a mesma interface do `clock` do useTimerSync. */
const relogio = (restante, ateIntervalo = null) => {
  const ouvintes = new Set();
  return {
    ouvintes,
    subscribe: (ouvir) => { ouvintes.add(ouvir); return () => ouvintes.delete(ouvir); },
    read: () => ({ remaining: restante, breakRemaining: ateIntervalo }),
    passar: (s) => {
      restante -= s;
      if (ateIntervalo != null) ateIntervalo -= s;
      ouvintes.forEach((ouvir) => ouvir());
    },
  };
};

const mostrado = () => screen.getByTestId('relogio').textContent;

it('repinta a cada aviso do relógio', () => {
  const clock = relogio(125);
  render(<span data-testid="relogio"><TimerCountdown clock={clock} /></span>);
  expect(mostrado()).toBe('02:05');
  act(() => clock.passar(1));
  expect(mostrado()).toBe('02:04');
});

it('kind="break" mostra o tempo até o intervalo, no formato pedido', () => {
  const clock = relogio(125, 3900);
  render(
    <span data-testid="relogio">
      <TimerCountdown clock={clock} kind="break" format={formatTimeHuman} />
    </span>
  );
  expect(mostrado()).toBe('1h 5m');
});

it('sem relógio mostra o valor do estado, parado', () => {
  render(
    <span data-testid="relogio">
      <TimerCountdown timerState={{ time_remaining_current_level: 61 }} />
    </span>
  );
  expect(mostrado()).toBe('01:01');
});

it('ao sair da tela deixa de ouvir o relógio', () => {
  const clock = relogio(10);
  const { unmount } = render(<TimerCountdown clock={clock} />);
  expect(clock.ouvintes.size).toBe(1);
  unmount();
  expect(clock.ouvintes.size).toBe(0);
});
