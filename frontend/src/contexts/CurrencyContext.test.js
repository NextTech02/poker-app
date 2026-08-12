/**
 * Moeda do clube.
 *
 * Há duas fontes: o localStorage (leitura SÍNCRONA, usada na renderização) e
 * a tabela `app_settings` (a configuração compartilhada de verdade). A ordem
 * importa: o app abre com o valor local para não piscar "R$" antes de trocar
 * para "S/", e o banco corrige em seguida se estiver diferente.
 *
 * Sem login ou sem rede, o valor local continua valendo — uma casa que opera
 * offline não pode ver todos os valores mudarem de moeda.
 */
import { render, screen, act, waitFor } from '@testing-library/react';
import { CurrencyProvider, useCurrency } from './CurrencyContext';
import { supabase } from '../config/supabase';

jest.mock('../config/supabase', () => {
  const cadeia = {};
  cadeia.from = jest.fn(() => cadeia);
  cadeia.select = jest.fn(() => cadeia);
  cadeia.update = jest.fn(() => cadeia);
  cadeia.eq = jest.fn(() => cadeia);
  cadeia.single = jest.fn();
  return { supabase: cadeia };
});

let api;

function Sonda() {
  api = useCurrency();
  return (
    <div>
      <span data-testid="moeda">{api.currency}</span>
      <span data-testid="valor">{api.formatCurrency(1234.5)}</span>
    </div>
  );
}

const montar = () => render(<CurrencyProvider><Sonda /></CurrencyProvider>);

beforeEach(() => {
  localStorage.clear();
  api = null;
  supabase.from.mockReturnValue(supabase);
  supabase.select.mockReturnValue(supabase);
  supabase.update.mockReturnValue(supabase);
  supabase.eq.mockReturnValue(supabase);
  supabase.single.mockResolvedValue({ data: null });
});

describe('carga', () => {
  it('abre com a moeda guardada localmente', async () => {
    // Leitura síncrona: sem isso a tela piscaria "R$" antes de virar "S/".
    localStorage.setItem('app_currency', 'PEN');
    await act(async () => {
      montar();
    });
    expect(screen.getByTestId('moeda')).toHaveTextContent('PEN');
  });

  it('a configuração do banco corrige o valor local', async () => {
    // A moeda é uma decisão do clube, não do computador: um caixa novo
    // precisa pegar a mesma moeda dos outros.
    localStorage.setItem('app_currency', 'BRL');
    supabase.single.mockResolvedValue({ data: { currency: 'USD' } });
    await act(async () => {
      montar();
    });
    await waitFor(() => expect(screen.getByTestId('moeda')).toHaveTextContent('USD'));
    expect(localStorage.getItem('app_currency')).toBe('USD');
  });

  it('moeda desconhecida vinda do banco é ignorada', async () => {
    localStorage.setItem('app_currency', 'BRL');
    supabase.single.mockResolvedValue({ data: { currency: 'XYZ' } });
    await act(async () => {
      montar();
    });
    expect(screen.getByTestId('moeda')).toHaveTextContent('BRL');
  });

  it('sem login ou sem rede mantém o valor local', async () => {
    localStorage.setItem('app_currency', 'EUR');
    supabase.single.mockRejectedValue(new Error('sem sessão'));
    await act(async () => {
      montar();
    });
    expect(screen.getByTestId('moeda')).toHaveTextContent('EUR');
  });
});

describe('troca de moeda', () => {
  it('atualiza a tela e o valor local na hora', async () => {
    await act(async () => {
      montar();
    });
    await act(async () => {
      await api.setCurrency('PEN');
    });
    expect(screen.getByTestId('moeda')).toHaveTextContent('PEN');
    expect(localStorage.getItem('app_currency')).toBe('PEN');
  });

  it('grava a escolha no banco', async () => {
    await act(async () => {
      montar();
    });
    await act(async () => {
      await api.setCurrency('USD');
    });
    expect(supabase.update).toHaveBeenCalledWith(
      expect.objectContaining({ currency: 'USD' })
    );
  });

  it('falha na gravação não desfaz a troca local', async () => {
    // O operador já viu a moeda mudar; reverter em silêncio seria pior que
    // ficar dessincronizado até o próximo carregamento.
    await act(async () => {
      montar();
    });
    supabase.update.mockImplementation(() => {
      throw new Error('sem permissão');
    });
    await act(async () => {
      await api.setCurrency('GBP');
    });
    expect(screen.getByTestId('moeda')).toHaveTextContent('GBP');
  });

  it('código inexistente é recusado sem tocar no banco', async () => {
    await act(async () => {
      montar();
    });
    supabase.update.mockClear();
    await act(async () => {
      await api.setCurrency('XYZ');
    });
    expect(screen.getByTestId('moeda')).not.toHaveTextContent('XYZ');
    expect(supabase.update).not.toHaveBeenCalled();
  });
});

describe('formatação ligada à moeda ativa', () => {
  it('formata com o símbolo da moeda atual', async () => {
    localStorage.setItem('app_currency', 'BRL');
    await act(async () => {
      montar();
    });
    expect(screen.getByTestId('valor')).toHaveTextContent('R$');
  });

  it('trocar a moeda refaz a formatação dos consumidores', async () => {
    // O formatador é memorizado pela moeda: se não mudasse de identidade, os
    // valores na tela continuariam com o símbolo antigo.
    await act(async () => {
      montar();
    });
    await act(async () => {
      await api.setCurrency('USD');
    });
    expect(screen.getByTestId('valor')).toHaveTextContent('US$');
  });

  it('expõe o catálogo de moedas para o seletor', async () => {
    await act(async () => {
      montar();
    });
    expect(api.currencies.BRL.symbol).toBe('R$');
  });
});
