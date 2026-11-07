import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const contexto = {};
contexto.globalThis = contexto;
vm.runInNewContext(readFileSync(new URL('../ferramentas/calculos.js', import.meta.url), 'utf8'), contexto);
const C = contexto.ACEBLIND_CALC;

const BASE = { jogadores: 40, stack: 20000, horas: 4, minutosNivel: 20, menorFicha: 25, bbIniciais: 100 };

function niveis(r){ return r.etapas.filter(e => e.tipo === 'nivel'); }

test('blinds sobem a cada nível, sem repetir', () => {
  const lista = niveis(C.gerarEstrutura(BASE));
  for(let i = 1; i < lista.length; i++) assert.ok(lista[i].bb > lista[i - 1].bb, `nível ${i + 1}`);
});

test('small blind é metade do big e dá para pagar com a menor ficha', () => {
  for(const menorFicha of [1, 5, 25, 100]){
    for(const n of niveis(C.gerarEstrutura({ ...BASE, menorFicha }))){
      assert.equal(n.sb * 2, n.bb);
      assert.equal(n.sb % menorFicha, 0, `sb ${n.sb} com ficha ${menorFicha}`);
    }
  }
});

test('o torneio cabe no tempo pedido, com pausas contadas', () => {
  const r = C.gerarEstrutura({ ...BASE, pausaCada: 4, pausaMinutos: 10 });
  assert.ok(r.duracaoMinutos <= 240, `${r.duracaoMinutos} min`);
  assert.ok(r.duracaoMinutos >= 200, `${r.duracaoMinutos} min`);
  assert.ok(r.etapas.some(e => e.tipo === 'pausa'));
  assert.equal(r.etapas.at(-1).tipo, 'nivel', 'não termina em pausa');
});

test('o blind final deixa o heads-up perto de 20 big blinds', () => {
  const r = C.gerarEstrutura(BASE);
  const bbNoHeadsUp = r.totalFichas / 2 / r.bbFinal;
  assert.ok(bbNoHeadsUp > 14 && bbNoHeadsUp < 28, String(bbNoHeadsUp));
});

test('stack inicial respeita o pedido quando a ficha permite', () => {
  assert.equal(C.gerarEstrutura(BASE).bbIniciaisReais, 100);
});

test('ante só entra a partir do nível pedido, no valor do big blind', () => {
  const lista = niveis(C.gerarEstrutura({ ...BASE, anteDesde: 4 }));
  assert.equal(lista[2].ante, 0);
  assert.equal(lista[3].ante, lista[3].bb);
});

test('estrutura curta ainda gera ao menos 3 níveis', () => {
  const r = C.gerarEstrutura({ ...BASE, horas: 0.5, minutosNivel: 20 });
  assert.ok(r.niveis >= 3);
});

test('premiação fecha exatamente com o prêmio', () => {
  for(const entradas of [3, 7, 18, 45, 137, 500, 1900]){
    for(const arredondar of [1, 5, 10, 50]){
      const r = C.calcularPremiacao({ entradas, buyin: 200, taxaPct: 15, arredondar });
      const soma = r.lugares.reduce((s, l) => s + l.valor, 0);
      assert.equal(Math.round(soma * 100) / 100, r.premio, `${entradas} entradas, unidade ${arredondar}`);
    }
  }
});

test('nenhum lugar paga mais que o de cima', () => {
  for(const entradas of [2, 10, 20, 30, 40, 60, 75, 120, 400]){
    for(const arredondar of [1, 10, 50, 100]){
      const { lugares } = C.calcularPremiacao({ entradas, buyin: 150, taxaPct: 10, arredondar });
      for(let i = 1; i < lugares.length; i++){
        assert.ok(lugares[i].valor <= lugares[i - 1].valor, `${entradas} entradas, unidade ${arredondar}, lugar ${i + 1}`);
      }
    }
  }
});

test('garantido soma ao prêmio dos jogadores, como no sistema', () => {
  const r = C.calcularPremiacao({ entradas: 20, buyin: 100, taxaPct: 10, garantido: 5000 });
  assert.equal(r.liquido, 1800);
  assert.equal(r.premio, 6800);
});

test('arredondamento grande tira lugar em vez de pagar zero', () => {
  const r = C.calcularPremiacao({ entradas: 10, buyin: 10, taxaPct: 0, arredondar: 50 });
  assert.ok(r.lugares.every(l => l.valor > 0));
  assert.equal(r.lugares.length, r.pagos);
});

/* A calculadora promete o mesmo resultado do sistema. No Docker a pasta frontend
   não existe, e o teste só faz sentido no repositório. */
const TABELA_DO_APP = new URL('../../frontend/src/utils/payoutStructure.js', import.meta.url);

test('mesma tabela do sistema', { skip: !existsSync(TABELA_DO_APP) }, async () => {
  const { calculatePayoutAllocations, getPaidPositions } = await import(TABELA_DO_APP);
  for(const entradas of [1, 5, 6, 17, 18, 26, 27, 36, 54, 63, 81, 99, 108, 135, 162, 198, 243, 306, 500, 1000, 1836, 2000]){
    const premio = entradas * 90;
    const nosso = C.calcularPremiacao({ entradas, buyin: 100, taxaPct: 10 });
    const doApp = calculatePayoutAllocations(entradas, premio);
    assert.equal(nosso.pagos, getPaidPositions(entradas), `${entradas} entradas: lugares pagos`);
    /* Array.from: a lista vem de outro contexto do `vm`, e o deepEqual estrito
       reprovaria só pelo protótipo, com os números iguais. */
    assert.deepEqual(Array.from(nosso.lugares, l => l.percentual), doApp.map(a => a.percentage), `${entradas} entradas: percentuais`);
    assert.deepEqual(Array.from(nosso.lugares, l => l.valor), doApp.map(a => a.prize_amount), `${entradas} entradas: valores`);
  }
});

test('tempo formatado', () => {
  assert.equal(C.formatarTempo(1205), '20:05');
  assert.equal(C.formatarTempo(59.2), '01:00');
  assert.equal(C.formatarTempo(0), '00:00');
  assert.equal(C.formatarTempo(-3), '00:00');
  assert.equal(C.formatarTempo(3900), '1:05:00');
});

test('CSV sai com BOM, ponto e vírgula e escapa aspas', () => {
  const csv = C.paraCsv([['Nível', 'SB'], ['a;b', 'c"d']]);
  assert.equal(csv, '﻿Nível;SB\r\n"a;b";"c""d"\r\n');
});
