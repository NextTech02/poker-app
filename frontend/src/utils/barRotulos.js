/**
 * Rótulos do BAR que vêm do banco como código ou como dado padrão.
 *
 * O bar grava o meio de pagamento pelo código (`cash`, `pix`, `card`) e o
 * crédito do jogador como `credit`. Mostrar o código cru deixava "cash" e
 * "credit" na tela, também nos clubes em português.
 */
import { methodLabel } from './paymentMethodLabels';

/**
 * Nome do meio de pagamento de um recebimento do bar.
 *
 * `metodos` é a lista completa do clube (com os inativos), para um relatório
 * antigo não perder o nome de um meio que foi desativado depois.
 */
export const rotuloDoMeioDoBar = (t, codigo, metodos = []) => {
  if (!codigo) return '—';
  if (codigo === 'credit') return t('bar.playerCredit', 'Crédito do jogador');
  const cadastrado = (metodos || []).find((m) => m.code === codigo);
  return methodLabel(t, cadastrado || { code: codigo });
};

/*
 * Categorias que o banco criou em português para clubes de qualquer idioma: o
 * módulo era ligado na criação do clube antes de o idioma ser gravado, e a
 * semente caía no pt-BR. Traduzidas só na EXIBIÇÃO — o dado do clube não muda,
 * e quem renomeou a categoria vê o nome que digitou.
 *
 * "Drinks" fica de fora de propósito: não é português, e no clube em inglês é
 * o nome da PRIMEIRA categoria padrão (bebidas em geral); traduzi-lo juntaria
 * duas categorias com o mesmo nome. Pelo mesmo motivo "Bebidas" vira
 * "Beverages" em inglês, e não "Drinks".
 */
const CATEGORIAS_PADRAO_PT = {
  Bebidas: ['bar.defaultCategory.beverages', 'Bebidas'],
  Cervejas: ['bar.defaultCategory.beers', 'Cervejas'],
  Comidas: ['bar.defaultCategory.food', 'Comidas'],
  Petiscos: ['bar.defaultCategory.snacks', 'Petiscos'],
};

export const nomeDaCategoria = (t, nome) => {
  const padrao = CATEGORIAS_PADRAO_PT[nome];
  return padrao ? t(padrao[0], padrao[1]) : nome;
};
