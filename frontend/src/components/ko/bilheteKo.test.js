/**
 * Bilhete de KO: o papel que o jogador leva ao caixa. Mesmo formato pedido
 * para o add-on — NOME / MESA E ASSENTO / KO: valor — no idioma da tela.
 */
import { htmlDoBilheteKo, imprimirBilheteKo } from './bilheteKo';

const formatar = (v) => `S/ ${Number(v).toFixed(2)}`;

it('nome, mesa e assento e o valor do KO', () => {
  const html = htmlDoBilheteKo({
    jogador: 'Ana Souza', mesa: 4, assento: 7, valor: 125, vitima: 'Beto', torneio: 'START UP PKO',
    idioma: 'pt-BR', formatarValor: formatar, quando: '2026-10-14T22:00:00Z',
  });
  expect(html).toContain('BILHETE DE KO');
  expect(html).toContain('Ana Souza');
  expect(html).toContain('MESA 4 - ASSENTO 7');
  expect(html).toContain('KO: S/ 125.00');
  expect(html).toContain('Eliminou: Beto');
  expect(html).toContain('START UP PKO');
});

it('em espanhol, e Mystery mostra MYSTERY no lugar de KO', () => {
  const html = htmlDoBilheteKo({
    jogador: 'Luis', mesa: 1, assento: 2, valor: 300, formato: 'mystery', idioma: 'es-ES', formatarValor: formatar,
  });
  expect(html).toContain('BOLETO DE KO');
  expect(html).toContain('MESA 1 - ASIENTO 2');
  expect(html).toContain('MYSTERY: S/ 300.00');
});

it('sem assento conhecido, a linha da mesa some', () => {
  const html = htmlDoBilheteKo({ jogador: 'Ana', valor: 10, idioma: 'en-US', formatarValor: formatar });
  expect(html).toContain('KO TICKET');
  expect(html).not.toContain('TABLE');
});

it('escapa o nome (vem do cadastro)', () => {
  const html = htmlDoBilheteKo({ jogador: '<b>Ana</b>', valor: 1, formatarValor: formatar });
  expect(html).toContain('&lt;b&gt;Ana&lt;/b&gt;');
  expect(html).not.toContain('<b>Ana</b>');
});

it('imprime numa janela nova; sem janela (bloqueador) devolve false', () => {
  const doc = { write: jest.fn(), close: jest.fn() };
  const abrir = jest.spyOn(window, 'open').mockReturnValue({ document: doc });
  expect(imprimirBilheteKo({ jogador: 'Ana', valor: 5 })).toBe(true);
  expect(doc.write).toHaveBeenCalledWith(expect.stringContaining('Ana'));
  abrir.mockReturnValue(null);
  expect(imprimirBilheteKo({ jogador: 'Ana', valor: 5 })).toBe(false);
  abrir.mockRestore();
});
