import { nomeDoPais, paisesNoIdioma } from './paises';
import { dataPorExtenso } from './datasLocais';

it('mostra o país no idioma da tela e mantém o valor em português', () => {
  expect(nomeDoPais('Alemanha', 'es-ES')).toBe('Alemania');
  expect(nomeDoPais('Alemanha', 'en-US')).toBe('Germany');
  expect(nomeDoPais('Alemanha', 'pt-BR')).toBe('Alemanha');
  expect(nomeDoPais('País Inventado', 'es-ES')).toBe('País Inventado');
  expect(nomeDoPais('', 'es-ES')).toBe('');

  const peru = paisesNoIdioma('en-US').find((p) => p.valor === 'Peru');
  expect(peru.rotulo).toBe('Peru');
});

it('quase todos os países da lista têm nome em espanhol', () => {
  const lista = paisesNoIdioma('es-ES');
  expect(lista.find((p) => p.valor === 'Alemanha').rotulo).toBe('Alemania');
  expect(lista.map((p) => p.rotulo)).toEqual([...lista.map((p) => p.rotulo)].sort((a, b) => a.localeCompare(b, 'es-ES')));
});

it('a data do clube sai no idioma e no dia certo', () => {
  expect(dataPorExtenso('2026-11-23', 'pt-BR')).toBe('23/11/2026');
  expect(dataPorExtenso('2026-11-23', 'en-US')).toBe('11/23/2026');
  expect(dataPorExtenso(null, 'pt-BR')).toBe('');
  expect(dataPorExtenso('rascunho', 'pt-BR')).toBe('rascunho');
});
