import { formatUserAgent, parseUserAgent } from './userAgent';

const CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const EDGE_WIN = `${CHROME_WIN} Edg/128.0.0.0`;
const SAFARI_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0';
const CHROME_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36';

describe('parseUserAgent', () => {
  // Quase todo UA diz "Mozilla" e "Safari"; Edge diz "Chrome". A ordem dos
  // testes é o que separa um do outro.
  it('Chrome no Windows', () => {
    expect(parseUserAgent(CHROME_WIN)).toEqual({ browser: 'Chrome', os: 'Windows', device: 'desktop' });
  });

  it('Edge não vira Chrome', () => {
    expect(parseUserAgent(EDGE_WIN).browser).toBe('Edge');
  });

  it('Safari no iPhone é celular', () => {
    expect(parseUserAgent(SAFARI_IPHONE)).toEqual({ browser: 'Safari', os: 'iOS', device: 'mobile' });
  });

  it('Chrome no Android é celular, e Android vence Linux', () => {
    expect(parseUserAgent(CHROME_ANDROID)).toEqual({ browser: 'Chrome', os: 'Android', device: 'mobile' });
  });

  it('Firefox no Linux', () => {
    expect(parseUserAgent(FIREFOX_LINUX)).toEqual({ browser: 'Firefox', os: 'Linux', device: 'desktop' });
  });

  it('vazio não explode', () => {
    expect(parseUserAgent('')).toEqual({ browser: 'Outro', os: 'Outro', device: 'desktop' });
    expect(parseUserAgent(undefined).browser).toBe('Outro');
  });
});

describe('formatUserAgent', () => {
  it('resume em "navegador · sistema"', () => {
    expect(formatUserAgent(CHROME_WIN)).toBe('Chrome · Windows');
  });

  it('sem UA devolve vazio (evento gravado pelo banco)', () => {
    expect(formatUserAgent(null)).toBe('');
  });

  it('UA desconhecido mostra o começo cru em vez de "Outro · Outro"', () => {
    expect(formatUserAgent('curl/8.4.0')).toBe('curl/8.4.0');
  });
});
