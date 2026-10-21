import { act, renderHook } from '@testing-library/react';
import { useAvisoDeEliminacao } from './useAvisoDeEliminacao';

const p = (id, status) => ({ id, player_name: `Jogador ${id}`, status });
const VIVOS = [p('a', 'active'), p('b', 'active')];

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

const montar = (ligado = true) => renderHook(
  ({ inscritos, on }) => useAvisoDeEliminacao(inscritos, on, 1000),
  { initialProps: { inscritos: VIVOS, on: ligado } },
);

it('quem cai aparece, fica o tempo do aviso e some', () => {
  const { result, rerender } = montar();
  expect(result.current).toBeNull();
  rerender({ inscritos: [p('a', 'eliminated'), p('b', 'active')], on: true });
  expect(result.current).toEqual({ id: 'a', nome: 'Jogador a' });
  act(() => { jest.advanceTimersByTime(1000); });
  expect(result.current).toBeNull();
});

it('duas quedas na mesma leitura passam uma depois da outra', () => {
  const { result, rerender } = montar();
  rerender({ inscritos: [p('a', 'eliminated'), p('b', 'eliminated')], on: true });
  expect(result.current.id).toBe('a');
  act(() => { jest.advanceTimersByTime(1000); });
  expect(result.current.id).toBe('b');
  act(() => { jest.advanceTimersByTime(1000); });
  expect(result.current).toBeNull();
});

it('desligado não mostra; ligar depois não despeja as quedas antigas', () => {
  const { result, rerender } = montar(false);
  rerender({ inscritos: [p('a', 'eliminated'), p('b', 'active')], on: false });
  expect(result.current).toBeNull();
  rerender({ inscritos: [p('a', 'eliminated'), p('b', 'active')], on: true });
  expect(result.current).toBeNull();
  rerender({ inscritos: [p('a', 'eliminated'), p('b', 'eliminated')], on: true });
  expect(result.current.id).toBe('b');
});

it('desligar no meio do aviso tira da tela na hora', () => {
  const { result, rerender } = montar();
  rerender({ inscritos: [p('a', 'eliminated'), p('b', 'active')], on: true });
  expect(result.current).not.toBeNull();
  rerender({ inscritos: [p('a', 'eliminated'), p('b', 'active')], on: false });
  expect(result.current).toBeNull();
});

it('antes de carregar (null) não há base: a primeira lista real não avisa ninguém', () => {
  const { result, rerender } = renderHook(
    ({ inscritos }) => useAvisoDeEliminacao(inscritos, true, 1000),
    { initialProps: { inscritos: null } },
  );
  rerender({ inscritos: [p('a', 'eliminated'), p('b', 'active')] });
  expect(result.current).toBeNull();
});

