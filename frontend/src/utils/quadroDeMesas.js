/**
 * Quadro de MESAS E ASSENTOS do telão (/tv/<código>/mesas): a lista de quem
 * senta onde, em ordem alfabética, dividida em colunas e páginas que cabem
 * numa TV de 1920×1080 (o palco do telão).
 */

/** Linhas de jogador por coluna no palco de 1080 px. */
export const LINHAS_POR_COLUNA = 15;
/** Mais de 3 colunas e o nome deixa de caber. */
export const MAX_COLUNAS = 3;

/**
 * Ordem alfabética como o jogador procura o próprio nome: sem diferença de
 * maiúscula nem de acento ("Ángel" junto de "Andrés", não depois do "Z").
 */
export function ordenarAssentos(assentos, idioma = 'pt-BR') {
  const lista = Array.isArray(assentos) ? [...assentos] : [];
  let comparar;
  try {
    comparar = new Intl.Collator(idioma || 'pt-BR', { sensitivity: 'base' }).compare;
  } catch (_) {
    comparar = (a, b) => String(a).localeCompare(String(b));
  }
  return lista.sort((a, b) => (
    comparar(a.name || '', b.name || '')
    || (a.table_number || 0) - (b.table_number || 0)
    || (a.seat_number || 0) - (b.seat_number || 0)
  ));
}

/**
 * Colunas e páginas. Usa o MENOR número de colunas que põe a lista numa
 * página só (até 3): 12 jogadores = 1 coluna larga, 27 = 2 colunas. Acima de
 * 3 colunas cheias, vira páginas que o telão alterna. As colunas de cada
 * página saem equilibradas e são lidas de cima para baixo (27 em 2 colunas =
 * 14 + 13, não 15 + 12).
 *
 * Devolve { colunas, paginas }, com cada página = lista de colunas.
 */
export function paginarAssentos(assentos, linhas = LINHAS_POR_COLUNA, maxColunas = MAX_COLUNAS) {
  const lista = Array.isArray(assentos) ? assentos : [];
  const colunas = Math.min(maxColunas, Math.max(1, Math.ceil(lista.length / linhas)));
  const porPagina = linhas * colunas;
  const paginas = [];
  for (let i = 0; i < lista.length; i += porPagina) {
    const fatia = lista.slice(i, i + porPagina);
    const porColuna = Math.ceil(fatia.length / colunas);
    const cols = [];
    for (let c = 0; c < colunas; c += 1) {
      const col = fatia.slice(c * porColuna, (c + 1) * porColuna);
      if (col.length) cols.push(col);
    }
    paginas.push(cols);
  }
  return { colunas, paginas };
}
