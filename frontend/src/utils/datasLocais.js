/**
 * Datas do calendário do CLUBE, não do meridiano de Greenwich.
 *
 * Por que este arquivo existe: o padrão `new Date().toISOString().split('T')[0]`
 * parece devolver "hoje", mas devolve o dia em UTC. Num clube brasileiro
 * (UTC-3), das 21h em diante isso já é o dia seguinte — e o clube trabalha
 * exatamente nesse horário.
 *
 * O estrago era silencioso e caía em cima de dinheiro: o período padrão do DRE
 * e dos Relatórios saía de `new Date().setDate(1)`, que fixa o dia 1 mantendo a
 * HORA atual; convertido para UTC às 21h, virava dia 02. Ou seja, toda noite
 * depois das 21h o faturamento do PRIMEIRO DIA DO MÊS sumia do relatório, e o
 * fim do período apontava para amanhã. Ninguém vê um número que não aparece.
 *
 * As funções abaixo montam a data a partir dos componentes LOCAIS, sem passar
 * por UTC em momento nenhum.
 */

/** Data (YYYY-MM-DD) de `d` no fuso de quem está olhando a tela. */
export function dataLocalISO(d = new Date()) {
  const ano = d.getFullYear();
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}

/** Primeiro dia do mês corrente — sempre termina em -01, a qualquer hora. */
export function primeiroDiaDoMes(d = new Date()) {
  const ano = d.getFullYear();
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  return `${ano}-${mes}-01`;
}

/** Hoje, no calendário local. */
export function hojeLocal() {
  return dataLocalISO();
}

/** `n` dias atrás, no calendário local (n = 0 é hoje). */
export function diasAtras(n, d = new Date()) {
  const copia = new Date(d.getFullYear(), d.getMonth(), d.getDate() - n);
  return dataLocalISO(copia);
}

/**
 * Limite dos campos de data. Sem `max` o navegador aceita ano de até 6 dígitos:
 * "12026-01-01" saía da digitação e derrubava a consulta no banco.
 */
export const DATA_MAXIMA = '9999-12-31';

/**
 * "AAAA-MM-DD" (como o banco guarda um dia do clube) escrito no idioma da tela.
 * Montado com os componentes LOCAIS: `new Date('2026-11-23')` é meia-noite UTC
 * e cairia no dia anterior na América Latina.
 */
export function dataPorExtenso(iso, idioma = 'pt-BR') {
  const [ano, mes, dia] = String(iso || '').slice(0, 10).split('-').map(Number);
  if (!ano || !mes || !dia) return iso || '';
  return new Date(ano, mes - 1, dia).toLocaleDateString(idioma, { day: '2-digit', month: '2-digit', year: 'numeric' });
}
