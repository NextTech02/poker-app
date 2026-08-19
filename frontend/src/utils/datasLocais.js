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
