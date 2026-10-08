import { contarNivelExibido, nivelExibido } from './nivelExibido';

// Estrutura real: o intervalo ocupa uma posição (level 3), mas não é nível de jogo.
const ESTRUTURA = [
  { level: 1, small_blind: 100, big_blind: 200, is_break: false },
  { level: 2, small_blind: 200, big_blind: 400, is_break: false },
  { level: 3, small_blind: 0, big_blind: 0, is_break: true },
  { level: 4, small_blind: 300, big_blind: 600, is_break: false },
  { level: 5, small_blind: 400, big_blind: 800 },
];

describe('contarNivelExibido', () => {
  it('conta só os níveis de jogo até a posição', () => {
    expect(contarNivelExibido(ESTRUTURA, 1)).toBe(1);
    expect(contarNivelExibido(ESTRUTURA, 2)).toBe(2);
    expect(contarNivelExibido(ESTRUTURA, 4)).toBe(3); // posição 4 = nível 3
    expect(contarNivelExibido(ESTRUTURA, 5)).toBe(4);
  });

  it('no intervalo, é o número do último nível jogado', () => {
    expect(contarNivelExibido(ESTRUTURA, 3)).toBe(2);
  });

  it('sem estrutura ou sem posição não inventa número', () => {
    expect(contarNivelExibido([], 2)).toBeNull();
    expect(contarNivelExibido(null, 2)).toBeNull();
    expect(contarNivelExibido(ESTRUTURA, undefined)).toBeNull();
  });
});

describe('nivelExibido', () => {
  it('prefere o display_level que o servidor mandou', () => {
    expect(nivelExibido({ current_level: 10, display_level: 9 }, ESTRUTURA, 10)).toBe(9);
    expect(nivelExibido({ level: 4, display_level: 3 }, null, 4)).toBe(3);
  });

  it('sem display_level conta na estrutura em cache', () => {
    expect(nivelExibido({ current_level: 4 }, ESTRUTURA, 4)).toBe(3);
    expect(nivelExibido({ level: 4 }, ESTRUTURA, 4)).toBe(3);
  });

  it('sem estrutura cai na posição crua, melhor que nada', () => {
    expect(nivelExibido({ current_level: 4 }, [], 4)).toBe(4);
    expect(nivelExibido(null, null, 7)).toBe(7);
  });
});
