/**
 * O telão fica aberto na TV por dias e só busca dados; depois de um deploy
 * continuava com o código antigo. A decisão "há build novo?" é a parte que
 * importa: compara o manifesto publicado com o bundle carregado.
 */
import { renderHook } from '@testing-library/react';
import { buildMudou, bundleCarregado, useReloadOnNewBuild } from './useReloadOnNewBuild';

const comScript = (src) => {
  document.head.innerHTML = '';
  if (src) {
    const s = document.createElement('script');
    s.src = src;
    document.head.appendChild(s);
  }
};

const manifesto = (main, ok = true) => jest.fn().mockResolvedValue({
  ok,
  json: async () => ({ files: { 'main.js': main } }),
});

afterEach(() => { document.head.innerHTML = ''; });

describe('bundleCarregado', () => {
  it('lê o caminho do main.*.js carregado, sem a barra inicial', () => {
    comScript('http://localhost/static/js/main.abc123.js');
    expect(bundleCarregado()).toBe('static/js/main.abc123.js');
  });

  it('sem script principal (desenvolvimento) devolve nulo', () => {
    comScript(null);
    expect(bundleCarregado()).toBeNull();
  });
});

describe('buildMudou', () => {
  it('mesmo bundle no manifesto: não mudou', async () => {
    comScript('http://localhost/static/js/main.abc123.js');
    const f = manifesto('/static/js/main.abc123.js');
    expect(await buildMudou(f)).toBe(false);
    expect(f).toHaveBeenCalledWith('/asset-manifest.json', { cache: 'no-cache' });
  });

  it('bundle diferente no manifesto: há deploy novo', async () => {
    comScript('http://localhost/static/js/main.abc123.js');
    expect(await buildMudou(manifesto('/static/js/main.def456.js'))).toBe(true);
  });

  it('sem script carregado, manifesto inválido ou resposta ruim: não recarrega', async () => {
    comScript(null);
    expect(await buildMudou(manifesto('/static/js/main.def456.js'))).toBe(false);
    comScript('http://localhost/static/js/main.abc123.js');
    expect(await buildMudou(manifesto(undefined))).toBe(false);
    expect(await buildMudou(manifesto('/static/js/main.def456.js', false))).toBe(false);
  });
});

describe('useReloadOnNewBuild', () => {
  it('fora de produção não arma verificação nenhuma', () => {
    // Em desenvolvimento o bundle não tem hash: qualquer comparação daria
    // "mudou" e a tela ficaria recarregando sem parar.
    jest.useFakeTimers();
    const setInterval_ = jest.spyOn(global, 'setInterval');
    renderHook(() => useReloadOnNewBuild(true));
    expect(setInterval_).not.toHaveBeenCalled();
    setInterval_.mockRestore();
    jest.useRealTimers();
  });
});
