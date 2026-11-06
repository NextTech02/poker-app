import { useEffect, useReducer } from 'react';
import { formatTime } from '../hooks/useTimerSync';

/**
 * O segundo a segundo do relógio, isolado: só ESTE nó re-renderiza a cada
 * segundo, não a página em volta. Par do `useTimerSync(..., { ticking: false })`
 * — sem ele, a tela de Blinds redesenhava a tabela inteira todo segundo.
 *
 * `timerState` é o do hook (vale antes da primeira resposta do servidor);
 * `kind="break"` mostra quanto falta para o próximo intervalo. Sem `clock`,
 * mostra o valor do próprio estado, parado — o comportamento de antes.
 */
const lerSemRelogio = (timerState) => ({
  remaining: timerState?.time_remaining_current_level ?? 0,
  breakRemaining: timerState?.next_break?.time_until_break ?? null,
});

const TimerCountdown = ({ clock, timerState, kind = 'level', format = formatTime }) => {
  const [, repaint] = useReducer((n) => n + 1, 0);
  useEffect(() => (clock ? clock.subscribe(repaint) : undefined), [clock]);
  const { remaining, breakRemaining } = clock ? clock.read(timerState) : lerSemRelogio(timerState);
  return format(kind === 'break' ? breakRemaining : remaining);
};

export default TimerCountdown;
