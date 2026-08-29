/**
 * Moeda e idioma do clube.
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
import i18n from '../config/i18n';
import { marcarEscolhaDoUsuario } from '../utils/idiomaDoUsuario';

jest.mock('../config/supabase', () => {
  const cadeia = {};
  cadeia.from = jest.fn(() => cadeia);
  cadeia.select = jest.fn(() => cadeia);
  cadeia.update = jest.fn(() => cadeia);
  cadeia.eq = jest.fn(() => cadeia);
  cadeia.limit = jest.fn(() => cadeia);
  cadeia.maybeSingle = jest.fn();
  return { supabase: cadeia };
});

let api;

function Sonda() {
  api = useCurrency();
  return (
    <div>
      <span data-testid="moeda">{api.currency}</span>
      <span data-testid="valor">{api.formatCurrency(1234.5)}</span>
      <span data-testid="idioma">{api.language || 'nenhum'}</span>
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
  supabase.limit.mockReturnValue(supabase);
  supabase.maybeSingle.mockResolvedValue({ data: { id: 7 } });
  i18n.changeLanguage('pt-BR');
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
    supabase.maybeSingle.mockResolvedValue({ data: { id: 7, currency: 'USD' } });
    await act(async () => {
      montar();
    });
    await waitFor(() => expect(screen.getByTestId('moeda')).toHaveTextContent('USD'));
    expect(localStorage.getItem('app_currency')).toBe('USD');
  });

  it('moeda desconhecida vinda do banco é ignorada', async () => {
    localStorage.setItem('app_currency', 'BRL');
    supabase.maybeSingle.mockResolvedValue({ data: { id: 7, currency: 'XYZ' } });
    await act(async () => {
      montar();
    });
    expect(screen.getByTestId('moeda')).toHaveTextContent('BRL');
  });

  it('sem login ou sem rede mantém o valor local', async () => {
    localStorage.setItem('app_currency', 'EUR');
    supabase.maybeSingle.mockRejectedValue(new Error('sem sessão'));
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

describe('a linha lida é a do clube de quem está logado', () => {
  it('não filtra por id fixo', async () => {
    // O bug que deu origem a este bloco: a consulta trazia `.eq('id', 1)`.
    // `app_settings` tinha uma linha só quando o sistema era de um clube só;
    // hoje cada organização tem a sua (id 1, 20, 21, ...). Com o filtro, todo
    // clube que não fosse o de id 1 recebia vazio e ficava com o padrão local —
    // era por isso que os clubes colombianos, com COP gravado, viam R$.
    await act(async () => {
      montar();
    });
    expect(supabase.eq).not.toHaveBeenCalledWith('id', 1);
    expect(supabase.from).toHaveBeenCalledWith('app_settings');
  });

  it('grava usando o id que veio na leitura, não um id fixo', async () => {
    supabase.maybeSingle.mockResolvedValue({ data: { id: 20, currency: 'COP' } });
    await act(async () => {
      montar();
    });
    await act(async () => {
      await api.setCurrency('USD');
    });
    expect(supabase.eq).toHaveBeenCalledWith('id', 20);
  });

  it('se a carga inicial falhou, a gravação busca o id na hora', async () => {
    // Sem isto o clique no seletor não gravaria nada e não avisaria ninguém.
    supabase.maybeSingle.mockResolvedValueOnce({ data: null });
    await act(async () => {
      montar();
    });
    supabase.maybeSingle.mockResolvedValue({ data: { id: 21 } });
    await act(async () => {
      await api.setCurrency('PEN');
    });
    expect(supabase.eq).toHaveBeenCalledWith('id', 21);
  });
});

describe('idioma do clube', () => {
  it('aplica na tela o idioma vindo do banco', async () => {
    supabase.maybeSingle.mockResolvedValue({ data: { id: 20, language: 'es-ES' } });
    await act(async () => {
      montar();
    });
    await waitFor(() => expect(screen.getByTestId('idioma')).toHaveTextContent('es-ES'));
    expect(i18n.language).toBe('es-ES');
  });

  it('não atropela quem já escolheu o seu idioma', async () => {
    marcarEscolhaDoUsuario('pt-BR');
    supabase.maybeSingle.mockResolvedValue({ data: { id: 20, language: 'es-ES' } });
    await act(async () => {
      montar();
    });
    // O clube é espanhol; a pessoa pediu português e continua em português.
    await waitFor(() => expect(screen.getByTestId('idioma')).toHaveTextContent('es-ES'));
    expect(i18n.language).toBe('pt-BR');
  });

  it('idioma inválido no banco não muda a tela', async () => {
    supabase.maybeSingle.mockResolvedValue({ data: { id: 20, language: 'fr-FR' } });
    await act(async () => {
      montar();
    });
    expect(screen.getByTestId('idioma')).toHaveTextContent('nenhum');
    expect(i18n.language).toBe('pt-BR');
  });

  it('o contexto NÃO troca o idioma — só o lê', async () => {
    /* Quem troca de idioma é a bandeira da barra lateral, e o que ela guarda é
       a escolha da PESSOA. O idioma do clube é definido na criação da
       organização e serve de padrão para quem nunca escolheu; expor uma troca
       aqui criava um segundo lugar decidindo a mesma coisa. */
    await act(async () => {
      montar();
    });
    expect(api.setLanguage).toBeUndefined();
    expect(api.language).toBeDefined();
  });
});
