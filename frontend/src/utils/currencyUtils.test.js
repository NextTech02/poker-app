/**
 * A moeda é uma configuração GLOBAL do clube e é só de EXIBIÇÃO: troca o
 * símbolo e o formato do número, nunca converte valor. Um clube peruano que
 * muda para S/ continua com os mesmos 300 no banco — se a formatação
 * convertesse, o caixa passaria a mostrar um valor que não bate com o
 * dinheiro na gaveta.
 *
 * O espelho em localStorage existe para a formatação ser SÍNCRONA: as telas
 * formatam durante a renderização e não podem esperar uma ida ao banco.
 */
import {
  CURRENCIES,
  DEFAULT_CURRENCY,
  getStoredCurrency,
  setStoredCurrency,
  currencySymbol,
  formatCurrency,
} from './currencyUtils';

describe('moeda guardada localmente', () => {
  beforeEach(() => localStorage.clear());

  it('sem nada guardado, cai no padrão', () => {
    expect(getStoredCurrency()).toBe(DEFAULT_CURRENCY);
  });

  it('guarda e devolve a moeda escolhida', () => {
    setStoredCurrency('PEN');
    expect(getStoredCurrency()).toBe('PEN');
  });

  it('ignora um código que não existe', () => {
    // Um código inválido guardado (versão antiga, edição manual) não pode
    // deixar todos os valores da tela sem símbolo.
    localStorage.setItem('app_currency', 'XYZ');
    expect(getStoredCurrency()).toBe(DEFAULT_CURRENCY);
  });

  it('não grava código inexistente', () => {
    setStoredCurrency('XYZ');
    expect(localStorage.getItem('app_currency')).toBeNull();
  });

  it('sobrevive a localStorage indisponível', () => {
    // Navegador em modo privado / cookies bloqueados: a leitura estoura.
    // Sem o try, o app inteiro deixa de renderizar.
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error('acesso negado');
    };
    expect(getStoredCurrency()).toBe(DEFAULT_CURRENCY);
    Storage.prototype.getItem = original;
  });

  it('gravação em localStorage indisponível não quebra a tela', () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error('acesso negado');
    };
    expect(() => setStoredCurrency('USD')).not.toThrow();
    Storage.prototype.setItem = original;
  });
});

describe('símbolo', () => {
  it.each([
    ['BRL', 'R$'],
    ['USD', 'US$'],
    ['EUR', '€'],
    ['PEN', 'S/'],
    ['PYG', '₲'],
  ])('%s → %s', (codigo, simbolo) => {
    expect(currencySymbol(codigo)).toBe(simbolo);
  });

  it('código desconhecido cai no padrão', () => {
    expect(currencySymbol('XYZ')).toBe(CURRENCIES[DEFAULT_CURRENCY].symbol);
  });
});

describe('formatação', () => {
  beforeEach(() => localStorage.clear());

  it('usa o símbolo e o formato da moeda pedida', () => {
    const texto = formatCurrency(1234.5, 'BRL');
    expect(texto.startsWith('R$ ')).toBe(true);
    expect(texto).toContain('1');
    expect(texto).toContain('234');
  });

  it('sempre mostra duas casas decimais', () => {
    // Valor de caixa sem centavos ainda é dinheiro: "R$ 300" ao lado de
    // "R$ 300,00" na mesma coluna desalinha a conferência.
    expect(formatCurrency(300, 'BRL')).toMatch(/300[.,]00$/);
  });

  it('sem código, usa a moeda global guardada', () => {
    setStoredCurrency('USD');
    expect(formatCurrency(10).startsWith('US$ ')).toBe(true);
  });

  it.each([
    [null, 0],
    [undefined, 0],
    ['', 0],
    ['abacaxi', 0],
  ])('valor inválido (%p) vira zero em vez de NaN', (entrada) => {
    // "R$ NaN" numa tela de caixa é pior que zero: parece um defeito e o
    // operador não sabe se o dinheiro sumiu.
    expect(formatCurrency(entrada, 'BRL')).toMatch(/0[.,]00$/);
  });

  it('aceita número em texto', () => {
    expect(formatCurrency('250.75', 'BRL')).toMatch(/250[.,]75$/);
  });

  it('valor negativo mantém o sinal', () => {
    expect(formatCurrency(-50, 'BRL')).toContain('-');
  });

  it('não converte valor entre moedas', () => {
    const emReais = formatCurrency(100, 'BRL').replace(/[^\d]/g, '');
    const emDolares = formatCurrency(100, 'USD').replace(/[^\d]/g, '');
    expect(emReais).toBe(emDolares);
  });

  it('todas as moedas do catálogo formatam', () => {
    Object.keys(CURRENCIES).forEach((codigo) => {
      expect(formatCurrency(1, codigo)).toContain(CURRENCIES[codigo].symbol);
    });
  });
});
