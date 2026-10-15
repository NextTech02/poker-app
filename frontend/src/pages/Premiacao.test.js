/**
 * Premiação — configurar, liberar e PAGAR o prêmio.
 *
 * É a tela em que o clube entrega dinheiro. Três travas existem por isso, e
 * são o centro dos testes:
 *
 * - **Saldo restante.** O que foi alocado nas posições não pode passar do
 *   *payable pool* (o pool já descontada a premiação reservada). Estourar
 *   significa prometer prêmio que não existe, e a tela precisa gritar isso
 *   antes de alguém sentar na mesa final.
 * - **Liberação antes do pagamento.** Um prêmio só vira dinheiro na mão
 *   depois de liberado; pago não volta a ser editável nem removível.
 * - **Documento primeiro.** O pagamento não começa por escolher o jogador
 *   numa lista: o operador digita o documento e o sistema resolve quem é.
 *   Escolher da lista é como se paga o prêmio para a pessoa errada.
 *
 * O comprovante é emitido no ato e pode ser revisto depois — é o papel que
 * prova que aquele dinheiro saiu para aquela pessoa.
 */
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Premiacao from './Premiacao';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock('../components/Sidebar', () => () => <nav data-testid="sidebar" />);
jest.mock('../components/PrizeVoucher', () => ({ payout }) => (
  <div data-testid="comprovante">
    <span data-testid="comprovante-jogador">{payout.player_name}</span>
    <span data-testid="comprovante-posicao">{payout.position}</span>
    <span data-testid="comprovante-doc">{payout.document_number}</span>
    <span data-testid="comprovante-atendente">{payout.paid_by || '—'}</span>
  </div>
));
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));
const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useParams: () => ({ tournamentId: 't1' }),
  useNavigate: () => mockNavigate,
}));
jest.mock('react-i18next', () => {
  const t = (chave, vars) =>
    vars && typeof vars === 'object' ? `${chave}:${Object.values(vars).join(',')}` : chave;
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const TORNEIO = { id: 't1', name: 'Main Event' };

const ALOCACOES = [
  { id: 'a1', position: 1, prize_amount: 20000, released: true, visible: true, paid: false },
  { id: 'a2', position: 2, prize_amount: 10000, released: true, visible: false, paid: true,
    player_name: 'Ana', document_type: 'national_id', document_number: '12345678',
    paid_at: '2026-06-09T02:00:00Z', paid_by: 'Caixa 1' },
  { id: 'a3', position: 3, prize_amount: 5000, prize_type: 'vaga', released: false,
    visible: true, paid: false },
];

const RESUMO = {
  guaranteed_prize: '10000',
  reserved_prize_percentage: 3,
  reserved_purpose: 'ranking',
  reserved_amount: 1500,
  total_entries: 50000,
  player_pool: 40000,
  rake_percentage: 20,
  available_prize_pool: 40000,
  payable_pool: 38500,
  allocations: ALOCACOES,
};

// O recálculo automático apaga e recria TODAS as faixas, então fica bloqueado
// quando alguma já foi paga. Este resumo é o cenário "ainda dá para recalcular".
const SEM_PAGAS = { ...RESUMO, allocations: ALOCACOES.filter((a) => !a.paid) };

const DIAS = [
  { id: 'd1', day_name: 'Dia 1A', day_type: 'qualifying', buy_in: 500 },
  { id: 'd2', day_name: 'Final', day_type: 'final', buy_in: 0 },
];

// 3 inscrições que somam 5 entradas (buy-ins + rebuys) — a faixa 1..5 da
// estrutura paga 2 posições (65% / 35%).
const INSCRITOS = [
  { player_id: 'p1', player_name: 'Ana', buy_in_count: 1, rebuy_count: 1 },
  { player_id: 'p2', player_name: 'Beto', buy_in_count: 1, rebuy_count: 1 },
  { player_id: 'p1', player_name: 'Ana', buy_in_count: 1, rebuy_count: 0 },
];

const JOGADORES = [
  { id: 'p1', name: 'Ana', nickname: 'Aninha', document_type: 'national_id', document_number: '12.345.678-9' },
  { id: 'p2', name: 'Beto', document_type: 'passport', document_number: 'XY9090' },
  { id: 'p9', name: 'Sem doc' },
];

let toast;
let confirmar;

const responder = ({
  torneio = TORNEIO,
  resumo = RESUMO,
  dias = DIAS,
  inscritos = INSCRITOS,
  jogadores = JOGADORES,
  pool = { prize_pool: 40000, total_paid: 10000, available: 30000 },
  caixa = { current_balance: 50000 },
} = {}) => {
  api.get.mockImplementation((url) => {
    const erro = (v) => v instanceof Error;
    if (url === '/tournaments/t1') {
      return erro(torneio) ? Promise.reject(torneio) : Promise.resolve({ data: torneio });
    }
    if (url === '/tournaments/t1/prizes/summary') {
      return erro(resumo) ? Promise.reject(resumo) : Promise.resolve({ data: resumo });
    }
    if (url === '/tournament-days/tournament/t1') return Promise.resolve({ data: dias });
    if (url === '/tournament-players/tournament/t1') return Promise.resolve({ data: inscritos });
    if (url === '/tournaments/t1/prizes/pool') {
      return erro(pool) ? Promise.reject(pool) : Promise.resolve({ data: pool });
    }
    if (url === '/cash/general') return Promise.resolve({ data: caixa });
    if (url === '/players') return Promise.resolve({ data: jogadores });
    return Promise.resolve({ data: [] });
  });
};

const montar = async (opcoes) => {
  responder(opcoes);
  render(<MemoryRouter><Premiacao /></MemoryRouter>);
  await waitFor(() => expect(screen.queryByText('common.loading')).toBeNull());
};

const aba = (nome) => screen.getByRole('button', { name: new RegExp(`^${nome}`) });
const irPara = async (nome) => userEvent.click(aba(nome));

/** Espera o banner "jogador resolvido" do fluxo documento-primeiro. */
const esperarResolvido = () =>
  waitFor(() => {
    const banner = document.querySelector('.doc-registered-banner');
    expect(banner).not.toBeNull();
    return banner;
  });

const linhaDaPosicao = (rotulo) =>
  Array.from(document.querySelectorAll('tbody tr')).find((tr) =>
    within(tr).queryByText(rotulo)
  );

beforeEach(() => {
  toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn() };
  confirmar = jest.fn().mockResolvedValue(true);
  useToast.mockReturnValue({ toast, confirm: confirmar });
  useCurrency.mockReturnValue({
    formatCurrency: (v) => `R$ ${Number(v || 0).toFixed(2)}`,
    currency: 'BRL',
  });
  api.post.mockResolvedValue({ data: {} });
  api.patch.mockResolvedValue({ data: {} });
  api.delete.mockResolvedValue({ data: {} });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => console.error.mockRestore());

describe('carga', () => {
  it('mostra o carregamento antes dos dados', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<MemoryRouter><Premiacao /></MemoryRouter>);
    expect(screen.getByText('common.loading')).toBeInTheDocument();
  });

  it('mostra o nome do torneio', async () => {
    await montar();
    expect(screen.getByText('Main Event')).toBeInTheDocument();
  });

  it('falha ao carregar vira um aviso, não uma tela em branco', async () => {
    await montar({ resumo: new Error('500') });
    expect(screen.getByText('premiacao.loadError')).toBeInTheDocument();
  });

  it('o aviso pode ser dispensado', async () => {
    await montar({ resumo: new Error('500') });
    await userEvent.click(within(document.querySelector('.error-banner')).getByText('✕'));
    expect(screen.queryByText('premiacao.loadError')).toBeNull();
  });

  it('torneio com dias classificatórios avisa que a premiação é da final', async () => {
    // Num torneio com Dia 1, o prêmio não é de cada dia: é do dia final. Sem
    // esse aviso o operador configuraria premiação por classificatório.
    await montar();
    expect(document.querySelector('.qualifying-banner')).toHaveTextContent('premiacao.qualifyingBanner');
    expect(document.querySelector('.qualifying-banner')).toHaveTextContent('Final');
  });

  it('torneio de dia único não mostra esse aviso', async () => {
    await montar({ dias: [{ id: 'd1', day_name: 'Único', day_type: 'starting' }] });
    expect(document.querySelector('.qualifying-banner')).toBeNull();
  });

  it('o botão voltar volta', async () => {
    await montar();
    await userEvent.click(screen.getByRole('button', { name: /common.back/ }));
    expect(mockNavigate).toHaveBeenCalledWith(-1);
  });
});

