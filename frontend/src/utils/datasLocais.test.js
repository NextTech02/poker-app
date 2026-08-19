/**
 * O bug que estes testes travam: às 21h de um clube brasileiro (UTC-3),
 * `new Date().setDate(1).toISOString()` devolvia o dia 02, e o faturamento do
 * primeiro dia do mês sumia do DRE e dos Relatórios. Como o clube trabalha à
 * noite, o relatório errado era o único que alguém via.
 */
import { dataLocalISO, primeiroDiaDoMes, hojeLocal } from './datasLocais';

describe('datas no calendário do clube, não em UTC', () => {
  test('o primeiro dia do mês termina em -01 mesmo às 21h', () => {
    // 18/08/2026 21:12 local — o horário exato em que o defeito aparecia.
    const noite = new Date(2026, 7, 18, 21, 12, 40);
    expect(primeiroDiaDoMes(noite)).toBe('2026-08-01');
  });

  test('às 23h59 do último dia do mês, hoje ainda é hoje', () => {
    const virada = new Date(2026, 7, 31, 23, 59, 59);
    expect(dataLocalISO(virada)).toBe('2026-08-31');
  });

  test('meia-noite em ponto não volta para o dia anterior', () => {
    const zero = new Date(2026, 7, 1, 0, 0, 0);
    expect(dataLocalISO(zero)).toBe('2026-08-01');
    expect(primeiroDiaDoMes(zero)).toBe('2026-08-01');
  });

  test('mês e dia de um dígito saem com zero à esquerda', () => {
    expect(dataLocalISO(new Date(2026, 0, 5, 12, 0, 0))).toBe('2026-01-05');
    expect(primeiroDiaDoMes(new Date(2026, 0, 5, 12, 0, 0))).toBe('2026-01-01');
  });

  test('hojeLocal concorda com dataLocalISO', () => {
    expect(hojeLocal()).toBe(dataLocalISO(new Date()));
  });

  test('o formato é sempre YYYY-MM-DD', () => {
    expect(hojeLocal()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(primeiroDiaDoMes()).toMatch(/^\d{4}-\d{2}-01$/);
  });
});
