/**
 * Bilhete de assento (o papel que o jogador leva para a mesa).
 *
 * Ele NÃO usa o i18n do app: os rótulos são uma tabela própria, porque o
 * bilhete é impresso para o JOGADOR, que pode não falar o idioma do
 * operador. Um clube em Medellín opera em português e imprime em espanhol.
 *
 * A distinção que mais importa é entre bilhete de mesa e de **alternate**:
 * o alternate não tem lugar ainda. Imprimir "MESA undefined - ASSENTO
 * undefined" mandaria o jogador procurar uma mesa que não existe; o bilhete
 * precisa dizer, em letras grandes, que ele está na fila.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SeatTicket from './SeatTicket';

// Prefixo `mock`: exigencia do Jest para referenciar a variavel de dentro
// da fabrica do jest.mock.
let mockIdioma = 'pt-BR';
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ i18n: { get language() { return mockIdioma; } } }),
}));
// Imagem/cidade/sede do clube vêm do banco; aqui, nenhuma (o layout é o
// testado em utils/bilhete.test.js).
jest.mock('../hooks/useBrandingDoBilhete', () => ({ useBrandingDoBilhete: () => null }));

/** O texto do bilhete impresso, sem as tags. */
const textoImpresso = (html) => html.replace(/<style[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const ALOCACAO = {
  id: 'a1',
  player_name: 'Ana Souza',
  table_number: 3,
  seat_number: 7,
  tournament_name: 'Main Event',
  day_name: 'Dia 1A',
  created_at: '2026-06-08T20:30:00Z',
};

/** Captura o HTML mandado para a janela de impressão. */
function espiaoDeImpressao() {
  const capturado = { html: '' };
  const janela = {
    document: {
      write: (h) => {
        capturado.html += h;
      },
      close: jest.fn(),
    },
  };
  jest.spyOn(window, 'open').mockReturnValue(janela);
  return capturado;
}

beforeEach(() => {
  mockIdioma = 'pt-BR';
});

afterEach(() => {
  if (window.open.mockRestore) window.open.mockRestore();
});

describe('prévia na tela', () => {
  it('mostra torneio, dia e jogador', () => {
    render(<SeatTicket allocation={ALOCACAO} />);
    expect(screen.getByText('Main Event')).toBeInTheDocument();
    expect(screen.getByText('Dia 1A')).toBeInTheDocument();
    expect(screen.getByText('Ana Souza')).toBeInTheDocument();
  });

  it('mostra mesa e assento em destaque', () => {
    // É a informação que o jogador procura no papel.
    render(<SeatTicket allocation={ALOCACAO} />);
    expect(screen.getByText('Mesa 3 - Assento 7')).toBeInTheDocument();
  });

  it('sem torneio nem dia mostra um travessão, não um campo vazio', () => {
    // Uma linha em branco pareceria defeito de impressão.
    render(
      <SeatTicket
        allocation={{ ...ALOCACAO, tournament_name: null, day_name: null }}
      />
    );
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('só o dia, sem torneio, ainda aparece', () => {
    render(<SeatTicket allocation={{ ...ALOCACAO, tournament_name: null }} />);
    expect(screen.getByText('Dia 1A')).toBeInTheDocument();
    expect(screen.queryByText('—')).toBeNull();
  });

  it('alternate mostra a fila em vez de mesa e assento', () => {
    // "MESA undefined" mandaria o jogador procurar uma mesa que não existe.
    render(
      <SeatTicket
        allocation={{ ...ALOCACAO, is_alternate: true, table_number: null, seat_number: null }}
      />
    );
    expect(screen.getByText('ALTERNATE')).toBeInTheDocument();
    expect(screen.getByText('Aguardando alocação de mesa')).toBeInTheDocument();
    expect(screen.queryByText(/Mesa .* Assento/)).toBeNull();
  });

  it('o cabeçalho da prévia diz de que bilhete se trata', () => {
    render(<SeatTicket allocation={ALOCACAO} />);
    expect(screen.getByText('Bilhete de Entrada')).toBeInTheDocument();
  });

  it('alternate tem cabeçalho próprio', () => {
    render(<SeatTicket allocation={{ ...ALOCACAO, is_alternate: true }} />);
    expect(screen.getByText('Ticket de Alternate')).toBeInTheDocument();
  });
});

describe('idioma do bilhete', () => {
  it('segue o idioma do app em português', () => {
    render(<SeatTicket allocation={ALOCACAO} />);
    expect(screen.getByRole('button')).toHaveTextContent('Imprimir Bilhete');
  });

  it('em espanhol imprime "Boleto"', () => {
    // O bilhete é para o JOGADOR: um clube em Medellín opera em português e
    // imprime em espanhol.
    mockIdioma = 'es-ES';
    render(<SeatTicket allocation={ALOCACAO} />);
    expect(screen.getByText('Mesa 3 - Asiento 7')).toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveTextContent('Imprimir Boleto');
  });

  it('em inglês imprime "Table"', () => {
    mockIdioma = 'en-US';
    render(<SeatTicket allocation={ALOCACAO} />);
    expect(screen.getByText('Table 3 - Seat 7')).toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveTextContent('Print Ticket');
  });

  it('idioma desconhecido cai no português', () => {
    mockIdioma = 'de-DE';
    render(<SeatTicket allocation={ALOCACAO} />);
    expect(screen.getByText('Mesa 3 - Assento 7')).toBeInTheDocument();
  });

  it('sem idioma definido cai no português', () => {
    mockIdioma = undefined;
    render(<SeatTicket allocation={ALOCACAO} />);
    expect(screen.getByText('Mesa 3 - Assento 7')).toBeInTheDocument();
  });
});

describe('impressão', () => {
  it('abre a janela de impressão com os dados do bilhete', async () => {
    const impresso = espiaoDeImpressao();
    render(<SeatTicket allocation={ALOCACAO} />);
    await userEvent.click(screen.getByRole('button'));
    expect(impresso.html).toContain('Ana Souza');
    expect(textoImpresso(impresso.html)).toMatch(/MESA 3 ASSENTO 7/);
    expect(impresso.html).toContain('Main Event');
  });

  it('o bilhete impresso manda imprimir e fechar sozinho', async () => {
    // A impressora do balcão é térmica: o operador não pode ter que fechar
    // uma janela a cada jogador.
    const impresso = espiaoDeImpressao();
    render(<SeatTicket allocation={ALOCACAO} />);
    await userEvent.click(screen.getByRole('button'));
    expect(impresso.html).toContain('window.print()');
    expect(impresso.html).toContain('window.close()');
  });

  it('define largura de bobina de 80mm', async () => {
    const impresso = espiaoDeImpressao();
    render(<SeatTicket allocation={ALOCACAO} />);
    await userEvent.click(screen.getByRole('button'));
    expect(impresso.html).toContain('80mm');
  });

  it('bilhete de alternate impresso não traz mesa nem assento', async () => {
    const impresso = espiaoDeImpressao();
    render(
      <SeatTicket
        allocation={{ ...ALOCACAO, is_alternate: true, table_number: null, seat_number: null }}
      />
    );
    await userEvent.click(screen.getByRole('button'));
    expect(impresso.html).toContain('ALTERNATE');
    expect(impresso.html).toContain('Aguarde ser chamado pelo staff');
    expect(impresso.html).not.toContain('ASSENTO null');
  });

  it('sem torneio a seção nem é impressa', async () => {
    // Um rótulo "Torneio" seguido de nada gastaria papel e confundiria.
    const impresso = espiaoDeImpressao();
    render(<SeatTicket allocation={{ ...ALOCACAO, tournament_name: null }} />);
    await userEvent.click(screen.getByRole('button'));
    expect(impresso.html).not.toContain('>Torneio<');
  });

  it('sem dia a seção nem é impressa', async () => {
    const impresso = espiaoDeImpressao();
    render(<SeatTicket allocation={{ ...ALOCACAO, day_name: null }} />);
    await userEvent.click(screen.getByRole('button'));
    expect(impresso.html).not.toContain('>Dia<');
  });

  it('imprime o identificador para conferência', async () => {
    // É por ele que o staff resolve uma dúvida sobre o bilhete depois.
    const impresso = espiaoDeImpressao();
    render(<SeatTicket allocation={ALOCACAO} />);
    await userEvent.click(screen.getByRole('button'));
    expect(impresso.html).toContain('a1');
  });

  it('alocação sem identificador não imprime "undefined"', async () => {
    const impresso = espiaoDeImpressao();
    render(<SeatTicket allocation={{ ...ALOCACAO, id: undefined }} />);
    await userEvent.click(screen.getByRole('button'));
    expect(impresso.html).not.toContain('undefined');
  });

  it('imprime em espanhol quando o app está em espanhol', async () => {
    mockIdioma = 'es-ES';
    const impresso = espiaoDeImpressao();
    render(<SeatTicket allocation={ALOCACAO} />);
    await userEvent.click(screen.getByRole('button'));
    expect(textoImpresso(impresso.html)).toMatch(/MESA 3 POSICIÓN 7/);
    expect(impresso.html).toContain('REGISTRO DE TORNEO');
    expect(impresso.html).toContain('FIRMA DEL JUGADOR');
  });
});

/**
 * Compra da venda: a lista do que o jogador levou e o TOTAL DE FICHAS. É o
 * número que o floor confere para entregar a pilha — antes ele somava de
 * cabeça dois ou três bilhetes da mesma venda.
 */
describe('compra e total de fichas', () => {
  const COMPRA = {
    itens: [
      { name: 'Entrada', amount: 200, chips: 20000 },
      { name: 'Bono Dealer', amount: 20, chips: 10000 },
    ],
    total_amount: 220,
    total_chips: 30000,
  };
  const soles = (v) => `S/ ${Number(v).toFixed(2)}`;

  it('a prévia lista cada item com valor e fichas, e o total', () => {
    render(<SeatTicket allocation={{ ...ALOCACAO, ...COMPRA }} formatarValor={soles} />);
    expect(screen.getByText('Entrada')).toBeInTheDocument();
    expect(screen.getByText('Bono Dealer')).toBeInTheDocument();
    expect(screen.getByText('S/ 220.00')).toBeInTheDocument();
    expect(screen.getByTestId('bilhete-total-fichas')).toHaveTextContent('30.000 fichas');
  });

  it('sem itens o bilhete é o de sempre, sem bloco de compra', () => {
    render(<SeatTicket allocation={ALOCACAO} />);
    expect(screen.queryByTestId('bilhete-compra')).toBeNull();
  });

  it('o total sai dos itens quando não vem pronto', () => {
    render(<SeatTicket allocation={{ ...ALOCACAO, itens: COMPRA.itens }} />);
    expect(screen.getByTestId('bilhete-total-fichas')).toHaveTextContent('30.000 fichas');
  });

  it('o bilhete impresso traz os itens, o total cobrado e as fichas a entregar', async () => {
    const impresso = espiaoDeImpressao();
    render(<SeatTicket allocation={{ ...ALOCACAO, ...COMPRA }} formatarValor={soles} />);
    await userEvent.click(screen.getByRole('button'));
    expect(impresso.html).toContain('Bono Dealer');
    expect(impresso.html).toContain('S/ 20.00');
    expect(impresso.html).toContain('S/ 220.00');
    expect(impresso.html).toContain('TOTAL DE FICHAS');
    expect(impresso.html).toContain('30.000');
    // A mesa continua no papel junto com a compra.
    expect(textoImpresso(impresso.html)).toMatch(/MESA 3 ASSENTO 7/);
  });

  it('venda sem assento (alocação manual) não imprime "MESA undefined"', async () => {
    const impresso = espiaoDeImpressao();
    render(
      <SeatTicket
        allocation={{ ...ALOCACAO, table_number: undefined, seat_number: undefined, sem_assento: true, ...COMPRA }}
      />
    );
    expect(screen.queryByText(/Mesa .* Assento/)).toBeNull();
    await userEvent.click(screen.getByRole('button'));
    expect(impresso.html).not.toContain('undefined');
    expect(impresso.html).not.toContain('Sua Mesa e Assento');
    expect(impresso.html).toContain('30.000');
  });

  it('só add-on vira bilhete de FICHAS', async () => {
    const impresso = espiaoDeImpressao();
    render(<SeatTicket allocation={{ ...ALOCACAO, sem_assento: true, so_fichas: true, ...COMPRA }} />);
    expect(screen.getByText('Bilhete de Fichas')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button'));
    expect(impresso.html).toContain('BILHETE DE FICHAS');
  });

  it('em espanhol o total sai como "Fichas a entregar" e o número no formato de lá', async () => {
    mockIdioma = 'es-ES';
    const impresso = espiaoDeImpressao();
    render(<SeatTicket allocation={{ ...ALOCACAO, ...COMPRA, total_chips: 130000 }} />);
    await userEvent.click(screen.getByRole('button'));
    expect(impresso.html).toContain('TOTAL DE FICHAS');
    expect(impresso.html).toContain('130.000');
  });

  it('nome com "<" não quebra o HTML impresso', async () => {
    const impresso = espiaoDeImpressao();
    render(
      <SeatTicket allocation={{ ...ALOCACAO, itens: [{ name: '<b>VIP</b>', amount: 1, chips: 1 }] }} />
    );
    await userEvent.click(screen.getByRole('button'));
    expect(impresso.html).toContain('&lt;b&gt;VIP&lt;/b&gt;');
    expect(impresso.html).not.toContain('<b>VIP</b>');
  });
});

/**
 * Bilhete de add-on: o floor leva a pilha extra até a cadeira. O papel diz o
 * nome, a mesa e o assento onde o jogador ESTÁ, e o item no formato que o
 * clube pediu — "ADDON: 200 / fichas".
 */
describe('bilhete de add-on', () => {
  const ADDON = { itens: [{ name: 'Addon', amount: 200, chips: 50000 }], total_amount: 200, total_chips: 50000 };

  it('traz nome, mesa e assento, e o item como NOME: valor / fichas', async () => {
    const impresso = espiaoDeImpressao();
    render(<SeatTicket allocation={{ ...ALOCACAO, so_fichas: true, ...ADDON }} />);
    expect(screen.getByText('Ana Souza')).toBeInTheDocument();
    expect(screen.getByText('Mesa 3 - Assento 7')).toBeInTheDocument();
    expect(screen.getByText('Addon').closest('li')).toHaveTextContent('Addon: 200.00 / 50.000 fichas');
    await userEvent.click(screen.getByRole('button'));
    const texto = textoImpresso(impresso.html);
    expect(texto).toContain('BILHETE DE FICHAS');
    expect(texto).toContain('Ana Souza');
    expect(texto).toMatch(/MESA 3 ASSENTO 7/);
    // Um item só: MODALIDADE e FICHAS, e o valor embaixo.
    expect(texto).toMatch(/MODALIDADE: Addon FICHAS: 50\.000/);
    expect(texto).toMatch(/VALOR: 200\.00/);
  });

  it('com um item só não há linha TOTAL; com dois, há', () => {
    const { unmount } = render(<SeatTicket allocation={{ ...ALOCACAO, so_fichas: true, ...ADDON }} />);
    expect(screen.queryByText('TOTAL')).toBeNull();
    unmount();
    render(
      <SeatTicket allocation={{ ...ALOCACAO, itens: [...ADDON.itens, { name: 'Bono Dealer', amount: 20, chips: 10000 }] }} />
    );
    expect(screen.getByText('TOTAL').closest('li')).toHaveTextContent('TOTAL: 220.00 / 60.000 fichas');
  });

  it('em espanhol sai com MESA e ASIENTO e o mesmo formato do item', async () => {
    mockIdioma = 'es-ES';
    const impresso = espiaoDeImpressao();
    render(<SeatTicket allocation={{ ...ALOCACAO, so_fichas: true, ...ADDON }} />);
    await userEvent.click(screen.getByRole('button'));
    const texto = textoImpresso(impresso.html);
    expect(texto).toContain('BOLETO DE FICHAS');
    expect(texto).toMatch(/MESA 3 POSICIÓN 7/);
    expect(texto).toMatch(/MODALIDAD: Addon FICHAS: 50\.000/);
  });
});
