/**
 * Os rótulos da TV NÃO passam pelo i18n do app (são poucos, em caixa alta,
 * e precisam existir ANTES de qualquer idioma ser baixado): são escolhidos
 * aqui por código de idioma. Qualquer chave faltando num idioma aparece como
 * "undefined" na tela grande, na frente do salão. Por isso o teste principal
 * aqui é de PARIDADE entre os três idiomas.
 */
import BROADCAST_LABELS, { labelsForLanguage } from './broadcastLabels';

const IDIOMAS = ['pt-BR', 'en', 'es'];

describe('labelsForLanguage', () => {
  it('só a língua importa, não a região', () => {
    expect(labelsForLanguage('es-ES')).toBe(BROADCAST_LABELS.es);
    expect(labelsForLanguage('es')).toBe(BROADCAST_LABELS.es);
    expect(labelsForLanguage('en-US')).toBe(BROADCAST_LABELS.en);
    expect(labelsForLanguage('EN')).toBe(BROADCAST_LABELS.en);
    expect(labelsForLanguage('pt-BR')).toBe(BROADCAST_LABELS['pt-BR']);
    expect(labelsForLanguage('pt_PT')).toBe(BROADCAST_LABELS['pt-BR']);
  });

  it('desconhecido ou vazio cai no português', () => {
    expect(labelsForLanguage('xx-YY')).toBe(BROADCAST_LABELS['pt-BR']);
    expect(labelsForLanguage(null)).toBe(BROADCAST_LABELS['pt-BR']);
    expect(labelsForLanguage(undefined)).toBe(BROADCAST_LABELS['pt-BR']);
  });
});

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

describe('faixa de colocações', () => {
  it('português e espanhol: "7º–9º"; inglês com ordinais', () => {
    expect(BROADCAST_LABELS['pt-BR'].placeRangeLabel(7, 9)).toBe('7º–9º Lugar');
    expect(BROADCAST_LABELS.es.placeRangeLabel(20, 35)).toBe('20º–35º Puesto');
    expect(BROADCAST_LABELS.en.placeRangeLabel(7, 9)).toBe('7th–9th Place');
    expect(BROADCAST_LABELS.en.placeRangeLabel(21, 23)).toBe('21st–23rd Place');
  });
});
