/**
 * Extrato Geral do Financeiro: o filtro por forma de pagamento e o quadro de
 * totais que o clube usa para conferir o caixa sem somar linha a linha.
 *
 * **O filtro é pelo meio REAL.** Quase toda venda tem `payment_source =
 * 'cash'` ("pago com dinheiro do jogador") e o meio de verdade em
 * `payment_method` (dinheiro, Yape, cartão, transferência...). Filtrar
 * "Dinheiro" pela origem trazia junto o Yape e o cartão — e o total que o
 * clube conferia com as notas da gaveta saía maior do que o dinheiro que tem.
 *
 * A regra é a da gaveta (`_dinheiro_vivo` no cashbox_service): linha sem meio
 * (antiga, e os prêmios) é dinheiro, e a venda dividida entra só com a parte
 * paga no meio filtrado. Crédito de patrocinador, misto e ticket não são meio
 * de pagamento: são origens, filtradas à parte, sempre pelo valor inteiro.
 *
 * As somas são em CENTAVOS inteiros (0,1 + 0,2 não dá 0,3 em ponto flutuante).
 */
import { partesDaLinha, METODO_DIVIDIDO } from './pagamentoDividido';

export const MEIO_DINHEIRO = 'cash';

/** Origens que não são meio de pagamento: têm a sua opção própria no filtro. */
export const ORIGENS = ['credit', 'mixed', 'ticket'];

// Os valores do <select> levam o tipo na frente: um meio personalizado pode
// ter o código "credit" (slug de "Credit") e não pode virar a origem crédito.
const PREFIXO_MEIO = 'meio:';
const PREFIXO_ORIGEM = 'origem:';

export const filtroDeMeio = (codigo) => `${PREFIXO_MEIO}${codigo}`;
export const filtroDeOrigem = (codigo) => `${PREFIXO_ORIGEM}${codigo}`;

/** `{ meio }`, `{ origem }` ou `null` (todas as formas). */
export const lerFiltro = (valor) => {
  if (!valor) return null;
  if (valor.startsWith(PREFIXO_MEIO)) return { meio: valor.slice(PREFIXO_MEIO.length) };
  if (valor.startsWith(PREFIXO_ORIGEM)) return { origem: valor.slice(PREFIXO_ORIGEM.length) };
  return null;
};

const centavos = (v) => Math.round((Number(v) || 0) * 100);

/** Linha sem meio gravado é dinheiro, como na gaveta. */
const meioDaParte = (metodo) => metodo || MEIO_DINHEIRO;

/** A linha foi paga com dinheiro do jogador (e não crédito, misto ou ticket)? */
const pagaComDinheiro = (tx) => !ORIGENS.includes(tx?.payment_source);

/**
 * Quanto da linha entra no filtro, em centavos — ou `null` quando ela não
 * entra. Uma linha de valor zero (entrada por ticket) entra com 0.
 */
export const centavosNoFiltro = (tx, filtro) => {
  const total = centavos(tx?.amount);
  if (!filtro) return total;
  if (filtro.origem) return tx?.payment_source === filtro.origem ? total : null;
  if (!pagaComDinheiro(tx)) return null;
  const partes = partesDaLinha(tx).filter((p) => meioDaParte(p.payment_method) === filtro.meio);
  if (partes.length === 0) return null;
  return partes.reduce((soma, p) => soma + centavos(p.amount), 0);
};

/**
 * Os meios que o filtro oferece: dinheiro primeiro, depois os do clube na
 * ordem do cadastro, e por fim qualquer meio que apareça nas linhas e não
 * esteja (mais) cadastrado — um meio desativado continua filtrável.
 */
export const meiosDoFiltro = (meiosDoClube, linhas) => {
  const codigos = [MEIO_DINHEIRO];
  const incluir = (codigo) => {
    if (codigo && codigo !== METODO_DIVIDIDO && !codigos.includes(codigo)) codigos.push(codigo);
  };
  (meiosDoClube || []).filter((m) => m.active !== false).forEach((m) => incluir(m.code));
  const vistos = [];
  (linhas || []).filter(pagaComDinheiro).forEach((tx) => {
    partesDaLinha(tx).forEach((p) => {
      const codigo = meioDaParte(p.payment_method);
      if (!codigos.includes(codigo) && !vistos.includes(codigo)) vistos.push(codigo);
    });
  });
  vistos.sort().forEach(incluir);
  return codigos;
};

/** O tipo da linha no quadro: a taxa (add-on com `is_fee`) tem o seu. */
export const tipoDaLinha = (tx) => (tx?.type === 'addon' && tx?.is_fee ? 'fee' : tx?.type);

const ORDEM_DOS_TIPOS = ['buy_in', 'rebuy', 'addon', 'fee'];

/**
 * O quadro do extrato: o que ENTROU, por tipo (e, dentro do tipo, por meio de
 * entrada — "Buy-in" e "Buy-in Promoción"), o que SAIU em prêmio e o saldo.
 *
 * Prêmio é saída e todo o resto é entrada — o mesmo sinal que o gatilho da
 * gaveta usa (`mirror_transaction_to_cashbox`).
 *
 * `linhas` são `{ tx, centavos }` (as que passaram no filtro). `rotuloDoMeio`
 * diz o nome do subgrupo: o meio de entrada vendido, ou `null` quando não há.
 * Os valores saem em reais/soles, não em centavos.
 */
export const resumirExtrato = (linhas, rotuloDoMeio = (tx) => tx?.buy_type_name || null) => {
  const grupos = new Map();
  (linhas || []).forEach(({ tx, centavos: valor }) => {
    const tipo = tipoDaLinha(tx) || '';
    if (!grupos.has(tipo)) grupos.set(tipo, { tipo, quantidade: 0, centavos: 0, meios: new Map() });
    const grupo = grupos.get(tipo);
    grupo.quantidade += 1;
    grupo.centavos += valor;
    const nome = rotuloDoMeio(tx);
    if (!grupo.meios.has(nome)) grupo.meios.set(nome, { nome, quantidade: 0, centavos: 0 });
    const meio = grupo.meios.get(nome);
    meio.quantidade += 1;
    meio.centavos += valor;
  });

  const emReais = (grupo) => ({
    tipo: grupo.tipo,
    quantidade: grupo.quantidade,
    total: grupo.centavos / 100,
    // Um meio de entrada só (ou nenhum) não precisa de detalhe: repetiria o tipo.
    meios: grupo.meios.size < 2 ? [] : Array.from(grupo.meios.values())
      .sort((a, b) => b.centavos - a.centavos)
      .map((m) => ({ nome: m.nome, quantidade: m.quantidade, total: m.centavos / 100 })),
  });

  const posicao = (tipo) => {
    const i = ORDEM_DOS_TIPOS.indexOf(tipo);
    return i === -1 ? ORDEM_DOS_TIPOS.length : i;
  };
  const entradas = Array.from(grupos.values())
    .filter((g) => g.tipo !== 'prize')
    .sort((a, b) => posicao(a.tipo) - posicao(b.tipo) || a.tipo.localeCompare(b.tipo));
  const premio = grupos.get('prize');

  const recebido = entradas.reduce((soma, g) => soma + g.centavos, 0);
  const pago = premio ? premio.centavos : 0;
  return {
    entradas: entradas.map(emReais),
    saidas: premio ? [emReais(premio)] : [],
    quantidade: (linhas || []).length,
    recebido: recebido / 100,
    pago: pago / 100,
    saldo: (recebido - pago) / 100,
  };
};
