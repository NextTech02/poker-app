/**
 * Meios de entrada nos quadros POR TORNEIO (a aba "Torneios" da exportação e o
 * "Detalhamento por torneio" do Financeiro).
 *
 * O quadro só tinha as categorias fixas — Buy-ins, Rebuys, Add-ons, Taxas — e
 * o clube não via o que vendeu de cada meio que ele mesmo cadastrou: o
 * "Doble" sumia dentro de Rebuys e o "Buy-in Promoción" dentro de Buy-ins.
 * Para auditar, cada meio precisa da sua coluna, como a Taxa já tinha.
 *
 * O meio é cadastrado POR TORNEIO (cada torneio tem o seu "Buy-in", com id
 * próprio), então a coluna é a categoria com o nome, sem diferenciar
 * maiúsculas — a mesma chave que o relatório de jogadores usa no servidor
 * (`agrupar_vendas_por_meio(..., por_nome=True)`).
 *
 * A contagem é de ENTRADAS (um "Doble" que vale 2 conta 2), a mesma do
 * servidor: a soma dos meios de uma categoria fecha com a coluna dela.
 */

const ORDEM_DA_CATEGORIA = { buy_in: 0, rebuy: 1, addon: 2, fee: 3 };

const nomeLimpo = (meio) => (meio?.name || '').trim();

export const chaveDoMeio = (meio) => `${meio?.category || 'buy_in'}:${nomeLimpo(meio).toLowerCase()}`;

/**
 * As colunas de meio do período: uma por (categoria, nome), na ordem das
 * categorias e, dentro dela, na ordem em que aparecem (o servidor já manda
 * cada torneio na ordem do Caixa). `repetido` marca um nome que existe em
 * mais de uma categoria ("Doble" de entrada e de recompra): o rótulo da
 * coluna precisa dizer qual é qual.
 */
export const meiosDosTorneios = (porTorneio) => {
  const vistos = new Map();
  (porTorneio || []).forEach((torneio) => {
    (torneio?.by_buy_type || []).forEach((meio) => {
      const nome = nomeLimpo(meio);
      if (!nome) return;
      const chave = chaveDoMeio(meio);
      if (!vistos.has(chave)) {
        vistos.set(chave, { chave, nome, categoria: meio.category || 'buy_in', ordem: vistos.size });
      }
    });
  });

  const lista = Array.from(vistos.values()).sort((a, b) => (
    (ORDEM_DA_CATEGORIA[a.categoria] ?? 9) - (ORDEM_DA_CATEGORIA[b.categoria] ?? 9) || a.ordem - b.ordem
  ));

  const categoriasPorNome = new Map();
  lista.forEach((m) => {
    const nome = m.nome.toLowerCase();
    categoriasPorNome.set(nome, (categoriasPorNome.get(nome) || 0) + 1);
  });

  return lista.map(({ ordem, ...m }) => ({ ...m, repetido: categoriasPorNome.get(m.nome.toLowerCase()) > 1 }));
};

/**
 * Entradas de UM torneio por coluna de meio: `{ chave: entradas }`. Dois
 * meios do mesmo torneio com o mesmo nome (um desativado e recriado, por
 * exemplo) somam na mesma coluna.
 */
export const entradasPorMeio = (torneio) => {
  const porChave = {};
  (torneio?.by_buy_type || []).forEach((meio) => {
    if (!nomeLimpo(meio)) return;
    const chave = chaveDoMeio(meio);
    porChave[chave] = (porChave[chave] || 0) + (Number(meio.count) || 0);
  });
  return porChave;
};
