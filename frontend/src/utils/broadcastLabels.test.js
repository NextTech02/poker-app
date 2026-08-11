/**
 * Os rótulos da TV NÃO passam pelo i18n do app. O idioma da transmissão é
 * escolhido por DIA (um clube em Medellín pode operar em português e exibir
 * em espanhol para o salão), então ele não pode seguir o idioma de quem está
 * logado no computador do caixa.
 *
 * Consequência: qualquer chave faltando num idioma aparece como "undefined"
 * na tela grande, na frente do salão. Por isso o teste principal aqui é de
 * PARIDADE entre os três idiomas.
 */
import BROADCAST_LABELS from './broadcastLabels';

const IDIOMAS = ['pt-BR', 'en', 'es'];

describe('paridade entre idiomas', () => {
  it('os três idiomas existem', () => {
    expect(Object.keys(BROADCAST_LABELS).sort()).toEqual([...IDIOMAS].sort());
  });

  it('todos têm exatamente as mesmas chaves', () => {
    const referencia = Object.keys(BROADCAST_LABELS['pt-BR']).sort();
    IDIOMAS.forEach((idioma) => {
      expect(Object.keys(BROADCAST_LABELS[idioma]).sort()).toEqual(referencia);
    });
  });

  it('nenhum rótulo de texto está vazio', () => {
    IDIOMAS.forEach((idioma) => {
      Object.entries(BROADCAST_LABELS[idioma]).forEach(([chave, valor]) => {
        if (typeof valor === 'string') {
          expect(valor.trim()).not.toBe('');
        }
      });
    });
  });
});

describe('colocação', () => {
  it('português usa a forma ordinal com º', () => {
    expect(BROADCAST_LABELS['pt-BR'].placeLabel(1)).toBe('1º Lugar');
    expect(BROADCAST_LABELS['pt-BR'].placeLabel(11)).toBe('11º Lugar');
  });

  it('espanhol usa "Puesto"', () => {
    expect(BROADCAST_LABELS.es.placeLabel(3)).toBe('3º Puesto');
  });

  it.each([
    [1, '1st Place'],
    [2, '2nd Place'],
    [3, '3rd Place'],
    [4, '4th Place'],
  ])('inglês: %i → %s', (posicao, esperado) => {
    expect(BROADCAST_LABELS.en.placeLabel(posicao)).toBe(esperado);
  });

  it.each([11, 12, 13])(
    'inglês: %i é "th", não "st/nd/rd" (a exceção da casa das dezenas)',
    (posicao) => {
      expect(BROADCAST_LABELS.en.placeLabel(posicao)).toBe(`${posicao}th Place`);
    }
  );

  it.each([
    [21, '21st Place'],
    [22, '22nd Place'],
    [23, '23rd Place'],
    [101, '101st Place'],
    [111, '111th Place'],
  ])('inglês: %i → %s', (posicao, esperado) => {
    expect(BROADCAST_LABELS.en.placeLabel(posicao)).toBe(esperado);
  });
});
