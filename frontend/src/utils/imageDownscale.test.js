/**
 * Redução da imagem antes do upload. O contrato que importa: NUNCA falha para
 * fora — sem canvas (jsdom, navegador velho) o arquivo original segue — e,
 * quando reduz, respeita a largura máxima e prefere WebP.
 */
import { downscaleImage, extFromFile } from './imageDownscale';

const arquivo = (nome, tipo, bytes = 10) => new File(['x'.repeat(bytes)], nome, { type: tipo });

describe('extFromFile', () => {
  it('pelo tipo MIME, com jpeg → jpg', () => {
    expect(extFromFile(arquivo('a.jpeg', 'image/jpeg'))).toBe('jpg');
    expect(extFromFile(arquivo('a', 'image/png'))).toBe('png');
    expect(extFromFile(arquivo('a', 'image/webp'))).toBe('webp');
  });
  it('sem MIME conhecido, pela extensão do nome; sem nada, jpg', () => {
    expect(extFromFile(arquivo('foto.JPEG', ''))).toBe('jpg');
    expect(extFromFile(arquivo('foto.gif', ''))).toBe('gif');
    expect(extFromFile(arquivo('foto', ''))).toBe('jpg');
    expect(extFromFile(null)).toBe('jpg');
  });
});

describe('downscaleImage', () => {
  const originalCreateElement = document.createElement.bind(document);
  let canvas;

  const canvasFalso = ({ webp = true } = {}) => {
    const ctx = { drawImage: jest.fn() };
    const c = {
      width: 0,
      height: 0,
      getContext: jest.fn(() => ctx),
      toBlob: jest.fn((cb, type) => {
        // Navegador sem WebP devolve PNG em silêncio quando se pede WebP.
        const real = type === 'image/webp' && !webp ? 'image/png' : type;
        cb(new Blob(['y'], { type: real }));
      }),
      ctx,
    };
    return c;
  };

  afterEach(() => {
    jest.restoreAllMocks();
    delete global.createImageBitmap;
  });

  it('sem decodificador nem canvas (jsdom) devolve o original intacto', async () => {
    const f = arquivo('a.png', 'image/png');
    const r = await downscaleImage(f);
    expect(r.blob).toBe(f);
    expect(r.ext).toBe('png');
    expect(r.contentType).toBe('image/png');
    expect(r.resized).toBe(false);
  });

  it('sem arquivo não estoura', async () => {
    const r = await downscaleImage(null);
    expect(r.resized).toBe(false);
  });

  it('reduz para a largura máxima mantendo a proporção, em WebP', async () => {
    const close = jest.fn();
    global.createImageBitmap = jest.fn(async () => ({ width: 4000, height: 2000, close }));
    canvas = canvasFalso();
    jest.spyOn(document, 'createElement').mockImplementation((tag) => (tag === 'canvas' ? canvas : originalCreateElement(tag)));

    const r = await downscaleImage(arquivo('foto.jpg', 'image/jpeg', 2 * 1024 * 1024));
    expect(canvas.width).toBe(1920);
    expect(canvas.height).toBe(960);
    expect(canvas.ctx.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1920, 960);
    expect(r.ext).toBe('webp');
    expect(r.contentType).toBe('image/webp');
    expect(r.resized).toBe(true);
    expect(r.width).toBe(1920);
    expect(close).toHaveBeenCalled();
  });

  it('navegador sem WebP cai em JPEG', async () => {
    global.createImageBitmap = jest.fn(async () => ({ width: 4000, height: 3000 }));
    canvas = canvasFalso({ webp: false });
    jest.spyOn(document, 'createElement').mockImplementation((tag) => (tag === 'canvas' ? canvas : originalCreateElement(tag)));

    const r = await downscaleImage(arquivo('foto.png', 'image/png', 3 * 1024 * 1024));
    expect(r.ext).toBe('jpg');
    expect(r.contentType).toBe('image/jpeg');
    expect(canvas.toBlob).toHaveBeenCalledTimes(2);
  });

  it('imagem já estreita e leve não é tocada', async () => {
    global.createImageBitmap = jest.fn(async () => ({ width: 800, height: 450 }));
    const spy = jest.spyOn(document, 'createElement');
    const f = arquivo('p.png', 'image/png', 100);
    const r = await downscaleImage(f);
    expect(r.blob).toBe(f);
    expect(spy).not.toHaveBeenCalledWith('canvas');
  });

  it('imagem estreita mas pesada é recomprimida; se não melhorar, volta o original', async () => {
    global.createImageBitmap = jest.fn(async () => ({ width: 1000, height: 500 }));
    canvas = canvasFalso();
    // o blob gerado tem 1 byte: menor que o original → vale a pena
    jest.spyOn(document, 'createElement').mockImplementation((tag) => (tag === 'canvas' ? canvas : originalCreateElement(tag)));
    const pesado = arquivo('p.png', 'image/png', 2 * 1024 * 1024);
    const r = await downscaleImage(pesado);
    expect(r.resized).toBe(true);
    expect(r.width).toBe(1000);

    // agora o canvas gera algo MAIOR que o original: devolve o original
    canvas.toBlob = jest.fn((cb, type) => cb(new Blob(['z'.repeat(50)], { type })));
    const leve = arquivo('p2.png', 'image/png', 2 * 1024 * 1024);
    Object.defineProperty(leve, 'size', { value: 10 });
    global.createImageBitmap = jest.fn(async () => ({ width: 1000, height: 500 }));
    // 10 bytes mas estreita e > 1 MB? não: size 10 ≤ 1 MB e largura ≤ max → não toca
    const r2 = await downscaleImage(leve);
    expect(r2.blob).toBe(leve);
  });

  it('decodificador que estoura devolve o original', async () => {
    global.createImageBitmap = jest.fn(async () => { throw new Error('formato'); });
    const f = arquivo('x.png', 'image/png', 5 * 1024 * 1024);
    const r = await downscaleImage(f);
    expect(r.blob).toBe(f);
    expect(r.resized).toBe(false);
  });

  it('canvas sem contexto 2D devolve o original', async () => {
    global.createImageBitmap = jest.fn(async () => ({ width: 4000, height: 2000 }));
    canvas = canvasFalso();
    canvas.getContext = jest.fn(() => null);
    jest.spyOn(document, 'createElement').mockImplementation((tag) => (tag === 'canvas' ? canvas : originalCreateElement(tag)));
    const f = arquivo('x.png', 'image/png', 5 * 1024 * 1024);
    expect((await downscaleImage(f)).blob).toBe(f);
  });
});
