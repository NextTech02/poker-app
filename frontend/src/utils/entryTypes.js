/**
 * Meios de entrada do TORNEIO — as regras puras, compartilhadas pelo modal de
 * torneio (criar/editar), pelo detalhe do torneio e pelo formulário do dia.
 *
 * A lista é UMA por torneio e vale para todos os dias dele. Cada linha tem
 * nome, valor, rake e fichas próprios: "Buy-in duplo" não é buy-in × 2, e um
 * flight mais caro é um meio a mais na mesma lista, não uma lista à parte.
 */

/** Rake com que toda linha NOVA nasce. Editável; é só o ponto de partida. */
export const RAKE_PADRAO = 20;
export const FICHAS_PADRAO = 10000;

// A chave só serve ao React: uma linha nova ainda não tem id, e usar o índice
// embaralharia os inputs ao remover uma linha do meio (o texto digitado
// "pularia" de linha).
let sequenciaLinha = 0;
const proximaChave = () => `em${++sequenciaLinha}`;

const semValor = (v) => v === undefined || v === null;

// O input guarda TEXTO, não número: `parseFloat('')` é NaN, e um NaN no `value`
// de um <input type="number"> faz o React reclamar e o campo ficar impossível de
// apagar. A conversão acontece só na hora de enviar.
export const novaLinha = (dados = {}) => ({
  key: proximaChave(),
  id: dados.id ?? null,
  name: dados.name ?? '',
  category: dados.category ?? 'buy_in',
  amount: semValor(dados.amount) ? '' : String(dados.amount),
  // Linha NOVA nasce com o rake padrão da casa; linha carregada mantém o que
  // está gravado — inclusive zero, que é decisão e não ausência.
  rake_percentage: semValor(dados.rake_percentage) ? String(RAKE_PADRAO) : String(dados.rake_percentage),
  chips: semValor(dados.chips) ? String(FICHAS_PADRAO) : String(dados.chips),
  // Torneio por equipes: valor da EQUIPE inteira, dividido no "Cobrar equipe".
  per_team: !!dados.per_team,
});

export const numero = (texto) => {
  const n = parseFloat(texto);
  return Number.isFinite(n) ? n : 0;
};

export const inteiro = (texto) => {
  const n = parseInt(texto, 10);
  return Number.isFinite(n) ? n : 0;
};

// Um torneio começa com os três meios de sempre; o clube renomeia, muda valor e
// acrescenta quantos quiser. O VALOR fica em branco de propósito: é o que o
// operador precisa digitar — pré-preencher deixaria um torneio nascer cobrando
// um número que ninguém escolheu.
export const meiosPadrao = (t) => [
  novaLinha({ name: t('tournamentDayForm.defaultBuyIn', 'Buy-in'), category: 'buy_in' }),
  novaLinha({ name: t('tournamentDayForm.defaultRebuy', 'Rebuy'), category: 'rebuy' }),
  novaLinha({ name: t('tournamentDayForm.defaultAddon', 'Add-on'), category: 'addon' }),
];

/**
 * Separa o que veio do servidor: `ativos` viram linhas da tela, na ordem do
 * Caixa (sort_order); `inativos` não aparecem, mas voltam no envio — vendas
 * antigas apontam para eles e sumir com eles apagaria o rótulo do recibo.
 */
export const linhasDaApi = (vindos) => {
  const lista = Array.isArray(vindos) ? vindos : [];
  const ativos = lista
    .filter((m) => m.active !== false)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((m) => novaLinha(m));
  const inativos = lista.filter((m) => m.active === false);
  return { ativos, inativos };
};

const faltaEntrada = (t) =>
  t(
    'tournamentDayForm.entryMethodsNeedBuyIn',
    'É preciso manter ao menos um meio de entrada da categoria "Entrada" — sem ele não há como inscrever jogadores neste torneio.'
  );

/** Devolve a mensagem do problema, ou '' quando está tudo certo. */
export const validarMeios = (linhas, t) => {
  if (linhas.some((l) => !String(l.name || '').trim())) {
    return t('tournamentDayForm.entryMethodsNeedName', 'Dê um nome a cada meio de entrada.');
  }
  if (!linhas.some((l) => l.category === 'buy_in')) {
    return faltaEntrada(t);
  }
  return '';
};

/**
 * Remove uma linha, recusando deixar a lista sem nenhum meio de ENTRADA: a
 * venda de rebuy/add-on pressupõe alguém já inscrito. Melhor bloquear aqui, com
 * mensagem, do que o operador descobrir no Caixa com o clube cheio.
 */
export const removerLinha = (linhas, chave, t) => {
  const restantes = linhas.filter((l) => l.key !== chave);
  if (!restantes.some((l) => l.category === 'buy_in')) {
    return { linhas, erro: faltaEntrada(t) };
  }
  return { linhas: restantes, erro: '' };
};

export const meiosParaApi = (linhas, inativos = []) => [
  ...linhas.map((l, indice) => ({
    id: l.id,
    name: String(l.name).trim(),
    category: l.category,
    amount: numero(l.amount),
    rake_percentage: numero(l.rake_percentage),
    chips: inteiro(l.chips),
    per_team: !!l.per_team && l.category === 'buy_in',
    active: true,
    // A ordem da tela é a ordem que o Caixa mostra: o operador organiza aqui.
    sort_order: indice,
  })),
  // Os desativados voltam intocados (ver `linhasDaApi`).
  ...inativos.map((m, indice) => ({
    id: m.id,
    name: m.name,
    category: m.category,
    amount: m.amount,
    rake_percentage: m.rake_percentage,
    chips: m.chips,
    per_team: !!m.per_team,
    active: false,
    sort_order: linhas.length + indice,
  })),
];

export const primeiroDa = (linhas, categoria) =>
  linhas.find((l) => l.category === categoria) || null;

/**
 * As colunas antigas do DIA (buy_in, fichas...) continuam existindo e são lidas
 * por telas, relatórios e pela venda sem tipo. Preenchidas com o PRIMEIRO meio
 * de cada categoria, para não contarem uma história diferente da que o Caixa
 * cobra. Aceita tanto linhas da tela (texto) quanto linhas da API (número).
 *
 * Rebuy/add-on zerados viram NULO, não zero: "rebuy de R$ 0,00" diria que o
 * rebuy é de graça; nulo diz que ele não existe.
 */
export const colunasDoDia = (linhas) => {
  // O meio "por equipe" tem o preço da EQUIPE: não é o buy-in de um jogador.
  const entrada = linhas.find((l) => l.category === 'buy_in' && !l.per_team) || primeiroDa(linhas, 'buy_in');
  const recompra = primeiroDa(linhas, 'rebuy');
  const addon = primeiroDa(linhas, 'addon');
  return {
    buy_in: entrada ? numero(entrada.amount) : 0,
    starting_chips: entrada ? inteiro(entrada.chips) : 0,
    rebuy_amount: recompra && numero(recompra.amount) > 0 ? numero(recompra.amount) : null,
    rebuy_chips: recompra ? inteiro(recompra.chips) : 0,
    addon_amount: addon && numero(addon.amount) > 0 ? numero(addon.amount) : null,
    addon_chips: addon ? inteiro(addon.chips) : 0,
  };
};
