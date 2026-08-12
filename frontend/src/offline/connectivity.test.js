/**
 * Detecção de conectividade.
 *
 * `navigator.onLine` MENTE: ele diz "online" só por haver uma rede local. O
 * wi-fi do clube com o link caído é exatamente esse caso — e é o pior, porque
 * o app acharia que está tudo bem e as escritas falhariam uma a uma em vez de
 * irem para a fila.
 *
 * Por isso a decisão é composta: `navigator.onLine === false` é conclusivo
 * (sem rede, ponto), mas "true" só vale se o heartbeat ao backend confirmar.
 * E uma falha isolada não derruba para offline: só depois de N falhas
 * consecutivas — senão um pico de latência tiraria o operador do modo online
 * a cada requisição lenta.
 */

const carregar = () => {
  let mod;
  jest.isolateModules(() => {
    mod = require('./connectivity');
  });
  return mod;
};

const respostaOk = (ok = true) => Promise.resolve({ ok });

let navigatorOnline;

beforeEach(() => {
  jest.useFakeTimers();
  navigatorOnline = true;
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    get: () => navigatorOnline,
  });
  global.fetch = jest.fn(() => respostaOk());
});

afterEach(() => {
  jest.useRealTimers();
});

describe('sinalização vinda das requisições', () => {
  it('começa seguindo o navegador', () => {
    const c = carregar();
    expect(c.isOnline()).toBe(true);
  });

  it('uma falha isolada NÃO derruba para offline', () => {
    // Um pico de latência não pode tirar o operador do modo online a cada
    // requisição lenta.
    const c = carregar();
    c.markOffline();
    expect(c.isOnline()).toBe(true);
  });

  it('duas falhas consecutivas derrubam', () => {
    const c = carregar();
    c.markOffline();
    c.markOffline();
    expect(c.isOnline()).toBe(false);
  });

  it('um sucesso zera o contador de falhas', () => {
    const c = carregar();
    c.markOffline();
    c.markOnline();
    c.markOffline();
    expect(c.isOnline()).toBe(true);
  });

  it('voltar a ter sucesso religa', () => {
    const c = carregar();
    c.markOffline();
    c.markOffline();
    c.markOnline();
    expect(c.isOnline()).toBe(true);
  });
});

describe('assinantes', () => {
  it('são avisados na mudança', () => {
    const c = carregar();
    const ouvinte = jest.fn();
    c.subscribe(ouvinte);
    c.markOffline();
    c.markOffline();
    expect(ouvinte).toHaveBeenCalledWith(false);
  });

  it('não são avisados quando o estado não muda', () => {
    // O banner de offline piscaria a cada requisição bem-sucedida.
    const c = carregar();
    const ouvinte = jest.fn();
    c.subscribe(ouvinte);
    c.markOnline();
    expect(ouvinte).not.toHaveBeenCalled();
  });

  it('o cancelamento remove o assinante', () => {
    const c = carregar();
    const ouvinte = jest.fn();
    const cancelar = c.subscribe(ouvinte);
    cancelar();
    c.markOffline();
    c.markOffline();
    expect(ouvinte).not.toHaveBeenCalled();
  });

  it('um assinante que estoura não impede os outros', () => {
    // O banner com defeito não pode impedir o motor de sync de saber que a
    // rede voltou.
    const c = carregar();
    const bom = jest.fn();
    c.subscribe(() => {
      throw new Error('componente quebrado');
    });
    c.subscribe(bom);
    c.markOffline();
    c.markOffline();
    expect(bom).toHaveBeenCalledWith(false);
  });
});

describe('heartbeat', () => {
  it('navigator.onLine falso é conclusivo, sem nem chamar o backend', async () => {
    navigatorOnline = false;
    const c = carregar();
    await c.recheck();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(c.isOnline()).toBe(false);
  });

  it('resposta boa do /health confirma online', async () => {
    const c = carregar();
    c.markOffline();
    c.markOffline();
    await c.recheck();
    expect(c.isOnline()).toBe(true);
    expect(global.fetch.mock.calls[0][0]).toContain('/health');
  });

  it('resposta de erro do /health conta como falha', async () => {
    // Rede local sem internet: o navegador diz online, o backend não responde.
    global.fetch = jest.fn(() => respostaOk(false));
    const c = carregar();
    await c.recheck();
    await c.recheck();
    expect(c.isOnline()).toBe(false);
  });

  it('falha de fetch conta como falha', async () => {
    global.fetch = jest.fn(() => Promise.reject(new Error('sem rota')));
    const c = carregar();
    await c.recheck();
    await c.recheck();
    expect(c.isOnline()).toBe(false);
  });

  it('a checagem não fica pendurada para sempre', async () => {
    // O heartbeat roda a cada 10s; sem timeout, uma rede que engole pacotes
    // acumularia requisições sem nunca decidir nada.
    const c = carregar();
    await c.recheck();
    expect(global.fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('liga uma vez e passa a checar periodicamente', async () => {
    const c = carregar();
    c.startHeartbeat();
    expect(global.fetch).toHaveBeenCalledTimes(1); // checagem imediata
    jest.advanceTimersByTime(10000);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    c.stopHeartbeat();
  });

  it('ligar duas vezes não duplica o intervalo', async () => {
    const c = carregar();
    c.startHeartbeat();
    c.startHeartbeat();
    global.fetch.mockClear();
    jest.advanceTimersByTime(10000);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    c.stopHeartbeat();
  });

  it('parar interrompe as checagens', async () => {
    const c = carregar();
    c.startHeartbeat();
    c.stopHeartbeat();
    global.fetch.mockClear();
    jest.advanceTimersByTime(30000);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('o evento offline do navegador derruba na hora', () => {
    // Não espera o próximo heartbeat: o operador precisa ver o banner
    // imediatamente para saber que está trabalhando na fila.
    const c = carregar();
    c.startHeartbeat();
    navigatorOnline = false;
    window.dispatchEvent(new Event('offline'));
    expect(c.isOnline()).toBe(false);
    c.stopHeartbeat();
  });

  it('o evento online do navegador dispara uma re-checagem', () => {
    const c = carregar();
    c.startHeartbeat();
    global.fetch.mockClear();
    window.dispatchEvent(new Event('online'));
    expect(global.fetch).toHaveBeenCalled();
    c.stopHeartbeat();
  });
});
