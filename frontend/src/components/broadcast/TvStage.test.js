/**
 * Palco de 1920×1080 escalado para a caixa: o mesmo layout serve 720p, 4K e
 * a prévia. A escala tem de ser a MENOR das duas razões (letterbox), e o
 * fundo cobre a caixa inteira, não só o palco.
 */
import { render, act } from '@testing-library/react';
import TvStage from './TvStage';
import { resolveBackground } from './tvBackgrounds';

const medir = (w, h) => {
  jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: w, height: h, top: 0, left: 0, right: w, bottom: h, x: 0, y: 0, toJSON: () => {},
  });
};

afterEach(() => jest.restoreAllMocks());

const escala = () => parseFloat(document.querySelector('.tv-root').style.getPropertyValue('--tv-scale'));

describe('TvStage', () => {
  it('numa TV 720p escala pela altura (a menor razão)', () => {
    medir(1280, 720);
    render(<TvStage><div>x</div></TvStage>);
    expect(escala()).toBeCloseTo(0.6667, 3);
    expect(document.querySelector('.tv-stage').style.transform).toContain('scale(0.6666');
  });

  it('numa tela mais estreita que 16:9 escala pela largura', () => {
    medir(1600, 1080);
    render(<TvStage><div>x</div></TvStage>);
    expect(escala()).toBeCloseTo(0.8333, 3);
  });

  it('4K amplia', () => {
    medir(3840, 2160);
    render(<TvStage><div>x</div></TvStage>);
    expect(escala()).toBe(2);
  });

  it('na prévia (fit=width) a escala é só pela largura', () => {
    medir(1200, 0);
    render(<TvStage fit="width"><div>x</div></TvStage>);
    expect(escala()).toBeCloseTo(0.625, 3);
    expect(document.querySelector('.tv-root')).toHaveClass('tv-root--width');
  });

  it('sem medida (jsdom) usa a janela e nunca fica em zero', () => {
    render(<TvStage><div>x</div></TvStage>);
    expect(escala()).toBeGreaterThan(0);
  });

  it('o fundo recebe o estilo resolvido e o escurecimento só com imagem', () => {
    render(<TvStage background={resolveBackground('https://cdn/x.webp', null, 40)}><div>x</div></TvStage>);
    const root = document.querySelector('.tv-root');
    expect(root).toHaveAttribute('data-bg-kind', 'image');
    expect(document.querySelector('.tv-bg').style.backgroundImage).toBe('url(https://cdn/x.webp)');
    expect(document.querySelector('.tv-bg-overlay')).toBeInTheDocument();
    expect(root.style.getPropertyValue('--tv-overlay')).toBe('0.4');
  });

  it('cor sólida não ganha camada escura', () => {
    render(<TvStage background={resolveBackground(null, '#123456', 40)}><div>x</div></TvStage>);
    expect(document.querySelector('.tv-bg-overlay')).toBeNull();
  });

  it('sem fundo informado cai no padrão', () => {
    render(<TvStage><div>x</div></TvStage>);
    expect(document.querySelector('.tv-root')).toHaveAttribute('data-bg-kind', 'default');
  });

  it('reage a resize da janela', () => {
    medir(1280, 720);
    render(<TvStage><div>x</div></TvStage>);
    medir(1920, 1080);
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(escala()).toBe(1);
  });
});
