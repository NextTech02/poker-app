/**
 * Rótulos do bar: meio de pagamento pelo nome e categorias padrão que o banco
 * criou em português traduzidas na exibição.
 */
import { nomeDaCategoria, rotuloDoMeioDoBar } from './barRotulos';

const EN = {
  'financial.paymentPix': 'PIX',
  'financial.paymentCash': 'Cash',
  'bar.playerCredit': 'Player credit',
  'bar.defaultCategory.beverages': 'Beverages',
  'bar.defaultCategory.beers': 'Beers',
  'bar.defaultCategory.snacks': 'Snacks',
};
const tEn = (chave, padrao) => EN[chave] || padrao || chave;

describe('meio de pagamento', () => {
  it('embutido sai traduzido, não como código', () => {
    expect(rotuloDoMeioDoBar(tEn, 'cash')).toBe('Cash');
    expect(rotuloDoMeioDoBar(tEn, 'pix')).toBe('PIX');
  });

  it('crédito do jogador tem nome próprio', () => {
    expect(rotuloDoMeioDoBar(tEn, 'credit')).toBe('Player credit');
  });

  it('meio do clube usa o nome cadastrado, mesmo desativado', () => {
    expect(rotuloDoMeioDoBar(tEn, 'nequi', [{ code: 'nequi', label: 'Nequi', active: false }])).toBe('Nequi');
  });
});

describe('categoria', () => {
  it('a categoria padrão em português sai no idioma do app', () => {
    expect(nomeDaCategoria(tEn, 'Bebidas')).toBe('Beverages');
    expect(nomeDaCategoria(tEn, 'Cervejas')).toBe('Beers');
    expect(nomeDaCategoria(tEn, 'Petiscos')).toBe('Snacks');
  });

  it('"Drinks" não é traduzido: é também a primeira categoria do clube em inglês', () => {
    expect(nomeDaCategoria(tEn, 'Drinks')).toBe('Drinks');
  });

  it('categoria criada pelo clube passa como está', () => {
    expect(nomeDaCategoria(tEn, 'Vinhos da casa')).toBe('Vinhos da casa');
  });
});