describe('resumo financeiro', () => {
  it('mostra entradas, bolo dos jogadores e rake', async () => {
    // Os mesmos valores aparecem nas posições da tabela; os cartões do topo
    // são o alvo.
    await montar();
    expect(document.querySelector('.entries-card .card-value')).toHaveTextContent('R$ 50000.00');
    expect(document.querySelector('.player-pool-card .card-value')).toHaveTextContent('R$ 40000.00');
    // rake = 20% de 50000
    expect(document.querySelector('.rake-card .card-value')).toHaveTextContent('R$ 10000.00');
  });

  it('o percentual do bolo é o complemento do rake', async () => {
    await montar();
    expect(screen.getByText('premiacao.percentOfEntries:80')).toBeInTheDocument();
  });

  it('sem rake informado assume 20%', async () => {
    // Um resumo antigo sem o campo não pode virar "NaN%" na tela.
    await montar({ resumo: { ...RESUMO, rake_percentage: null } });
    expect(screen.getByText('20%')).toBeInTheDocument();
  });

  it('mostra alocado e saldo restante sobre o pool pagável', async () => {
    // 38500 pagáveis − 35000 alocados = 3500. O pool pagável já desconta a
    // premiação reservada; usar o pool bruto aqui prometeria prêmio a mais.
    await montar();
    expect(document.querySelector('.pool-item.allocated')).toHaveTextContent('R$ 35000.00');
    expect(document.querySelector('.pool-item.remaining')).toHaveTextContent('R$ 3500.00');
  });

  it('alocação acima do pool é sinalizada como estouro', async () => {
    // Prometer mais do que existe é o erro mais caro dessa tela.
    await montar({
      resumo: {
        ...RESUMO,
        allocations: [{ id: 'a1', position: 1, prize_amount: 99000, paid: false }],
      },
    });
    const saldo = document.querySelector('.pool-item.remaining');
    expect(saldo).toHaveClass('negative');
    expect(saldo).toHaveTextContent('premiacao.allocationExceeds');
  });

  it('sem pool pagável informado cai no pool disponível', async () => {
    await montar({ resumo: { ...RESUMO, payable_pool: null } });
    // 40000 − 35000 = 5000
    expect(document.querySelector('.pool-item.remaining')).toHaveTextContent('R$ 5000.00');
  });
});

describe('prêmio garantido', () => {
  it('salva o valor digitado', async () => {
    await montar();
    const campo = document.querySelector('.guaranteed-card .guaranteed-input');
    await userEvent.clear(campo);
    await userEvent.type(campo, '25000');
    await userEvent.click(within(document.querySelector('.guaranteed-card')).getByRole('button'));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/tournaments/t1/guaranteed-prize', {
        guaranteed_prize: 25000,
      })
    );
    expect(toast.success).toHaveBeenCalledWith('premiacao.guaranteedSaved');
  });

  it('campo vazio salva zero, não NaN', async () => {
    await montar();
    const campo = document.querySelector('.guaranteed-card .guaranteed-input');
    await userEvent.clear(campo);
    await userEvent.click(within(document.querySelector('.guaranteed-card')).getByRole('button'));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/tournaments/t1/guaranteed-prize', {
        guaranteed_prize: 0,
      })
    );
  });

  it('falha ao salvar avisa', async () => {
    api.patch.mockRejectedValue(new Error('500'));
    await montar();
    await userEvent.click(within(document.querySelector('.guaranteed-card')).getByRole('button'));
    expect(await screen.findByText('premiacao.guaranteedSaveError')).toBeInTheDocument();
  });
});

describe('premiação reservada', () => {
  it('mostra o percentual e a finalidade já configurados', async () => {
    await montar();
    await irPara('premiacao.reservedPrize');
    expect(document.querySelector('.reserved-card .guaranteed-input')).toHaveValue(3);
    expect(document.querySelector('.reserved-purpose-select')).toHaveValue('ranking');
  });

  it('salva percentual e finalidade juntos', async () => {
    await montar();
    await irPara('premiacao.reservedPrize');
    await userEvent.selectOptions(document.querySelector('.reserved-purpose-select'), 'staff');
    await userEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/tournaments/t1/reserved-prize', {
        reserved_prize_percentage: 3,
        reserved_purpose: 'staff',
      })
    );
  });

  it('finalidade em branco vai como nula, não string vazia', async () => {
    await montar({ resumo: { ...RESUMO, reserved_purpose: '' } });
    await irPara('premiacao.reservedPrize');
    await userEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        '/tournaments/t1/reserved-prize',
        expect.objectContaining({ reserved_purpose: null })
      )
    );
  });

  it('mostra em dinheiro quanto a reserva representa', async () => {
    // O percentual sozinho não diz nada ao operador; o valor sim.
    await montar();
    await irPara('premiacao.reservedPrize');
    expect(screen.getByText('premiacao.reservedResult:R$ 1500.00')).toBeInTheDocument();
  });

  it('reserva zerada não mostra valor', async () => {
    await montar({ resumo: { ...RESUMO, reserved_amount: 0 } });
    await irPara('premiacao.reservedPrize');
    expect(document.querySelector('.reserved-result')).toBeNull();
  });

  it('erro do servidor é mostrado como veio', async () => {
    // O backend recusa percentuais que estouram o pool, com uma explicação;
    // trocá-la por um texto genérico esconderia o motivo.
    api.patch.mockRejectedValue({ response: { data: { detail: 'Reserva acima do pool' } } });
    await montar();
    await irPara('premiacao.reservedPrize');
    await userEvent.click(screen.getByRole('button', { name: 'common.save' }));
    expect(await screen.findByText('Reserva acima do pool')).toBeInTheDocument();
  });
});

describe('posições configuradas', () => {
  it('lista cada posição com o percentual do POOL PAGÁVEL', async () => {
    // Base = 38500 (pool já descontada a reserva), a mesma do "Saldo
    // restante". Sobre o pool bruto daria 50.0% e a tela contaria duas
    // histórias diferentes sobre o mesmo prêmio.
    await montar();
    const linha = linhaDaPosicao('1°');
    expect(within(linha).getByText('R$ 20000.00')).toBeInTheDocument();
    expect(within(linha).getByText('51.95%')).toBeInTheDocument();
  });

  it('sem reserva configurada o percentual continua o de sempre', async () => {
    // Não-regressão da troca de base: com payable == disponível, 20000 de
    // 40000 seguem sendo 50%.
    await montar({ resumo: { ...RESUMO, reserved_prize_percentage: 0, reserved_amount: 0, payable_pool: 40000 } });
    expect(within(linhaDaPosicao('1°')).getByText('50.0%')).toBeInTheDocument();
  });

  it('o pódio recebe destaque próprio', async () => {
    // A função já devolveu 'rank-other' para todos; as três classes existiam
    // no CSS e nunca eram aplicadas.
    await montar();
    expect(within(linhaDaPosicao('1°')).getByText('1°')).toHaveClass('rank-1');
    expect(within(linhaDaPosicao('2°')).getByText('2°')).toHaveClass('rank-2');
    expect(within(linhaDaPosicao('3°')).getByText('3°')).toHaveClass('rank-3');
  });

  it('fora do pódio fica neutro', async () => {
    await montar({
      resumo: { ...RESUMO, allocations: [{ id: 'a4', position: 4, prize_amount: 100, paid: false }] },
    });
    expect(screen.getByText('4°')).toHaveClass('rank-other');
  });

  it('sem posição nenhuma explica o que fazer', async () => {
    await montar({ resumo: { ...RESUMO, allocations: [] } });
    expect(screen.getByText('premiacao.noPrizesConfigured')).toBeInTheDocument();
  });

  it('o rodapé fecha o total e o percentual usado', async () => {
    await montar();
    const rodape = document.querySelector('tfoot');
    expect(rodape).toHaveTextContent('R$ 35000.00');
    // 35000 de 38500 pagáveis
    expect(rodape).toHaveTextContent('90.91%');
  });

  it('a soma acima de 100% do pool é sinalizada no rodapé', async () => {
    // Prometer 110% do pool não falha ao configurar — falha na hora de pagar,
    // e quem fica sem receber é a ÚLTIMA posição da mesa final.
    await montar({
      resumo: {
        ...RESUMO,
        allocations: [{ id: 'a1', position: 1, prize_amount: 42000, paid: false }],
      },
    });
    const rodape = document.querySelector('tfoot');
    expect(rodape.querySelector('.percent-total')).toHaveClass('negative');
    expect(rodape).toHaveTextContent('premiacao.allocationExceeds');
  });

  it('pool zerado não vira divisão por zero', async () => {
    await montar({ resumo: { ...RESUMO, available_prize_pool: 0, payable_pool: 0 } });
    expect(document.querySelector('tfoot')).toHaveTextContent('0.0%');
  });
});

