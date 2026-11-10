/**
 * Níveis e recompensas padrão da fidelidade, que o banco criou em português
 * para clubes de qualquer idioma e moeda. A tela traduz só os nomes padrão
 * conhecidos; o que o clube digitou passa como está.
 */
import { nomeDaRecompensa, nomeDoNivel } from './nomesPadraoDaFidelidade';

// Um `t` em espanhol para as chaves deste módulo; o resto cai no padrão.
const ES = {
  'loyalty.defaultTier.silver': 'Plata',
  'loyalty.defaultTier.gold': 'Oro',
  'loyalty.defaultRewardName': '{{value}} en crédito',
};
const tEs = (chave, padrao, vars) => {
  const texto = ES[chave] || padrao || chave;
  return vars ? texto.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k]) : texto;
};
const pesos = (v) => `COP$ ${Number(v).toLocaleString('es-CO', { minimumFractionDigits: 2 })}`;

describe('nível', () => {
  it('o nome padrão em português sai no idioma do app', () => {
    expect(nomeDoNivel(tEs, 'Prata')).toBe('Plata');
    expect(nomeDoNivel(tEs, 'Ouro')).toBe('Oro');
  });

  it('nome escolhido pelo clube não muda', () => {
    expect(nomeDoNivel(tEs, 'VIP Black')).toBe('VIP Black');
  });
});

describe('recompensa', () => {
  const padrao = { name: 'R$ 25 em crédito', credit_value: 25 };

  it('a padrão sai com a moeda do clube, não com "R$"', () => {
    expect(nomeDaRecompensa(tEs, padrao, { formatCurrency: pesos, idioma: 'es-ES', moeda: 'COP' }))
      .toBe('COP$ 25,00 en crédito');
  });

  it('no clube em português que usa real fica como está', () => {
    expect(nomeDaRecompensa(tEs, padrao, { formatCurrency: pesos, idioma: 'pt-BR', moeda: 'BRL' }))
      .toBe('R$ 25 em crédito');
  });

  it('clube em português com outra moeda também é corrigido', () => {
    const dolar = (v) => `US$ ${Number(v).toFixed(2)}`;
    expect(nomeDaRecompensa((c, p, v) => p.replace('{{value}}', v.value), padrao,
      { formatCurrency: dolar, idioma: 'pt-BR', moeda: 'USD' }))
      .toBe('US$ 25.00 em crédito');
  });

  it('recompensa renomeada ou com outro valor não é tocada', () => {
    const opcoes = { formatCurrency: pesos, idioma: 'es-ES', moeda: 'COP' };
    expect(nomeDaRecompensa(tEs, { name: 'Buy-in grátis', credit_value: 25 }, opcoes)).toBe('Buy-in grátis');
    // O nome diz 25, mas o crédito foi mudado para 30: o nome não é mais o padrão.
    expect(nomeDaRecompensa(tEs, { name: 'R$ 25 em crédito', credit_value: 30 }, opcoes)).toBe('R$ 25 em crédito');
  });
});
