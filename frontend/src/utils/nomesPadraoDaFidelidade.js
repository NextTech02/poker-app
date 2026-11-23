/**
 * Níveis e recompensas que o banco criou em português para clubes de qualquer
 * idioma e moeda: a semente da fidelidade roda quando o clube nasce, antes de
 * o idioma e a moeda dele serem gravados. Daí "Prata" e "R$ 25 em crédito"
 * num clube colombiano que cobra em pesos.
 *
 * A tradução é só na EXIBIÇÃO: o dado do clube não muda, e um nome que o clube
 * escolheu nunca bate com os padrões daqui.
 */

const NIVEIS_PADRAO_PT = {
  Bronze: ['loyalty.defaultTier.bronze', 'Bronze'],
  Prata: ['loyalty.defaultTier.silver', 'Prata'],
  Ouro: ['loyalty.defaultTier.gold', 'Ouro'],
  Diamante: ['loyalty.defaultTier.diamond', 'Diamante'],
};

export const nomeDoNivel = (t, nome) => {
  const padrao = NIVEIS_PADRAO_PT[nome];
  return padrao ? t(padrao[0], padrao[1]) : nome;
};

// "R$ 25 em crédito", "R$ 50 em crédito", "R$ 100 em crédito".
const RECOMPENSA_PADRAO_PT = /^R\$ (\d+) em crédito$/;

/**
 * Nome da recompensa. A padrão diz "R$" mesmo quando o crédito sai na moeda
 * do clube; ela é reescrita com o valor que o jogador recebe de fato, na moeda
 * do clube. No clube em português que usa real o nome padrão já está certo e
 * fica como está.
 */
export const nomeDaRecompensa = (t, recompensa, { formatCurrency, idioma, moeda } = {}) => {
  const nome = recompensa?.name || '';
  const achado = RECOMPENSA_PADRAO_PT.exec(nome);
  if (!achado || Number(achado[1]) !== Number(recompensa.credit_value)) return nome;
  const emPortugues = String(idioma || '').startsWith('pt');
  if (emPortugues && (!moeda || moeda === 'BRL')) return nome;
  if (typeof formatCurrency !== 'function') return nome;
  return t('loyalty.defaultRewardName', '{{value}} em crédito', {
    value: formatCurrency(recompensa.credit_value),
  });
};