describe('edição do valor de uma posição', () => {
  it('clicar no valor abre a edição e salvar envia', async () => {
    await montar();
    await userEvent.click(within(linhaDaPosicao('1°')).getByRole('button', { name: 'R$ 20000.00' }));
    const campo = within(linhaDaPosicao('1°')).getByRole('spinbutton');
    await userEvent.clear(campo);
    await userEvent.type(campo, '21000');
    await userEvent.click(within(linhaDaPosicao('1°')).getByText('OK'));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/tournaments/t1/prizes/a1', { prize_amount: 21000 })
    );
  });

  it('cancelar devolve o valor original', async () => {
    await montar();
    const linha = linhaDaPosicao('1°');
    await userEvent.click(within(linha).getByRole('button', { name: 'R$ 20000.00' }));
    const campo = within(linha).getByRole('spinbutton');
    await userEvent.clear(campo);
    await userEvent.type(campo, '999');
    // O "X" de cancelar a edição e o "X" de remover a posição têm o mesmo
    // texto; a classe distingue.
    await userEvent.click(linha.querySelector('.btn-cancel'));
    expect(within(linhaDaPosicao('1°')).getByText('R$ 20000.00')).toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('o valor abre a edição pelo teclado, sem mouse', async () => {
    /* O operador de premiação trabalha de Tab e Enter. Enquanto o valor era um
       <div> com onClick, essa edição simplesmente não existia para ele. */
    await montar();
    const valor = within(linhaDaPosicao('1°')).getByRole('button', { name: 'R$ 20000.00' });
    valor.focus();
    await userEvent.keyboard('{Enter}');
    expect(within(linhaDaPosicao('1°')).getByRole('spinbutton')).toBeInTheDocument();
  });

  it('posição JÁ PAGA não pode ser editada', async () => {
    // Mudar o valor de um prêmio já entregue quebraria a conferência do caixa.
    await montar();
    await userEvent.click(within(linhaDaPosicao('2°')).getByText('R$ 10000.00'));
    expect(within(linhaDaPosicao('2°')).queryByRole('spinbutton')).toBeNull();
  });

  it('posição paga não pode ser removida', async () => {
    await montar();
    expect(within(linhaDaPosicao('2°')).getByTitle('premiacao.cannotRemovePaid')).toBeDisabled();
  });

  it('falha ao salvar avisa', async () => {
    api.patch.mockRejectedValue(new Error('500'));
    await montar();
    await userEvent.click(within(linhaDaPosicao('1°')).getByRole('button', { name: 'R$ 20000.00' }));
    await userEvent.click(within(linhaDaPosicao('1°')).getByText('OK'));
    expect(await screen.findByText('premiacao.updateError')).toBeInTheDocument();
  });
});

describe('edição do percentual de uma posição', () => {
  /* O operador do clube pensa em percentual ("o primeiro leva 30%"), mas o
     que fica gravado — e o que o caixa entrega — é o valor em dinheiro. A
     edição por percentual é só um modo de entrada: nada de percentual vai
     para a API. */
  const abrirPercentual = async (posicao, texto) => {
    const linha = linhaDaPosicao(posicao);
    await userEvent.click(within(linha).getByRole('button', { name: texto }));
    return linhaDaPosicao(posicao);
  };

  it('digitar o percentual grava o VALOR correspondente do pool pagável', async () => {
    await montar();
    const linha = await abrirPercentual('1°', '51.95%');
    const campo = within(linha).getByRole('spinbutton');
    await userEvent.clear(campo);
    await userEvent.type(campo, '30');
    await userEvent.click(within(linhaDaPosicao('1°')).getByText('OK'));
    // 30% de 38500 pagáveis = 11550 — e o corpo não leva percentual nenhum.
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/tournaments/t1/prizes/a1', { prize_amount: 11550 })
    );
  });

  it('mostra em dinheiro quanto o percentual digitado vale antes de salvar', async () => {
    // Sem a prévia, o operador só descobre o valor depois de gravar.
    await montar();
    const linha = await abrirPercentual('1°', '51.95%');
    const campo = within(linha).getByRole('spinbutton');
    await userEvent.clear(campo);
    await userEvent.type(campo, '10');
    expect(within(linhaDaPosicao('1°')).getByText(/R\$ 3850\.00/)).toBeInTheDocument();
  });

  it('cancelar não grava nada e devolve o percentual original', async () => {
    await montar();
    const linha = await abrirPercentual('1°', '51.95%');
    const campo = within(linha).getByRole('spinbutton');
    await userEvent.clear(campo);
    await userEvent.type(campo, '99');
    await userEvent.click(linhaDaPosicao('1°').querySelector('.btn-cancel'));
    expect(within(linhaDaPosicao('1°')).getByText('51.95%')).toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('percentual em branco não dispara gravação', async () => {
    // parseFloat('') é NaN, que vira null no JSON e o backend recusa com um
    // erro que não explica nada ao operador.
    await montar();
    const linha = await abrirPercentual('1°', '51.95%');
    await userEvent.clear(within(linha).getByRole('spinbutton'));
    await userEvent.click(within(linhaDaPosicao('1°')).getByText('OK'));
    await waitFor(() => expect(api.patch).not.toHaveBeenCalled());
  });

  it('posição JÁ PAGA não abre a edição do percentual', async () => {
    await montar();
    await userEvent.click(within(linhaDaPosicao('2°')).getByText('25.97%'));
    expect(within(linhaDaPosicao('2°')).queryByRole('spinbutton')).toBeNull();
  });

  it('prêmio do tipo VAGA não é editável nem por valor nem por percentual', async () => {
    // A vaga vale o buy-in do dia alvo; mexer no valor aqui a desconfiguraria.
    await montar();
    const linha = linhaDaPosicao('3°');
    await userEvent.click(within(linha).getByText('R$ 5000.00'));
    expect(within(linhaDaPosicao('3°')).queryByRole('spinbutton')).toBeNull();
    await userEvent.click(within(linhaDaPosicao('3°')).getByText('12.99%'));
    expect(within(linhaDaPosicao('3°')).queryByRole('spinbutton')).toBeNull();
  });

  it('a VAGA explica por que não abre, em vez de só ignorar o clique', async () => {
    /* Essa faixa já foi editável. Bloquear sem nenhum retorno faz o operador
       clicar, clicar de novo e concluir que a tela travou — sem saber que o
       valor está certo e vem do buy-in do dia alvo. */
    await montar();
    const linha = linhaDaPosicao('3°');
    const valor = within(linha).getByText('R$ 5000.00').closest('.editable-value');
    expect(valor).toHaveAttribute('title', 'premiacao.vagaNotEditable');
    expect(within(linha).getByText('12.99%'))
      .toHaveAttribute('title', 'premiacao.vagaNotEditable');
    // E um selo ao lado do valor, para não depender de parar o mouse em cima.
    expect(within(linha).getByText('premiacao.vagaBadge')).toBeInTheDocument();
  });
});

describe('remoção de posição', () => {
  it('pede confirmação de perigo antes de remover', async () => {
    await montar();
    await userEvent.click(within(linhaDaPosicao('1°')).getByTitle('premiacao.removeTitle'));
    expect(confirmar).toHaveBeenCalledWith(
      'premiacao.confirmRemovePosition',
      expect.objectContaining({ variant: 'danger' })
    );
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/tournaments/t1/prizes/a1'));
  });

  it('cancelar não remove', async () => {
    confirmar.mockResolvedValue(false);
    await montar();
    await userEvent.click(within(linhaDaPosicao('1°')).getByTitle('premiacao.removeTitle'));
    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('erro do servidor aparece com o motivo', async () => {
    api.delete.mockRejectedValue({ response: { data: { detail: 'Prêmio já liberado' } } });
    await montar();
    await userEvent.click(within(linhaDaPosicao('1°')).getByTitle('premiacao.removeTitle'));
    expect(await screen.findByText('Prêmio já liberado')).toBeInTheDocument();
  });
});

describe('nova posição', () => {
  const abrir = async () => {
    await userEvent.click(screen.getByRole('button', { name: 'premiacao.addPosition' }));
    return document.querySelector('.modal form');
  };

  it('já sugere a próxima posição livre', async () => {
    // A última configurada é a 3ª; digitar "1" de novo criaria conflito.
    await montar();
    await abrir();
    expect(screen.getByPlaceholderText('premiacao.positionPlaceholder')).toHaveValue('4');
  });

  it('sem posição nenhuma configurada começa na primeira', async () => {
    await montar({ resumo: { ...RESUMO, allocations: [] } });
    await abrir();
    expect(screen.getByPlaceholderText('premiacao.positionPlaceholder')).toHaveValue('1');
  });

  it('cria um prêmio em dinheiro', async () => {
    await montar();
    await abrir();
    await userEvent.type(screen.getByPlaceholderText('0.00'), '2500');
    await userEvent.click(screen.getByRole('button', { name: 'common.add' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/tournaments/t1/prizes', {
        position: 4,
        prize_amount: 2500,
      })
    );
  });

  it('uma faixa (7-9) cria uma linha por colocação, numa chamada só', async () => {
    // Cada colocação continua sendo paga a um jogador; o telão agrupa de volta.
    await montar();
    await abrir();
    const posicao = screen.getByPlaceholderText('premiacao.positionPlaceholder');
    await userEvent.clear(posicao);
    await userEvent.type(posicao, '7-9');
    await userEvent.type(screen.getByPlaceholderText('0.00'), '400');
    expect(screen.getByText(/premiacao\.rangeTotal:3,/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'common.add' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/tournaments/t1/prizes/range', {
        position: 7, position_end: 9, prize_amount: 400,
      })
    );
  });

  it('faixa de vagas aponta para o dia e vai pela rota de faixa', async () => {
    await montar();
    await abrir();
    const posicao = screen.getByPlaceholderText('premiacao.positionPlaceholder');
    await userEvent.clear(posicao);
    await userEvent.type(posicao, '10-12');
    await userEvent.selectOptions(document.querySelector('.modal select'), 'vaga');
    await userEvent.selectOptions(screen.getAllByRole('combobox')[1], 'd2');
    await userEvent.click(screen.getByRole('button', { name: 'common.add' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/tournaments/t1/prizes/range', {
        position: 10, position_end: 12, prize_type: 'vaga',
        vaga_target_tournament_id: 't1', vaga_target_day_id: 'd2',
      })
    );
  });

  it('faixa invertida (9-7) ou lixo é recusada antes de ir ao servidor', async () => {
    await montar();
    const form = await abrir();
    const posicao = screen.getByPlaceholderText('premiacao.positionPlaceholder');
    await userEvent.clear(posicao);
    await userEvent.type(posicao, '9-7');
    await userEvent.type(screen.getByPlaceholderText('0.00'), '400');
    fireEvent.submit(form);
    expect(await screen.findByText(/positionInvalid|Posição inválida/)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('mostra quanto ainda cabe no pool na hora de digitar', async () => {
    await montar();
    await abrir();
    expect(screen.getByText('premiacao.availableBalance:R$ 3500.00')).toBeInTheDocument();
  });

  it('prêmio do tipo VAGA aponta para um dia, não para um valor', async () => {
    // A vaga é uma entrada em outro dia; ela não sai do bolo em dinheiro.
    await montar();
    await abrir();
    await userEvent.selectOptions(document.querySelector('.modal select'), 'vaga');
    expect(screen.queryByPlaceholderText('0.00')).toBeNull();
    await userEvent.selectOptions(screen.getAllByRole('combobox')[1], 'd2');
    await userEvent.click(screen.getByRole('button', { name: 'common.add' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/tournaments/t1/prizes', {
        position: 4,
        prize_type: 'vaga',
        vaga_target_tournament_id: 't1',
        vaga_target_day_id: 'd2',
      })
    );
  });

  it('vaga sem dia escolhido é recusada', async () => {
    // (fireEvent.submit pula a validação do navegador, que aqui esconderia a
    // regra da aplicação.)
    await montar();
    const form = await abrir();
    await userEvent.selectOptions(document.querySelector('.modal select'), 'vaga');
    fireEvent.submit(form);
    expect(await screen.findByText('premiacao.selectVagaDay')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('valor em branco não cria nada', async () => {
    await montar();
    const form = await abrir();
    fireEvent.submit(form);
    await waitFor(() => expect(api.post).not.toHaveBeenCalled());
  });

  it('erro do servidor aparece com o motivo', async () => {
    api.post.mockRejectedValue({ response: { data: { detail: 'Posição já existe' } } });
    await montar();
    await abrir();
    await userEvent.type(screen.getByPlaceholderText('0.00'), '10');
    await userEvent.click(screen.getByRole('button', { name: 'common.add' }));
    expect(await screen.findByText('Posição já existe')).toBeInTheDocument();
  });

  it('cancelar fecha sem criar', async () => {
    await montar();
    await abrir();
    await userEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(document.querySelector('.modal')).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('Esc fecha o modal sem criar', async () => {
    // Clicar no fundo é gesto de mouse; no teclado a saída é o Esc.
    await montar();
    await abrir();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(document.querySelector('.modal')).toBeNull());
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe('cálculo automático da estrutura', () => {
  const abrir = () => userEvent.click(screen.getByRole('button', { name: 'premiacao.calculateAuto' }));

  it('conta as ENTRADAS, não as pessoas', async () => {
    // Quem recomprou pagou duas vezes e conta duas vezes na estrutura; contar
    // cabeças pagaria menos posições do que o devido.
    await montar();
    await abrir();
    expect(await screen.findByText('5')).toBeInTheDocument();
  });

  it('sem ninguém inscrito não há o que calcular', async () => {
    await montar({ inscritos: [] });
    await abrir();
    expect(toast.error).toHaveBeenCalledWith('premiacao.noEntries');
  });

  it('pool pagável zerado não gera estrutura', async () => {
    await montar({ resumo: { ...RESUMO, available_prize_pool: 0, payable_pool: 0 } });
    await abrir();
    expect(toast.error).toHaveBeenCalledWith('premiacao.prizepoolZero');
  });

  it('mostra a prévia das posições antes de aplicar', async () => {
    // 5 entradas pagam 2 posições: 65% e 35%.
    await montar();
    await abrir();
    const previa = document.querySelector('.auto-calc-table-wrap');
    expect(within(previa).getAllByRole('spinbutton').map((c) => c.value))
      .toEqual(['65', '25025', '35', '13475']);
  });

  it('a estrutura é distribuída sobre o POOL PAGÁVEL', async () => {
    // 65% de 38500 (e não de 40000): a reserva não pode ser prometida às
    // posições, senão o pagamento da última trava por falta de pool.
    await montar();
    await abrir();
    expect(within(document.querySelector('.auto-calc-table-wrap')).getAllByRole('spinbutton')[1])
      .toHaveValue(25025);
  });

  it('avisa que as posições atuais serão substituídas', async () => {
    // Aplicar por cima apaga a configuração manual; sem o aviso o operador
    // perderia o que ajustou à mão.
    await montar();
    await abrir();
    expect(screen.getByText('premiacao.positionsReplaced:3')).toBeInTheDocument();
  });

  it('sem posições configuradas não há o que avisar', async () => {
    await montar({ resumo: { ...RESUMO, allocations: [] } });
    await abrir();
    expect(document.querySelector('.auto-calc-warning')).toBeNull();
  });

  it('aplicar envia as posições em lote', async () => {
    await montar({ resumo: SEM_PAGAS });
    await abrir();
    await userEvent.click(screen.getByRole('button', { name: 'premiacao.confirmAndApply' }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [url, corpo] = api.post.mock.calls[0];
    expect(url).toBe('/tournaments/t1/prizes/bulk');
    expect(corpo.allocations).toHaveLength(2);
    // 65% de 38500 pagáveis; o percentual NÃO vai no corpo.
    expect(corpo.allocations[0]).toEqual({ position: 1, prize_amount: 25025 });
  });

  it('erro ao aplicar aparece com o motivo POR CIMA do modal', async () => {
    /* A recusa vinha para o banner da página, que fica ATRÁS do modal aberto:
       o operador clicava em aplicar, o botão piscava e nada acontecia — e ele
       reclicava. As duas recusas do servidor (soma acima do pool pagável,
       torneio com faixa já paga) são justamente as que ele precisa ler para
       corrigir os valores. */
    api.post.mockRejectedValue({ response: { data: { detail: 'Torneio encerrado' } } });
    await montar({ resumo: SEM_PAGAS });
    await abrir();
    await userEvent.click(screen.getByRole('button', { name: 'premiacao.confirmAndApply' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Torneio encerrado'));
    // E o modal continua aberto com os valores digitados, para ele ajustar.
    expect(document.querySelector('.auto-calc-modal')).not.toBeNull();
  });

  it('erro sem motivo legível cai numa mensagem padrão, também em toast', async () => {
    api.post.mockRejectedValue({ response: { data: { detail: [{ msg: 'x' }] } } });
    await montar({ resumo: SEM_PAGAS });
    await abrir();
    await userEvent.click(screen.getByRole('button', { name: 'premiacao.confirmAndApply' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('premiacao.autoApplyError'));
  });

  it('torneio com prêmio JÁ PAGO não deixa recalcular', async () => {
    // Aplicar apaga TODAS as faixas e recria: a faixa paga perderia o registro
    // do dinheiro que já saiu do caixa, e a conferência nunca mais fecharia.
    await montar();
    await abrir();
    expect(screen.getByText('premiacao.autoBlockedByPaid')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'premiacao.confirmAndApply' })).toBeDisabled();
  });

  it('cancelar fecha sem aplicar', async () => {
    await montar();
    await abrir();
    await userEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(document.querySelector('.auto-calc-modal')).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });

  describe('ajuste da prévia antes de aplicar', () => {
    /* A tabela fixa é uma SUGESTÃO. O clube corta uma posição, arredonda o
       prêmio do primeiro, decide pagar menos gente — e nada disso pode exigir
       aplicar primeiro e corrigir faixa por faixa depois. */
    const previa = () => document.querySelector('.auto-calc-table-wrap');
    const campos = () => within(previa()).getAllByRole('spinbutton');
    const campoPct = (linha) => campos()[linha * 2];
    const campoValor = (linha) => campos()[linha * 2 + 1];
    const digitar = async (campo, texto) => {
      await userEvent.clear(campo);
      await userEvent.type(campo, texto);
    };

    it('mudar o percentual recalcula o valor SÓ daquela linha', async () => {
      await montar({ resumo: SEM_PAGAS });
      await abrir();
      await digitar(campoPct(0), '50');
      expect(campoValor(0)).toHaveValue(19250);   // 50% de 38500
      expect(campoValor(1)).toHaveValue(13475);   // a 2ª não é rebalanceada
    });

    it('mudar o valor recalcula o percentual exibido', async () => {
      await montar({ resumo: SEM_PAGAS });
      await abrir();
      await digitar(campoValor(0), '19250');
      expect(campoPct(0)).toHaveValue(50);
    });

    it('aplicar envia os valores EDITADOS, sem percentual no corpo', async () => {
      await montar({ resumo: SEM_PAGAS });
      await abrir();
      await digitar(campoValor(0), '10000');
      await userEvent.click(screen.getByRole('button', { name: 'premiacao.confirmAndApply' }));
      await waitFor(() => expect(api.post).toHaveBeenCalled());
      const corpo = api.post.mock.calls[0][1];
      expect(corpo.allocations[0]).toEqual({ position: 1, prize_amount: 10000 });
    });

    it('restaurar sugestão descarta as edições', async () => {
      await montar({ resumo: SEM_PAGAS });
      await abrir();
      await digitar(campoPct(0), '10');
      await userEvent.click(screen.getByRole('button', { name: 'premiacao.restoreSuggestion' }));
      expect(campoPct(0)).toHaveValue(65);
      expect(campoValor(0)).toHaveValue(25025);
    });

    it('soma acima do pool pagável impede aplicar', async () => {
      // Distribuir mais do que existe não falha aqui: falha na hora de pagar,
      // e quem fica sem receber é a última posição da fila.
      await montar({ resumo: SEM_PAGAS });
      await abrir();
      await digitar(campoValor(0), '40000');
      expect(document.querySelector('.auto-calc-over')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'premiacao.confirmAndApply' })).toBeDisabled();
    });

    it('sobrar dinheiro apenas avisa, sem travar', async () => {
      // Pagar menos que o pool é decisão do clube (ex.: guardar para a etapa).
      await montar({ resumo: SEM_PAGAS });
      await abrir();
      await digitar(campoValor(0), '1000');
      expect(document.querySelector('.auto-calc-leftover')).toHaveTextContent('R$ 24025.00');
      expect(screen.getByRole('button', { name: 'premiacao.confirmAndApply' })).not.toBeDisabled();
    });

    it('campo em branco não vira prêmio NaN', async () => {
      await montar({ resumo: SEM_PAGAS });
      await abrir();
      await userEvent.clear(campoValor(0));
      expect(screen.getByRole('button', { name: 'premiacao.confirmAndApply' })).toBeDisabled();
    });

    it('remover uma linha reduz as posições enviadas', async () => {
      await montar({ resumo: SEM_PAGAS });
      await abrir();
      await userEvent.click(within(previa()).getAllByTitle('premiacao.removeTitle')[0]);
      await userEvent.click(screen.getByRole('button', { name: 'premiacao.confirmAndApply' }));
      await waitFor(() => expect(api.post).toHaveBeenCalled());
      const corpo = api.post.mock.calls[0][1];
      expect(corpo.allocations).toEqual([{ position: 2, prize_amount: 13475 }]);
    });

    it('dá para acrescentar uma posição à prévia', async () => {
      await montar({ resumo: SEM_PAGAS });
      await abrir();
      // Abre espaço no pool antes: a 3ª posição precisa caber no pagável.
      await digitar(campoValor(0), '20000');
      await userEvent.click(screen.getByRole('button', { name: 'premiacao.addPreviewRow' }));
      await digitar(campoValor(2), '500');
      await userEvent.click(screen.getByRole('button', { name: 'premiacao.confirmAndApply' }));
      await waitFor(() => expect(api.post).toHaveBeenCalled());
      const corpo = api.post.mock.calls[0][1];
      expect(corpo.allocations).toHaveLength(3);
      expect(corpo.allocations[2]).toEqual({ position: 3, prize_amount: 500 });
    });
  });
});

describe('liberação', () => {
  const irLiberacao = async () => irPara('premiacao.tabRelease');

  it('a aba conta quantos estão liberados e ainda não pagos', async () => {
    await montar();
    expect(within(aba('premiacao.tabRelease')).getByText('1')).toBeInTheDocument();
  });

  it('mostra a proporção de liberados', async () => {
    await montar();
    await irLiberacao();
    expect(screen.getByText('2/3')).toBeInTheDocument();
  });

  it('liberar envia a marcação', async () => {
    await montar();
    await irLiberacao();
    await userEvent.click(within(linhaDaPosicao('3°')).getByText('premiacao.releaseAction'));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/tournaments/t1/prizes/a3/release', { released: true })
    );
    expect(toast.success).toHaveBeenCalledWith('premiacao.releaseGranted');
  });

  it('revogar a liberação também é possível', async () => {
    // Um prêmio liberado por engano precisa poder voltar atrás enquanto não
    // foi pago.
    await montar();
    await irLiberacao();
    await userEvent.click(within(linhaDaPosicao('1°')).getByText('premiacao.releasedRevoke'));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/tournaments/t1/prizes/a1/release', { released: false })
    );
    expect(toast.success).toHaveBeenCalledWith('premiacao.releaseRevoked');
  });

  it('prêmio JÁ PAGO não oferece o botão de liberar', async () => {
    await montar();
    await irLiberacao();
    const linha = linhaDaPosicao('2°');
    expect(within(linha).getByText('premiacao.statusPaid')).toBeInTheDocument();
    expect(within(linha).queryByText('premiacao.releasedRevoke')).toBeNull();
  });

  it('erro ao liberar aparece com o motivo', async () => {
    api.patch.mockRejectedValue({ response: { data: { detail: 'Sem permissão' } } });
    await montar();
    await irLiberacao();
    await userEvent.click(within(linhaDaPosicao('3°')).getByText('premiacao.releaseAction'));
    expect(await screen.findByText('Sem permissão')).toBeInTheDocument();
  });

  it('a visibilidade pública é alternada em separado', async () => {
    // Liberar (pagar) e mostrar na TV são decisões diferentes.
    await montar();
    await irLiberacao();
    await userEvent.click(within(linhaDaPosicao('2°')).getByText('premiacao.toggleHidden'));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/tournaments/t1/prizes/a2', { visible: true })
    );
  });

  it('erro ao trocar a visibilidade avisa', async () => {
    api.patch.mockRejectedValue(new Error('500'));
    await montar();
    await irLiberacao();
    await userEvent.click(within(linhaDaPosicao('1°')).getByText('premiacao.toggleVisible'));
    expect(await screen.findByText('premiacao.visibilityError')).toBeInTheDocument();
  });

  it('sem posições configuradas orienta a configurar antes', async () => {
    await montar({ resumo: { ...RESUMO, allocations: [] } });
    await irLiberacao();
    expect(screen.getByText('premiacao.configBeforeRelease')).toBeInTheDocument();
  });
});

describe('pagamento', () => {
  const irPagamentos = async () => irPara('premiacao.tabPayments');
  const abrirPagamento = async (posicao = '1°') => {
    await irPagamentos();
    await userEvent.click(within(linhaDaPosicao(posicao)).getByText('premiacao.pay'));
    return screen.findByText('premiacao.registerPayment');
  };

  it('a aba conta quantos já foram pagos', async () => {
    await montar();
    expect(within(aba('premiacao.tabPayments')).getByText('1')).toBeInTheDocument();
  });

  it('lista quem já recebeu e quem falta', async () => {
    await montar();
    await irPagamentos();
    expect(within(linhaDaPosicao('2°')).getByText('premiacao.statusPaid')).toBeInTheDocument();
    expect(within(linhaDaPosicao('1°')).getByText('premiacao.statusPending')).toBeInTheDocument();
    expect(within(linhaDaPosicao('1°')).getByText('premiacao.notAssigned')).toBeInTheDocument();
  });

  it('sem posições configuradas manda configurar antes', async () => {
    await montar({ resumo: { ...RESUMO, allocations: [] } });
    await irPagamentos();
    expect(screen.getByText('premiacao.configFirst')).toBeInTheDocument();
  });

  it('o modal mostra o saldo do pool e do caixa antes de pagar', async () => {
    // O operador precisa ver se o dinheiro existe ANTES de contar as notas.
    await montar();
    await abrirPagamento();
    const info = document.querySelector('.payout-balance-info');
    expect(info).toHaveTextContent('R$ 30000.00');
    expect(info).toHaveTextContent('R$ 50000.00');
  });

  it('saldo insuficiente é marcado como alerta', async () => {
    // 20000 de prêmio contra 5000 disponíveis: pagar aqui estoura o pool.
    await montar({ pool: { prize_pool: 40000, total_paid: 35000, available: 5000 } });
    await abrirPagamento();
    expect(document.querySelector('.payout-warn')).toBeInTheDocument();
  });

  it('saldo suficiente é marcado como ok', async () => {
    await montar();
    await abrirPagamento();
    expect(document.querySelectorAll('.payout-ok').length).toBe(2);
  });

  it('falha ao carregar os saldos não impede o pagamento', async () => {
    await montar({ pool: new Error('500') });
    await abrirPagamento();
    expect(document.querySelector('.payout-balance-info')).toBeNull();
    expect(screen.getByText('premiacao.confirmPayment')).toBeInTheDocument();
  });

  it('o documento digitado resolve QUEM é o jogador', async () => {
    // O fluxo é documento-primeiro: escolher de uma lista é como se paga o
    // prêmio para o homônimo errado.
    await montar();
    await abrirPagamento();
    await userEvent.type(screen.getByPlaceholderText('premiacao.docNumberPlaceholder'), '12345678-9');
    expect(await esperarResolvido()).toHaveTextContent('Ana');
    expect(screen.getByText('(Aninha)')).toBeInTheDocument();
  });

  it('pontuação e traços do documento são ignorados', async () => {
    // O documento no cadastro tem pontos; o operador digita como vem no papel.
    await montar();
    await abrirPagamento();
    await userEvent.type(screen.getByPlaceholderText('premiacao.docNumberPlaceholder'), '12.345.678/9');
    expect(await esperarResolvido()).toHaveTextContent('Ana');
  });

  it('documento de quem não jogou não resolve ninguém', async () => {
    // Impede pagar o prêmio a alguém que nem estava no torneio.
    await montar();
    await abrirPagamento();
    await userEvent.type(screen.getByPlaceholderText('premiacao.docNumberPlaceholder'), '00000000');
    expect(await screen.findByText('premiacao.noPlayerWithDoc')).toBeInTheDocument();
  });

  it('apagar o documento limpa o jogador resolvido', async () => {
    await montar();
    await abrirPagamento();
    const campo = screen.getByPlaceholderText('premiacao.docNumberPlaceholder');
    await userEvent.type(campo, '12345678-9');
    await esperarResolvido();
    await userEvent.clear(campo);
    await waitFor(() =>
      expect(document.querySelector('.doc-registered-banner')).toBeNull()
    );
  });

  it('confirmar envia o pagamento com documento e atendente', async () => {
    api.post.mockResolvedValue({ data: { player_name: 'Ana', paid_at: '2026-06-09T03:00:00Z' } });
    await montar();
    await abrirPagamento();
    await userEvent.type(screen.getByPlaceholderText('premiacao.docNumberPlaceholder'), '12345678-9');
    await esperarResolvido();
    await userEvent.type(screen.getByPlaceholderText('premiacao.staffNamePlaceholder'), 'Caixa 2');
    await userEvent.click(screen.getByRole('button', { name: 'premiacao.confirmPayment' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/tournaments/t1/prizes/a1/pay', {
        player_id: 'p1',
        document_type: 'national_id',
        document_number: '12345678-9',
        paid_by: 'Caixa 2',
      })
    );
    expect(toast.success).toHaveBeenCalledWith('premiacao.paymentSuccess');
  });

  it('atendente em branco vai como nulo', async () => {
    api.post.mockResolvedValue({ data: { player_name: 'Ana' } });
    await montar();
    await abrirPagamento();
    await userEvent.type(screen.getByPlaceholderText('premiacao.docNumberPlaceholder'), '12345678-9');
    await esperarResolvido();
    await userEvent.click(screen.getByRole('button', { name: 'premiacao.confirmPayment' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        '/tournaments/t1/prizes/a1/pay',
        expect.objectContaining({ paid_by: null })
      )
    );
  });

  it('o tipo de documento vem do cadastro do jogador', async () => {
    // Passaporte de um estrangeiro não pode virar "RG" no comprovante.
    api.post.mockResolvedValue({ data: { player_name: 'Beto' } });
    await montar();
    await abrirPagamento();
    await userEvent.type(screen.getByPlaceholderText('premiacao.docNumberPlaceholder'), 'xy9090');
    await esperarResolvido();
    await userEvent.click(screen.getByRole('button', { name: 'premiacao.confirmPayment' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        '/tournaments/t1/prizes/a1/pay',
        expect.objectContaining({ document_type: 'passport', player_id: 'p2' })
      )
    );
  });

  it('o comprovante sai no ato do pagamento', async () => {
    // É o papel que prova que aquele dinheiro saiu para aquela pessoa.
    api.post.mockResolvedValue({ data: { player_name: 'Ana', paid_at: '2026-06-09T03:00:00Z' } });
    await montar();
    await abrirPagamento();
    await userEvent.type(screen.getByPlaceholderText('premiacao.docNumberPlaceholder'), '12345678-9');
    await esperarResolvido();
    await userEvent.click(screen.getByRole('button', { name: 'premiacao.confirmPayment' }));
    expect(await screen.findByTestId('comprovante')).toBeInTheDocument();
    expect(screen.getByTestId('comprovante-jogador')).toHaveTextContent('Ana');
    expect(screen.getByTestId('comprovante-posicao')).toHaveTextContent('1');
    expect(screen.getByTestId('comprovante-doc')).toHaveTextContent('12345678-9');
  });

  it('erro no pagamento aparece com o motivo', async () => {
    api.post.mockRejectedValue({ response: { data: { detail: 'Prêmio não liberado' } } });
    await montar();
    await abrirPagamento();
    await userEvent.type(screen.getByPlaceholderText('premiacao.docNumberPlaceholder'), '12345678-9');
    await esperarResolvido();
    await userEvent.click(screen.getByRole('button', { name: 'premiacao.confirmPayment' }));
    expect(await screen.findByText('Prêmio não liberado')).toBeInTheDocument();
  });

  it('o comprovante de um prêmio já pago pode ser revisto', async () => {
    // O jogador volta dias depois pedindo a segunda via.
    await montar();
    await irPagamentos();
    await userEvent.click(within(linhaDaPosicao('2°')).getByText('premiacao.voucher'));
    expect(await screen.findByTestId('comprovante-jogador')).toHaveTextContent('Ana');
    expect(screen.getByTestId('comprovante-atendente')).toHaveTextContent('Caixa 1');
  });

  it('fechar o modal de pagamento não paga nada', async () => {
    await montar();
    await abrirPagamento();
    await userEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    await waitFor(() => expect(screen.queryByText('premiacao.registerPayment')).toBeNull());
    expect(api.post).not.toHaveBeenCalled();
  });

  // ── A TELA NUNCA FICA MUDA ────────────────────────────────────────────
  // Relato do dono do clube: "na hora de confirmar não acontece nada". Todo
  // caminho que interrompe o pagamento tem de dizer o que aconteceu — senão o
  // operador reclica com o campeão esperando o dinheiro no balcão.
  describe('confirmar sempre responde alguma coisa', () => {
    const confirmar = () =>
      userEvent.click(screen.getByRole('button', { name: 'premiacao.confirmPayment' }));
    const campoDoc = () => screen.getByPlaceholderText('premiacao.docNumberPlaceholder');

    it('confirmar sem documento diz qual campo falta e devolve o foco a ele', async () => {
      // Antes: `return` seco. O operador clicava e a tela não respondia nada.
      await montar();
      await abrirPagamento();
      await confirmar();
      expect(await screen.findByText('premiacao.docRequired')).toBeInTheDocument();
      expect(campoDoc()).toHaveFocus();
      expect(campoDoc()).toHaveAttribute('aria-invalid', 'true');
      expect(api.post).not.toHaveBeenCalled();
    });

    it('confirmar com documento que não é de ninguém explica o bloqueio', async () => {
      // Pagar depende de saber QUEM está recebendo; sem isso o pagamento para,
      // mas agora dizendo por quê.
      await montar();
      await abrirPagamento();
      await userEvent.type(campoDoc(), '99887766');
      await confirmar();
      expect(await screen.findByText('premiacao.docNoPlayerBlock')).toBeInTheDocument();
      expect(campoDoc()).toHaveFocus();
      expect(api.post).not.toHaveBeenCalled();
    });

    it('a recusa do servidor aparece DENTRO do modal, com o motivo dele', async () => {
      // O backend recusa por saldo do caixa geral, pool estourado, prêmio não
      // liberado. Esse texto ia para o banner da página, que fica ATRÁS do
      // modal aberto: o servidor explicava e ninguém lia.
      api.post.mockRejectedValue({
        response: { data: { detail: 'Saldo insuficiente no caixa geral.' } },
      });
      await montar();
      await abrirPagamento();
      await userEvent.type(campoDoc(), '12345678-9');
      await esperarResolvido();
      await confirmar();
      const dentro = (await screen.findByText('premiacao.registerPayment')).closest('.modal');
      await waitFor(() =>
        expect(within(dentro).getByText('Saldo insuficiente no caixa geral.')).toBeInTheDocument()
      );
      // e o modal continua aberto para o operador corrigir
      expect(screen.getByRole('button', { name: 'premiacao.confirmPayment' })).toBeInTheDocument();
    });

    it('erro sem resposta do servidor (queda de rede) também aparece no modal', async () => {
      api.post.mockRejectedValue(new Error('Network Error'));
      await montar();
      await abrirPagamento();
      await userEvent.type(campoDoc(), '12345678-9');
      await esperarResolvido();
      await confirmar();
      const dentro = (await screen.findByText('premiacao.registerPayment')).closest('.modal');
      await waitFor(() =>
        expect(within(dentro).getByText('premiacao.paymentError')).toBeInTheDocument()
      );
    });

    it('depois de uma recusa, mexer no documento limpa o erro velho', async () => {
      api.post.mockRejectedValue({ response: { data: { detail: 'Prêmio não liberado' } } });
      await montar();
      await abrirPagamento();
      await userEvent.type(campoDoc(), '12345678-9');
      await esperarResolvido();
      await confirmar();
      await screen.findByText('Prêmio não liberado');
      await userEvent.type(campoDoc(), '0');
      await waitFor(() => expect(screen.queryByText('Prêmio não liberado')).toBeNull());
    });

    it('a tela destrava depois do erro: dá para tentar de novo', async () => {
      // Estado de "processando" que não volta deixa o botão morto e o prêmio
      // sem pagar.
      api.post.mockRejectedValueOnce({ response: { data: { detail: 'Instável' } } });
      await montar();
      await abrirPagamento();
      await userEvent.type(campoDoc(), '12345678-9');
      await esperarResolvido();
      await confirmar();
      await screen.findByText('Instável');
      api.post.mockResolvedValue({ data: { player_name: 'Ana' } });
      await confirmar();
      await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
      expect(toast.success).toHaveBeenCalledWith('premiacao.paymentSuccess');
    });

    it('falha ao carregar os saldos avisa em vez de abrir o modal sem números', async () => {
      await montar({ pool: new Error('500') });
      await abrirPagamento();
      expect(screen.getByText('premiacao.balancesLoadError')).toBeInTheDocument();
    });
  });

  describe('nunca pagar duas vezes', () => {
    const enviarDuasVezes = async () => {
      const form = document.querySelector('.payout-modal form');
      // Dois envios no MESMO ciclo do React (clique duplo de verdade): os dois
      // handlers rodam antes de qualquer re-render, então uma trava por estado
      // deixaria os dois passarem.
      await act(async () => {
        fireEvent.submit(form);
        fireEvent.submit(form);
      });
    };

    it('clique duplo em confirmar paga UMA vez só', async () => {
      // Pagar o mesmo prêmio duas vezes é dinheiro que sai do caixa e não volta.
      let liberar;
      api.post.mockReturnValue(new Promise((resolve) => { liberar = resolve; }));
      await montar();
      await abrirPagamento();
      await userEvent.type(screen.getByPlaceholderText('premiacao.docNumberPlaceholder'), '12345678-9');
      await esperarResolvido();
      await enviarDuasVezes();
      expect(api.post).toHaveBeenCalledTimes(1);
      await act(async () => { liberar({ data: { player_name: 'Ana' } }); });
    });

    it('enquanto processa, o botão fica travado', async () => {
      api.post.mockReturnValue(new Promise(() => {}));
      await montar();
      await abrirPagamento();
      await userEvent.type(screen.getByPlaceholderText('premiacao.docNumberPlaceholder'), '12345678-9');
      await esperarResolvido();
      await userEvent.click(screen.getByRole('button', { name: 'premiacao.confirmPayment' }));
      const botao = await screen.findByRole('button', { name: 'premiacao.processing' });
      expect(botao).toBeDisabled();
    });
  });

  describe('prêmio ainda não liberado', () => {
    // O servidor só paga prêmio liberado. Sem aviso, o operador conta as notas,
    // confirma e leva uma recusa que não esperava — com o jogador na frente.
    const NAO_LIBERADO = {
      ...RESUMO,
      allocations: [{ id: 'a7', position: 4, prize_amount: 1000, released: false, paid: false }],
    };

    it('avisa antes de o operador contar o dinheiro', async () => {
      await montar({ resumo: NAO_LIBERADO });
      await abrirPagamento('4°');
      expect(screen.getByText('premiacao.payoutNotReleasedWarn')).toBeInTheDocument();
    });

    it('backend antigo, sem o campo released, não gera alarme falso', async () => {
      // Deploy não é atômico: enquanto o backend velho não responde o campo,
      // avisar sempre treinaria o operador a ignorar o aviso.
      await montar({
        resumo: { ...RESUMO, allocations: [{ id: 'a7', position: 4, prize_amount: 1000, paid: false }] },
      });
      await abrirPagamento('4°');
      expect(screen.queryByText('premiacao.payoutNotReleasedWarn')).toBeNull();
    });
  });

  describe('documento do recibo', () => {
    // O documento impresso no comprovante é a prova de quem levou o dinheiro.
    const DOC_PODRE = [
      { id: 'p1', name: 'Ana', document_type: 'cpf', document_number: '111.111.111-11' },
      { id: 'p2', name: 'Beto', document_type: 'passport', document_number: 'XY9090' },
    ];

    it('documento do cadastro fora do padrão vira aviso na hora de pagar', async () => {
      // "Um monte de 1" fecha a conta do dígito verificador do CPF; sem esse
      // aviso o recibo sai com um documento que não prova nada.
      await montar({ jogadores: DOC_PODRE });
      await abrirPagamento();
      await userEvent.type(screen.getByPlaceholderText('premiacao.docNumberPlaceholder'), '11111111111');
      await esperarResolvido();
      const aviso = document.querySelector('.payout-warning-msg');
      expect(aviso).toHaveTextContent('premiacao.docRegisteredInvalid');
      expect(aviso).toHaveTextContent('documents.errorRepeated');
    });

    it('o tipo do documento sai com rótulo, não com o código do banco', async () => {
      // "cpf" é nome de campo do banco. O rótulo vem do catálogo de
      // utils/documentos.js — o mapa fixo que havia aqui só conhecia
      // passaporte, identidade e CNH.
      await montar({ jogadores: DOC_PODRE });
      await abrirPagamento();
      await userEvent.type(screen.getByPlaceholderText('premiacao.docNumberPlaceholder'), '11111111111');
      const banner = await esperarResolvido();
      expect(banner).toHaveTextContent('documents.typeCpf');
      expect(banner).not.toHaveTextContent('— cpf');
    });

    it('o aviso NÃO trava o pagamento — quem recusa é o servidor', async () => {
      // Travar aqui deixaria o campeão sem receber por causa de cadastro antigo.
      api.post.mockResolvedValue({ data: { player_name: 'Ana' } });
      await montar({ jogadores: DOC_PODRE });
      await abrirPagamento();
      await userEvent.type(screen.getByPlaceholderText('premiacao.docNumberPlaceholder'), '11111111111');
      await esperarResolvido();
      await userEvent.click(screen.getByRole('button', { name: 'premiacao.confirmPayment' }));
      await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    });

    it('documento em ordem não gera aviso nenhum', async () => {
      await montar({ jogadores: DOC_PODRE });
      await abrirPagamento();
      await userEvent.type(screen.getByPlaceholderText('premiacao.docNumberPlaceholder'), 'XY9090');
      await esperarResolvido();
      expect(document.querySelector('.payout-warning-msg')).toBeNull();
    });

    it('trocar o documento apaga o aviso do jogador anterior', async () => {
      await montar({ jogadores: DOC_PODRE });
      await abrirPagamento();
      const campo = screen.getByPlaceholderText('premiacao.docNumberPlaceholder');
      await userEvent.type(campo, '11111111111');
      await esperarResolvido();
      await userEvent.clear(campo);
      await userEvent.type(campo, 'XY9090');
      await waitFor(() => expect(document.querySelector('.payout-warning-msg')).toBeNull());
    });
  });
});

describe('motivo da recusa', () => {
  it('recusa com código mostra a frase traduzida (userMessage), não o objeto', async () => {
    // O servidor manda {code, message}; o interceptor da API traduz para o
    // idioma da tela. Antes a tela mostrava o texto genérico.
    api.patch.mockRejectedValue({
      response: { data: { detail: { code: 'reserva_acima_do_pool', message: 'x' } } },
      userMessage: 'La reserva supera el pozo.',
    });
    await montar();
    await irPara('premiacao.reservedPrize');
    await userEvent.click(screen.getByRole('button', { name: 'common.save' }));
    expect(await screen.findByText('La reserva supera el pozo.')).toBeInTheDocument();
  });

  it('sem resposta do servidor (rede) fica o texto da tela', async () => {
    api.patch.mockRejectedValue({ message: 'Network Error', userMessage: 'Network Error' });
    await montar();
    await irPara('premiacao.reservedPrize');
    await userEvent.click(screen.getByRole('button', { name: 'common.save' }));
    expect(await screen.findByText('premiacao.reservedSaveError')).toBeInTheDocument();
  });
});

describe('premiação por eliminação (KO)', () => {
  const TORNEIO_PKO = { id: 't1', name: 'START UP PKO', ko_format: 'pko', ko_percentage: 40 };
  const RESUMO_PKO = {
    ...RESUMO, ko_format: 'pko', ko_percentage: '40', net_pool: '10000', ko_pool: '4000', player_pool: '6000',
  };
  const RESUMO_KO = {
    tournament_id: 't1', ko_format: 'pko', closed_at: null, ko_pool: '4000', paid: '0', pending: '0',
    unclaimed: '0', bounties: [], knockouts: [], mystery: null,
  };

  const montarKo = async () => {
    responder({ torneio: TORNEIO_PKO, resumo: RESUMO_PKO });
    const base = api.get.getMockImplementation();
    api.get.mockImplementation((url, ...resto) => (
      url === '/tournaments/t1/knockouts/summary' ? Promise.resolve({ data: RESUMO_KO }) : base(url, ...resto)
    ));
    render(<MemoryRouter><Premiacao /></MemoryRouter>);
    await waitFor(() => expect(screen.queryByText('common.loading')).toBeNull());
  };

  it('torneio sem KO não tem a aba', async () => {
    await montar();
    expect(screen.queryByRole('button', { name: /^ko\.tab_/ })).toBeNull();
  });

  it('a configuração mostra a divisão: pool KO e o das posições', async () => {
    await montarKo();
    const card = document.querySelector('.ko-pool-card');
    expect(card).not.toBeNull();
    expect(within(card).getByText('R$ 4000.00')).toBeInTheDocument();
    expect(screen.getByText(/^ko\.positionsAfterKo:R\$ 10000\.00/)).toBeInTheDocument();
  });

  it('a aba KO abre o painel de pagamentos', async () => {
    await montarKo();
    // A aba leva o nome do formato do torneio (aqui, PKO).
    await userEvent.click(screen.getByRole('button', { name: 'ko.tab_pko' }));
    expect(await screen.findByText('ko.pendingPayments')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/tournaments/t1/knockouts/summary');
  });
});

describe('torneio Mystery: aba e rótulos com o nome do formato', () => {
  it('a aba se chama Mystery e o card mostra o Pool Mystery', async () => {
    responder({
      torneio: { id: 't1', name: 'MISTERY', ko_format: 'mystery', ko_percentage: 40 },
      resumo: { ...RESUMO, ko_format: 'mystery', ko_percentage: '40', net_pool: '5412', ko_pool: '2640', player_pool: '2772' },
    });
    render(<MemoryRouter><Premiacao /></MemoryRouter>);
    await waitFor(() => expect(screen.queryByText('common.loading')).toBeNull());
    expect(screen.getByRole('button', { name: 'ko.tab_mystery' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ko.tab_ko' })).toBeNull();
    expect(within(document.querySelector('.ko-pool-card')).getByText('ko.poolMystery')).toBeInTheDocument();
  });
});

it('na aba Pagos, um torneio Mystery aponta para a aba Mystery', async () => {
  responder({
    torneio: { id: 't1', name: 'MISTERY', ko_format: 'mystery', ko_percentage: 40 },
    resumo: { ...RESUMO, ko_format: 'mystery', ko_pool: '3520', net_pool: '6000', player_pool: '2480' },
  });
  const base = api.get.getMockImplementation();
  api.get.mockImplementation((url, ...resto) => (
    url === '/tournaments/t1/knockouts/summary'
      ? Promise.resolve({ data: { tournament_id: 't1', ko_format: 'mystery', ko_pool: '3520', paid: '0', pending: '0', unclaimed: '0', manual_total: '0', bounties: [], knockouts: [], mystery: { started_at: null, envelopes_total: 0, envelopes_remaining: 0, remaining: [] } } })
      : base(url, ...resto)
  ));
  render(<MemoryRouter><Premiacao /></MemoryRouter>);
  await waitFor(() => expect(screen.queryByText('common.loading')).toBeNull());
  await irPara('premiacao.tabPayments');
  expect(screen.getByText(/^ko\.paymentsTabHint/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /^ko\.goToTab/ }));
  expect(await screen.findByText('ko.manualTitle')).toBeInTheDocument();
});
