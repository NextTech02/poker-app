/**
 * Meios de entrada do PERÍODO (vários torneios) nos relatórios: a lista "Por
 * meio de entrada" e as colunas por meio do relatório de jogadores.
 *
 * O meio é cadastrado por torneio, e cada torneio tem o seu "Buy-in". Um
 * servidor que agrupa pelo id manda um "Buy-in" por torneio — no PDF do NSOP
 * (10/11) eram 15 linhas "Buy-in" e 15 colunas iguais no quadro de
 * jogadores, que espremeram a página até quebrar o cabeçalho letra por letra.
 * O servidor atual já agrupa por nome, mas o cliente agrupa de novo: o
 * relatório não pode depender da versão do servidor.
 *
 * Os jogadores trazem `by_buy_type` pelo nome EXATO de cada venda ("Bono
 * Dealer" e "BONO DEALER" separados), enquanto a lista do período junta os
 * dois. A coluna do jogador é, então, o nome sem diferenciar maiúsculas.
 */

const chaveDoNome = (nome) => (nome || '').trim().toLowerCase();

const ORDEM_DA_CATEGORIA = { buy_in: 0, rebuy: 1, addon: 2, fee: 3 };

/**
 * A lista "Por meio de entrada" com uma linha por (categoria, nome), na
 * ordem das categorias (Buy-in → Rebuy → Add-on → Taxa) e, dentro dela, na
 * ordem em que o servidor mandou.
 */
export const agruparMeiosDoPeriodo = (porMeio) => {
  const grupos = new Map();
  (porMeio || []).forEach((meio) => {
    const nome = (meio?.name || '').trim();
    if (!nome) return;
    const chave = `${meio.category || 'buy_in'}:${chaveDoNome(nome)}`;
    const grupo = grupos.get(chave);
    if (grupo) {
      grupo.count += Number(meio.count) || 0;
      grupo.amount = Math.round((grupo.amount + (Number(meio.amount) || 0)) * 100) / 100;
    } else {
      grupos.set(chave, {
        ...meio, name: nome, count: Number(meio.count) || 0, amount: Number(meio.amount) || 0,
      });
    }
  });
  const ordem = (meio) => ORDEM_DA_CATEGORIA[meio.category || 'buy_in'] ?? 9;
  // `sort` é estável: dentro da categoria fica a ordem de chegada.
  return Array.from(grupos.values()).sort((a, b) => ordem(a) - ordem(b));
};

/** Colunas por meio do quadro de jogadores: uma por nome, na ordem da lista. */
export const colunasDosJogadores = (porMeio) => {
  const colunas = [];
  const vistas = new Set();
  (porMeio || []).forEach((meio) => {
    const nome = (meio?.name || '').trim();
    const chave = chaveDoNome(nome);
    if (!chave || vistas.has(chave)) return;
    vistas.add(chave);
    colunas.push({ chave, nome });
  });
  return colunas;
};

/** Entradas do jogador numa coluna: soma as grafias do mesmo nome. */
export const entradasDoJogador = (jogador, chave) => Object.entries(jogador?.by_buy_type || {})
  .filter(([nome]) => chaveDoNome(nome) === chave)
  .reduce((soma, [, n]) => soma + (Number(n) || 0), 0);
