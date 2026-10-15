/**
 * Aba KO da Premiação: onde o caixa paga o que ficou pendente, o floor
 * corrige quem eliminou, inicia a fase Mystery e encerra os bounties.
 *
 * O dinheiro sai do CAIXA GERAL — sem sangria não há saldo, e a tela avisa
 * antes do caixa tentar pagar.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import KoTab from './KoTab';
import api from '../../config/api';
import { useToast } from '../../contexts/ToastContext';
import { imprimirBilheteKo } from '../ko/bilheteKo';

jest.mock('../../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock('../ko/bilheteKo', () => ({ imprimirBilheteKo: jest.fn() }));
jest.mock('../../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../../contexts/CurrencyContext', () => ({
  useCurrency: () => ({ formatCurrency: (v) => `S/ ${Number(v).toFixed(2)}` }),
}));
jest.mock('react-i18next', () => {
  const t = (chave, vars) =>
    vars && typeof vars === 'object' ? `${chave}:${Object.values(vars).join(',')}` : chave;
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const INSCRITOS = [
  { id: 'tp-a', player_id: 'p-a', player_name: 'Ana', status: 'active' },
  { id: 'tp-b', player_id: 'p-b', player_name: 'Bruno', status: 'active' },
  { id: 'tp-z', player_id: 'p-z', player_name: 'Zeca', status: 'eliminated' },
];

const payout = (id, nome, valor, extra = {}) => ({
  id, knockout_id: 'k1', eliminator_tp_id: `tp-${nome[0].toLowerCase()}`, eliminator_player_id: `p-${nome[0].toLowerCase()}`,
  eliminator_name: nome, cash_amount: valor, added_to_bounty: '0', paid: false, ...extra,
});

const RESUMO_PKO = {
  tournament_id: 't1', ko_format: 'pko', ko_percentage: '40', closed_at: null,
  ko_pool: '400.00', paid: '0.00', pending: '50.00', unclaimed: '0.00',
  bounties: [
    { tournament_player_id: 'tp-a', player_name: 'Ana', bounty: '150.00' },
    { tournament_player_id: 'tp-b', player_name: 'Bruno', bounty: '100.00' },
  ],
  knockouts: [{
    id: 'k1', kind: 'elimination', format: 'pko', status: 'active', eliminated_tp_id: 'tp-z',
    eliminated_name: 'Zeca', bounty_value: '100.00', payouts: [payout('po1', 'Ana', '50.00')],
  }],
  mystery: null,
};

let toast;
let confirmar;

const responder = ({ resumo = RESUMO_PKO, saldo = 1000 } = {}) => {
  api.get.mockImplementation((url) => {
    if (url === '/tournaments/t1/knockouts/summary') return Promise.resolve({ data: resumo });
    if (url === '/cash/general') return Promise.resolve({ data: { current_balance: saldo } });
    return Promise.resolve({ data: {} });
  });
};

const montar = async (opcoes = {}, props = {}) => {
  responder(opcoes);
  const onMudou = jest.fn();
  render(<KoTab tournamentId="t1" torneio={{ id: 't1', name: 'START UP PKO' }} inscritos={INSCRITOS} onMudou={onMudou} {...props} />);
  await screen.findByText('ko.currentBounties');
  return { onMudou };
};

beforeEach(() => {
  jest.clearAllMocks();
  toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn(), info: jest.fn() };
  confirmar = jest.fn().mockResolvedValue(true);
  useToast.mockReturnValue({ toast, confirm: confirmar });
  api.post.mockResolvedValue({ data: {} });
  api.patch.mockResolvedValue({ data: {} });
  api.delete.mockResolvedValue({ data: {} });
});

it('mostra o pool KO, o pendente e o bounty de cada jogador vivo', async () => {
  await montar();
  expect(screen.getByText('S/ 400.00')).toBeInTheDocument();
  const bounties = screen.getByRole('region', { name: 'ko.currentBounties' });
  expect(within(bounties).getByText('Ana')).toBeInTheDocument();
  expect(within(bounties).getByText('S/ 150.00')).toBeInTheDocument();
});

it('pagar um KO pendente debita do caixa geral e recarrega', async () => {
  const { onMudou } = await montar();
  const pendentes = screen.getByRole('region', { name: 'ko.pendingPayments' });
  await userEvent.click(within(pendentes).getByRole('button', { name: 'ko.pay' }));
  expect(api.post).toHaveBeenCalledWith('/tournaments/t1/knockouts/payouts/po1/pay', {});
  await waitFor(() => expect(toast.success).toHaveBeenCalled());
  expect(onMudou).toHaveBeenCalled();
});

it('com vários pendentes, "Pagar todos" vai num lote só', async () => {
  const resumo = {
    ...RESUMO_PKO,
    pending: '100.00',
    knockouts: [{
      ...RESUMO_PKO.knockouts[0],
      payouts: [payout('po1', 'Ana', '25.00'), payout('po2', 'Bruno', '25.00')],
    }],
  };
  await montar({ resumo });
  await userEvent.click(screen.getByRole('button', { name: 'ko.payAll' }));
  expect(api.post).toHaveBeenCalledWith('/tournaments/t1/knockouts/payouts/pay-batch', { payout_ids: ['po1', 'po2'] });
});

it('saldo do caixa geral menor que o pendente pede sangria', async () => {
  await montar({ saldo: 20 });
  expect(screen.getByText('ko.needSangria')).toBeInTheDocument();
});

it('recusa do servidor aparece com o motivo', async () => {
  api.post.mockRejectedValue({ userMessage: 'Saldo insuficiente no caixa geral.' });
  await montar();
  const pendentes = screen.getByRole('region', { name: 'ko.pendingPayments' });
  await userEvent.click(within(pendentes).getByRole('button', { name: 'ko.pay' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Saldo insuficiente no caixa geral.');
});

it('imprime o bilhete de quem recebe', async () => {
  await montar();
  await userEvent.click(screen.getByRole('button', { name: 'ko.printTicket' }));
  expect(imprimirBilheteKo).toHaveBeenCalledWith(expect.objectContaining({ jogador: 'Ana', valor: 50, vitima: 'Zeca' }));
});

it('corrige o eliminador de um KO ainda não pago', async () => {
  await montar();
  await userEvent.click(screen.getByRole('button', { name: 'ko.fixEliminator' }));
  const dialogo = screen.getByRole('dialog');
  // A vítima não aparece entre os candidatos; quem estava marcado vem marcado.
  expect(within(dialogo).queryByText('Zeca')).toBeNull();
  expect(within(dialogo).getByRole('checkbox', { name: /Ana/ })).toBeChecked();
  await userEvent.click(within(dialogo).getByRole('checkbox', { name: /Ana/ }));
  await userEvent.click(within(dialogo).getByRole('checkbox', { name: /Bruno/ }));
  await userEvent.click(within(dialogo).getByRole('button', { name: 'ko.saveFix' }));
  expect(api.patch).toHaveBeenCalledWith('/tournaments/t1/knockouts/k1/eliminators', {
    eliminated_by: ['tp-b'], no_eliminator: false,
  });
});

it('encerra os bounties com o campeão escolhido', async () => {
  await montar();
  const botao = screen.getByRole('button', { name: 'ko.closeButton' });
  expect(botao).toBeDisabled();
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'ko.champion' }), 'tp-a');
  // Só os vivos podem ser campeão.
  expect(screen.queryByRole('option', { name: 'Zeca' })).toBeNull();
  await userEvent.click(botao);
  expect(confirmar).toHaveBeenCalled();
  expect(api.post).toHaveBeenCalledWith('/tournaments/t1/knockouts/close', { champion_tp_id: 'tp-a' });
});

it('encerrado: oferece desfazer', async () => {
  await montar({ resumo: { ...RESUMO_PKO, closed_at: '2026-10-14T23:00:00Z' } });
  await userEvent.click(screen.getByRole('button', { name: 'ko.undoClose' }));
  expect(api.delete).toHaveBeenCalledWith('/tournaments/t1/knockouts/close');
});

describe('Mystery', () => {
  const RESUMO_MYSTERY = {
    ...RESUMO_PKO, ko_format: 'mystery', ko_pool: '300.00', pending: '0.00', bounties: [], knockouts: [],
    mystery: { started_at: null, envelopes_total: 0, envelopes_remaining: 0, remaining: [] },
  };

  const montarMystery = async (resumo = RESUMO_MYSTERY) => {
    responder({ resumo });
    render(<KoTab tournamentId="t1" torneio={{ id: 't1' }} inscritos={INSCRITOS} />);
    await screen.findByText('ko.mysteryPhase');
  };

  it('só inicia quando a soma fecha o pool e não passa de um envelope por jogador vivo', async () => {
    await montarMystery();
    const iniciar = screen.getByRole('button', { name: 'ko.startMystery' });
    expect(iniciar).toBeDisabled();
    const [valor] = screen.getAllByRole('spinbutton', { name: 'ko.envelopeValueLabel' });
    const [qtd] = screen.getAllByRole('spinbutton', { name: 'ko.envelopeQtyLabel' });
    await userEvent.type(valor, '100');
    await userEvent.type(qtd, '2');
    // 2 vivos, soma 200 de 300: ainda não fecha.
    expect(iniciar).toBeDisabled();
    await userEvent.clear(valor);
    await userEvent.type(valor, '150');
    expect(iniciar).toBeEnabled();
    await userEvent.click(iniciar);
    expect(confirmar).toHaveBeenCalled();
    expect(api.post).toHaveBeenCalledWith('/tournaments/t1/mystery/start', {
      envelopes: [{ value: 150, quantity: 2 }],
    });
  });

  it('menos envelopes que jogadores vivos vale (um envelope por prêmio)', async () => {
    await montarMystery();
    const [valor] = screen.getAllByRole('spinbutton', { name: 'ko.envelopeValueLabel' });
    const [qtd] = screen.getAllByRole('spinbutton', { name: 'ko.envelopeQtyLabel' });
    // 2 vivos, 1 envelope com o pool inteiro.
    await userEvent.type(valor, '300');
    await userEvent.type(qtd, '1');
    expect(screen.getByRole('button', { name: 'ko.startMystery' })).toBeEnabled();
  });

  it('mais envelopes que jogadores vivos não inicia', async () => {
    await montarMystery();
    const [valor] = screen.getAllByRole('spinbutton', { name: 'ko.envelopeValueLabel' });
    const [qtd] = screen.getAllByRole('spinbutton', { name: 'ko.envelopeQtyLabel' });
    await userEvent.type(valor, '100');
    await userEvent.type(qtd, '3');
    expect(screen.getByRole('button', { name: 'ko.startMystery' })).toBeDisabled();
  });

  it('com valores diferentes, cada linha vira um grupo de envelopes', async () => {
    await montarMystery();
    await userEvent.click(screen.getByRole('button', { name: 'ko.addEnvelope' }));
    const valores = screen.getAllByRole('spinbutton', { name: 'ko.envelopeValueLabel' });
    const qtds = screen.getAllByRole('spinbutton', { name: 'ko.envelopeQtyLabel' });
    await userEvent.type(valores[0], '200');
    await userEvent.type(qtds[0], '1');
    await userEvent.type(valores[1], '100');
    await userEvent.type(qtds[1], '1');
    await userEvent.click(screen.getByRole('button', { name: 'ko.startMystery' }));
    expect(api.post).toHaveBeenCalledWith('/tournaments/t1/mystery/start', {
      envelopes: [{ value: 200, quantity: 1 }, { value: 100, quantity: 1 }],
    });
  });

  it('fala de envelopes, não de bounties', async () => {
    await montarMystery();
    expect(screen.getByText('ko.poolMystery')).toBeInTheDocument();
    expect(screen.getByText('ko.historyMystery')).toBeInTheDocument();
    expect(screen.getByText('ko.noEnvelopesDrawn')).toBeInTheDocument();
    expect(screen.getByText('ko.closeHintMystery')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ko.closeTitleMystery' })).toBeInTheDocument();
    expect(screen.queryByText('ko.currentBounties')).toBeNull();
    expect(screen.queryByText(/ko\.closeButton/)).toBeNull();
  });

  it('fase iniciada: mostra os envelopes restantes e, sem sorteio ainda, deixa desfazer', async () => {
    await montarMystery({
      ...RESUMO_MYSTERY,
      mystery: {
        started_at: '2026-10-14T22:00:00Z', envelopes_total: 2, envelopes_remaining: 2,
        remaining: [{ value: '200.00', count: 1 }, { value: '100.00', count: 1 }],
      },
    });
    expect(screen.getByText('1 × S/ 200.00')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'ko.undoMystery' }));
    expect(api.delete).toHaveBeenCalledWith('/tournaments/t1/mystery/start');
  });
});

describe('prêmio Mystery registrado à mão', () => {
  // MISTERY do NSOP: envelopes abertos na mesa sem a fase iniciada no
  // sistema. O clube registra quem recebeu e quanto; o caixa paga depois.
  const BASE = {
    tournament_id: 't1', ko_format: 'mystery', closed_at: null, ko_pool: '3520.00',
    paid: '0.00', pending: '0.00', unclaimed: '0.00', manual_total: '0.00', bounties: [], knockouts: [],
    mystery: { started_at: null, envelopes_total: 0, envelopes_remaining: 0, remaining: [] },
  };
  const montarManual = async (resumo = BASE) => {
    responder({ resumo });
    render(<KoTab tournamentId="t1" torneio={{ id: 't1' }} inscritos={INSCRITOS} />);
    await screen.findByText('ko.manualTitle');
  };
  const campo = (nome) => screen.getByLabelText(nome);

  it('registra quem recebeu, o valor e (opcional) quem caiu', async () => {
    await montarManual();
    const botao = screen.getByRole('button', { name: 'ko.manualRegister' });
    expect(botao).toBeDisabled();
    await userEvent.selectOptions(campo('ko.manualRecipient'), 'tp-a');
    await userEvent.type(campo('ko.manualValue'), '2000');
    await userEvent.selectOptions(campo('ko.manualVictim'), 'tp-z');
    // Quem recebe não aparece como eliminado.
    expect(within(campo('ko.manualVictim')).queryByRole('option', { name: 'Ana' })).toBeNull();
    await userEvent.click(botao);
    expect(api.post).toHaveBeenCalledWith('/tournaments/t1/knockouts/manual', {
      recipient_tp_id: 'tp-a', value: 2000, eliminated_tp_id: 'tp-z',
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('ko.manualRegistered'));
  });

  it('não deixa passar do que sobra no pool', async () => {
    await montarManual({ ...BASE, pending: '3000.00', manual_total: '3000.00' });
    expect(screen.getByText(/ko.manualAvailable:S\/ 520.00/)).toBeInTheDocument();
    await userEvent.selectOptions(campo('ko.manualRecipient'), 'tp-b');
    await userEvent.type(campo('ko.manualValue'), '600');
    expect(screen.getByRole('button', { name: 'ko.manualRegister' })).toBeDisabled();
  });

  it('com o registro à mão, os envelopes miram o que sobrou do pool', async () => {
    await montarManual({ ...BASE, pending: '3000.00', manual_total: '3000.00' });
    expect(screen.getByTestId('ko-conferencia')).toHaveTextContent('S/ 520.00');
  });

  it('o prêmio manual pendente pode ser desfeito; o pago não', async () => {
    const manual = (id, paid) => ({
      id, kind: 'manual', format: 'mystery', status: 'active', eliminated_tp_id: null, eliminated_name: null,
      bounty_value: '1000.00',
      payouts: [{ id: `po-${id}`, eliminator_tp_id: 'tp-b', eliminator_name: 'Bruno', cash_amount: '1000.00', added_to_bounty: '0', paid }],
    });
    await montarManual({ ...BASE, pending: '1000.00', paid: '1000.00', manual_total: '2000.00', knockouts: [manual('m1', false), manual('m2', true)] });
    expect(screen.getAllByText('ko.manualRow').length).toBeGreaterThan(0);
    const desfazer = screen.getAllByRole('button', { name: 'ko.manualUndo' });
    expect(desfazer).toHaveLength(1);
    await userEvent.click(desfazer[0]);
    expect(api.delete).toHaveBeenCalledWith('/tournaments/t1/knockouts/manual/m1');
  });

  it('com a fase iniciada no sistema, o registro manual some', async () => {
    responder({ resumo: { ...BASE, mystery: { started_at: '2026-10-14T22:00:00Z', envelopes_total: 3, envelopes_remaining: 3, remaining: [] } } });
    render(<KoTab tournamentId="t1" torneio={{ id: 't1' }} inscritos={INSCRITOS} />);
    await screen.findByText('ko.mysteryPhase');
    expect(screen.queryByText('ko.manualTitle')).toBeNull();
  });
});
