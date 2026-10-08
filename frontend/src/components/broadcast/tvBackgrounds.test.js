/**
 * Fundo do telão: um campo (`broadcast_bg_image_url`) com quatro formas.
 * O que importa é que o valor antigo (base64) continue funcionando e que a
 * cor "padrão de alguma época" não vire um retângulo sólido por engano.
 */
import { resolveBackground, presetValue, presetName, isPresetValue, BG_PRESETS, DEFAULT_BG_CSS } from './tvBackgrounds';

describe('resolveBackground', () => {
  it('sem nada cai no gradiente marinho do app', () => {
    const r = resolveBackground(null, null);
    expect(r.kind).toBe('default');
    expect(r.style.background).toBe(DEFAULT_BG_CSS);
    expect(r.overlay).toBe(0);
  });

  it.each(['#0a0e13', '#0A0E13', '#0b1020', ' #0b0a12 '])('a cor padrão antiga %s também é "sem cor"', (cor) => {
    // Nenhum clube escolheu essas cores: eram o default gravado pelo backend.
    expect(resolveBackground('', cor).kind).toBe('default');
  });

  it('cor escolhida de verdade vira fundo sólido, sem escurecimento', () => {
    const r = resolveBackground(null, '#123456', 60);
    expect(r.kind).toBe('color');
    expect(r.style.background).toBe('#123456');
    expect(r.overlay).toBe(0);
  });

  it('preset vira gradiente pronto e ignora a cor', () => {
    const r = resolveBackground(presetValue('felt'), '#123456', 60);
    expect(r.kind).toBe('preset');
    expect(r.style.background).toBe(BG_PRESETS.felt.css);
    expect(r.overlay).toBe(0);
  });

  it('preset desconhecido não vira imagem: cai no padrão', () => {
    // "preset:xyz" como url(...) daria um retângulo preto no telão.
    expect(resolveBackground('preset:nao-existe', null).kind).toBe('default');
  });

  it('URL de imagem cobre a tela com o escurecimento pedido', () => {
    const r = resolveBackground('https://cdn/x.webp', '#123456', 30);
    expect(r.kind).toBe('image');
    expect(r.style.backgroundImage).toBe('url(https://cdn/x.webp)');
    expect(r.style.backgroundSize).toBe('cover');
    expect(r.overlay).toBe(30);
  });

  it('base64 antigo continua valendo como imagem', () => {
    expect(resolveBackground('data:image/png;base64,AAAA', null).kind).toBe('image');
  });

  it('escurecimento fora da faixa é travado em 0..90, e lixo vira 45', () => {
    expect(resolveBackground('https://cdn/x.webp', null, 500).overlay).toBe(90);
    expect(resolveBackground('https://cdn/x.webp', null, -3).overlay).toBe(0);
    expect(resolveBackground('https://cdn/x.webp', null, 'abc').overlay).toBe(45);
    expect(resolveBackground('https://cdn/x.webp', null, 0).overlay).toBe(0);
  });

  it('ajudantes de preset', () => {
    expect(isPresetValue('preset:navy')).toBe(true);
    expect(isPresetValue('https://x')).toBe(false);
    expect(presetName('preset:navy')).toBe('navy');
    expect(presetName('https://x')).toBeNull();
  });
});
