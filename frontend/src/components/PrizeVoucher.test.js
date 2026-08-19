/**
 * Comprovante de pagamento de prêmio.
 *
 * É o papel que o ganhador assina ao receber o dinheiro — a prova do clube
 * de que pagou. Por isso duas coisas não são detalhe:
 *
 * - **O documento é mascarado.** O comprovante circula: fica no caixa, é
 *   fotografado, às vezes vai para um grupo de mensagens. Imprimir o CPF
 *   inteiro exporia o jogador; os 4 últimos dígitos bastam para conferir
 *   contra o documento na mão.
 * - **Tem linha de assinatura.** Sem ela o papel não serve como
 *   comprovante de nada.
 *
 * Como o SeatTicket, ele tem tabela de idiomas própria: quem recebe é o
 * JOGADOR, não o operador.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PrizeVoucher from './PrizeVoucher';
import { useCurrency } from '../contexts/CurrencyContext';
import { TIPOS_DOCUMENTO, TIPOS_LEGADO } from '../utils/documentos';

let mockIdioma = 'pt-BR';
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ i18n: { get language() { return mockIdioma; } } }),
}));
jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));

const PAGAMENTO = {
  player_name: 'Ana Souza',
  position: 1,
  prize_amount: 12500,
  document_type: 'national_id',
  document_number: '123.456.789-00',
  tournament_name: 'Main Event',
  day_name: 'Dia Final',
  paid_by: 'Operador João',
  paid_at: '2026-06-08T22:15:00Z',
};

function espiaoDeImpressao() {
  const capturado = { html: '' };
  jest.spyOn(window, 'open').mockReturnValue({
    document: {
      write: (h) => {
        capturado.html += h;
      },
      close: jest.fn(),
    },
  });
  return capturado;
}

beforeEach(() => {
  mockIdioma = 'pt-BR';
  useCurrency.mockReturnValue({
    formatCurrency: (v) => `R$ ${Number(v).toFixed(2)}`,
  });
});

afterEach(() => {
  if (window.open.mockRestore) window.open.mockRestore();
});

describe('conteúdo', () => {
  it('mostra jogador, posição e valor', () => {
    render(<PrizeVoucher payout={PAGAMENTO} />);
    expect(screen.getByText('Ana Souza')).toBeInTheDocument();
    expect(screen.getByText('1° Lugar')).toBeInTheDocument();
    expect(screen.getByText('R$ 12500.00')).toBeInTheDocument();
  });

  it('mostra torneio e dia', () => {
    render(<PrizeVoucher payout={PAGAMENTO} />);
    expect(screen.getByText('Main Event')).toBeInTheDocument();
    expect(screen.getByText('Dia Final')).toBeInTheDocument();
  });

  it('mostra quem pagou', () => {
    // Numa divergência, é por aqui que se descobre quem atendeu.
    render(<PrizeVoucher payout={PAGAMENTO} />);
    expect(screen.getByText('Operador João')).toBeInTheDocument();
  });

  it('sem torneio, dia ou atendente, as linhas nem aparecem', () => {
    // Rótulos com valor vazio gastariam papel e pareceriam defeito.
    render(
      <PrizeVoucher
        payout={{ ...PAGAMENTO, tournament_name: null, day_name: null, paid_by: null }}
      />
    );
    expect(screen.queryByText('Main Event')).toBeNull();
    expect(screen.queryByText('Operador João')).toBeNull();
  });

  it('tem linha de assinatura', () => {
    // Sem ela o papel não serve como comprovante de nada.
    render(<PrizeVoucher payout={PAGAMENTO} />);
    expect(screen.getByText('Assinatura do Ganhador')).toBeInTheDocument();
  });

  it('usa a moeda configurada no clube', () => {
    useCurrency.mockReturnValue({ formatCurrency: (v) => `S/ ${v}` });
    render(<PrizeVoucher payout={PAGAMENTO} />);
    expect(screen.getByText('S/ 12500')).toBeInTheDocument();
  });
});

describe('máscara do documento', () => {
  it('mostra só os 4 últimos dígitos', () => {
    // O comprovante circula (fica no caixa, é fotografado); o número inteiro
    // exporia o jogador, e 4 dígitos bastam para conferir com o documento.
    // "123.456.789-00" → 11 dígitos → 7 estrelas + "8900"
    render(<PrizeVoucher payout={PAGAMENTO} />);
    expect(screen.getByText('Identidade: *******8900')).toBeInTheDocument();
  });

  it('ignora pontuação ao mascarar', () => {
    render(
      <PrizeVoucher payout={{ ...PAGAMENTO, document_number: '12.345.678/0001-99' }} />
    );
    expect(screen.getByText(/\*+0199$/)).toBeInTheDocument();
  });

  it('documento curto é escondido por inteiro', () => {
    // Com 4 dígitos ou menos, "mostrar os últimos 4" seria mostrar tudo.
    render(<PrizeVoucher payout={{ ...PAGAMENTO, document_number: '1234' }} />);
    expect(screen.getByText('Identidade: ****')).toBeInTheDocument();
  });

  it('sem documento mostra um travessão', () => {
    render(
      <PrizeVoucher
        payout={{ ...PAGAMENTO, document_number: null, document_type: null }}
      />
    );
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it.each([
    ['passport', 'Passaporte'],
    ['national_id', 'Identidade'],
    ['driver_license', 'CNH'],
  ])('traduz o tipo %s', (tipo, rotulo) => {
    render(<PrizeVoucher payout={{ ...PAGAMENTO, document_type: tipo }} />);
    expect(screen.getByText(new RegExp(`^${rotulo}:`))).toBeInTheDocument();
  });

  it('tipo desconhecido sai como veio', () => {
    render(<PrizeVoucher payout={{ ...PAGAMENTO, document_type: 'outro' }} />);
    expect(screen.getByText(/^outro:/)).toBeInTheDocument();
  });

  it.each([
    ['cpf', 'CPF'],
    ['dni', 'DNI'],
    ['cedula', 'Cédula'],
  ])('traduz o tipo %s, do cadastro por país', (tipo, rotulo) => {
    // O clube opera em Brasil, Peru e Colômbia. Antes destes três tipos o
    // comprovante saía com o nome do campo do banco: "cpf: ***8900".
    render(<PrizeVoucher payout={{ ...PAGAMENTO, document_type: tipo }} />);
    expect(screen.getByText(new RegExp(`^${rotulo}:`))).toBeInTheDocument();
  });

  it('nenhum tipo do catálogo sai com o código do banco no papel', () => {
    // Trava contra o defeito voltar: se um tipo novo entrar no catálogo de
    // utils/documentos.js e ninguém lembrar do comprovante, quebra aqui — e
    // não na mão do ganhador.
    for (const tipo of [...TIPOS_DOCUMENTO, ...TIPOS_LEGADO]) {
      const { unmount } = render(
        <PrizeVoucher payout={{ ...PAGAMENTO, document_type: tipo.valor }} />
      );
      const linha = document.querySelector('.pv-doc').textContent;
      expect(linha.startsWith(`${tipo.valor}:`)).toBe(false);
      unmount();
    }
  });
});

describe('idioma', () => {
  it('português por padrão', () => {
    render(<PrizeVoucher payout={PAGAMENTO} />);
    expect(screen.getByRole('button')).toHaveTextContent('Imprimir Comprovante');
  });

  it('espanhol usa "Cédula" para identidade', () => {
    mockIdioma = 'es-ES';
    render(<PrizeVoucher payout={PAGAMENTO} />);
    expect(screen.getByText(/^Cédula:/)).toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveTextContent('Imprimir Comprobante');
  });

  it.each([
    [1, '1st Place'],
    [2, '2nd Place'],
    [3, '3rd Place'],
    [4, '4th Place'],
  ])('inglês usa ordinal correto para %i', (posicao, texto) => {
    mockIdioma = 'en-US';
    render(<PrizeVoucher payout={{ ...PAGAMENTO, position: posicao }} />);
    expect(screen.getByText(texto)).toBeInTheDocument();
  });

  it('idioma desconhecido cai no português', () => {
    mockIdioma = 'fr-FR';
    render(<PrizeVoucher payout={PAGAMENTO} />);
    expect(screen.getByText('1° Lugar')).toBeInTheDocument();
  });
});

describe('impressão', () => {
  it('imprime os dados do pagamento', async () => {
    const impresso = espiaoDeImpressao();
    render(<PrizeVoucher payout={PAGAMENTO} />);
    await userEvent.click(screen.getByRole('button'));
    expect(impresso.html).toContain('Ana Souza');
    expect(impresso.html).toContain('R$ 12500.00');
  });

  it('o documento sai mascarado também no papel', async () => {
    // De nada adiantaria mascarar só na tela: o papel é o que circula.
    const impresso = espiaoDeImpressao();
    render(<PrizeVoucher payout={PAGAMENTO} />);
    await userEvent.click(screen.getByRole('button'));
    expect(impresso.html).not.toContain('123.456.789-00');
    expect(impresso.html).toContain('8900');
  });

  it('imprime e fecha sozinho', async () => {
    const impresso = espiaoDeImpressao();
    render(<PrizeVoucher payout={PAGAMENTO} />);
    await userEvent.click(screen.getByRole('button'));
    expect(impresso.html).toContain('window.print()');
    expect(impresso.html).toContain('window.close()');
  });

  it('sem torneio a linha nem é impressa', async () => {
    const impresso = espiaoDeImpressao();
    render(<PrizeVoucher payout={{ ...PAGAMENTO, tournament_name: null }} />);
    await userEvent.click(screen.getByRole('button'));
    expect(impresso.html).not.toContain('#Torneio');
  });

  it('sem data de pagamento usa o instante atual', async () => {
    // Um comprovante sem data não prova quando o dinheiro saiu.
    const impresso = espiaoDeImpressao();
    render(<PrizeVoucher payout={{ ...PAGAMENTO, paid_at: null }} />);
    await userEvent.click(screen.getByRole('button'));
    expect(impresso.html).toMatch(/\d{2}\/\d{2}\/\d{4}/);
  });
});
