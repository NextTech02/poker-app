/**
 * Polling que pausa com a aba oculta.
 *
 * Operadores deixam telas abertas o dia inteiro — o controle do torneio, a
 * TV, o caixa. Sem a pausa, cada aba martela a API a cada poucos segundos em
 * segundo plano, e a soma disso foi uma das maiores fontes de carga em
 * produção.
 *
 * Voltar a ficar visível dispara um refresh IMEDIATO: esperar o próximo
 * intervalo deixaria o operador olhando para dados velhos justamente no
 * instante em que voltou para a tela.
 */
import { renderHook, act } from '@testing-library/react';
import { usePolling } from './usePolling';

let oculta;

const definirVisibilidade = (valor) => {
  oculta = valor;
  document.dispatchEvent(new Event('visibilitychange'));
};

beforeEach(() => {
  jest.useFakeTimers();
  oculta = false;
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => oculta,
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('intervalo', () => {
  it('chama a cada intervalo', () => {
    const fn = jest.fn();
    renderHook(() => usePolling(fn, 1000));
    act(() => jest.advanceTimersByTime(3000));
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('não chama imediatamente ao montar', () => {
    // A tela já carregou os dados na montagem; uma chamada extra aqui
    // dobraria a carga inicial de cada tela.
    const fn = jest.fn();
    renderHook(() => usePolling(fn, 1000));
    expect(fn).not.toHaveBeenCalled();
  });

  it('intervalo falsy desliga o polling', () => {
    // É assim que as telas param de consultar quando não há dia ativo.
    const fn = jest.fn();
    renderHook(() => usePolling(fn, 0));
    act(() => jest.advanceTimersByTime(10000));
    expect(fn).not.toHaveBeenCalled();
  });

  it('intervalo nulo desliga o polling', () => {
    const fn = jest.fn();
    renderHook(() => usePolling(fn, null));
    act(() => jest.advanceTimersByTime(10000));
    expect(fn).not.toHaveBeenCalled();
  });

  it('parar de consultar ao desmontar', () => {
    // Um intervalo sobrevivente continuaria chamando `setState` num
    // componente que já saiu da tela.
    const fn = jest.fn();
    const { unmount } = renderHook(() => usePolling(fn, 1000));
    unmount();
    act(() => jest.advanceTimersByTime(5000));
    expect(fn).not.toHaveBeenCalled();
  });

  it('mudar o intervalo recria o ciclo', () => {
    const fn = jest.fn();
    const { rerender } = renderHook(({ ms }) => usePolling(fn, ms), {
      initialProps: { ms: 1000 },
    });
    act(() => jest.advanceTimersByTime(1000));
    expect(fn).toHaveBeenCalledTimes(1);

    rerender({ ms: 5000 });
    act(() => jest.advanceTimersByTime(1000));
    expect(fn).toHaveBeenCalledTimes(1); // o ciclo antigo não sobreviveu
    act(() => jest.advanceTimersByTime(4000));
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('callback sempre atual', () => {
  it('usa a última função recebida, sem reiniciar o ciclo', () => {
    // O callback fecha sobre estado da tela e muda a cada render. Recriar o
    // intervalo a cada mudança reiniciaria a contagem e o polling nunca
    // dispararia numa tela que renderiza com frequência.
    const antiga = jest.fn();
    const nova = jest.fn();
    const { rerender } = renderHook(({ fn }) => usePolling(fn, 1000), {
      initialProps: { fn: antiga },
    });
    rerender({ fn: nova });
    act(() => jest.advanceTimersByTime(1000));
    expect(antiga).not.toHaveBeenCalled();
    expect(nova).toHaveBeenCalledTimes(1);
  });
});

describe('aba oculta', () => {
  it('não consulta enquanto a aba está escondida', () => {
    const fn = jest.fn();
    renderHook(() => usePolling(fn, 1000));
    act(() => definirVisibilidade(true));
    act(() => jest.advanceTimersByTime(5000));
    expect(fn).not.toHaveBeenCalled();
  });

  it('voltar a ficar visível atualiza na hora', () => {
    // Esperar o próximo intervalo deixaria o operador olhando para dados
    // velhos justamente ao voltar para a tela.
    const fn = jest.fn();
    renderHook(() => usePolling(fn, 5000));
    act(() => definirVisibilidade(true));
    act(() => definirVisibilidade(false));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('o ciclo volta a rodar depois de reaparecer', () => {
    const fn = jest.fn();
    renderHook(() => usePolling(fn, 1000));
    act(() => definirVisibilidade(true));
    act(() => jest.advanceTimersByTime(3000));
    act(() => definirVisibilidade(false)); // 1 refresh imediato
    act(() => jest.advanceTimersByTime(2000)); // + 2 do ciclo
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('esconder mais de uma vez não acumula ciclos', () => {
    // Dois intervalos rodando dobrariam a carga da tela em segundo plano.
    const fn = jest.fn();
    renderHook(() => usePolling(fn, 1000));
    act(() => definirVisibilidade(false));
    act(() => definirVisibilidade(false));
    act(() => jest.advanceTimersByTime(1000));
    expect(fn).toHaveBeenCalledTimes(3); // 2 refreshes imediatos + 1 do ciclo
  });

  it('para de ouvir a visibilidade ao desmontar', () => {
    const fn = jest.fn();
    const { unmount } = renderHook(() => usePolling(fn, 1000));
    unmount();
    act(() => definirVisibilidade(false));
    expect(fn).not.toHaveBeenCalled();
  });
});
