/**
 * Formas de pagamento têm duas naturezas e o rótulo precisa refletir isso:
 *
 * - as EMBUTIDAS (dinheiro, pix, cartão, transferência) existem em todo
 *   clube, então traduzem junto com o idioma do app;
 * - as PERSONALIZADAS (Yape no Peru, Nequi na Colômbia) foram digitadas pelo
 *   cliente e não têm tradução — traduzir "Yape" não faria sentido, e passá-la
 *   pelo i18n devolveria a própria chave na tela.
 */
import {
  BUILTIN_PAYMENT_CODES,
  isBuiltinMethod,
  methodLabel,
} from './paymentMethodLabels';

// t() do i18next devolve a própria chave quando não há tradução carregada;
// aqui devolvemos um marcador para deixar claro por qual caminho passou.
const t = (chave) => `<i18n:${chave}>`;

describe('classificação da forma de pagamento', () => {
  it.each(['cash', 'pix', 'card', 'transfer'])('%s é embutida', (codigo) => {
    expect(isBuiltinMethod(codigo)).toBe(true);
  });

  it('método do cliente não é embutido', () => {
    expect(isBuiltinMethod('yape')).toBe(false);
  });

  it('não confunde propriedade herdada de Object com código', () => {
    // `'toString' in obj` seria true por herança; a checagem precisa ser
    // sobre a própria tabela, senão um método chamado "constructor" viraria
    // "embutido" e a tela tentaria traduzi-lo.
    expect(isBuiltinMethod('toString')).toBe(false);
    expect(isBuiltinMethod('constructor')).toBe(false);
  });
});

describe('rótulo exibido', () => {
  it('embutida passa pelo i18n', () => {
    expect(methodLabel(t, { code: 'pix' })).toBe(`<i18n:${BUILTIN_PAYMENT_CODES.pix}>`);
  });

  it('personalizada usa o rótulo salvo no banco', () => {
    expect(methodLabel(t, { code: 'yape', label: 'Yape' })).toBe('Yape');
  });

  it('personalizada sem rótulo cai no próprio código', () => {
    expect(methodLabel(t, { code: 'nequi' })).toBe('nequi');
  });

  it('sem método mostra um traço', () => {
    // Transação antiga, gravada antes de a forma de pagamento existir.
    expect(methodLabel(t, null)).toBe('--');
    expect(methodLabel(t, undefined)).toBe('--');
  });

  it('método sem código nem rótulo mostra um traço', () => {
    expect(methodLabel(t, {})).toBe('--');
  });

  it('o código reservado do pagamento dividido tem rótulo próprio', () => {
    // Não é meio cadastrado e não é embutido (o cadastro não o mostra).
    expect(methodLabel(t, { code: 'split' })).toBe('<i18n:financial.paymentSplit>');
    expect(isBuiltinMethod('split')).toBe(false);
  });
});
