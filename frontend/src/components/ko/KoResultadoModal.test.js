/**
 * Depois da eliminação num torneio KO: o que ela gerou e o pagamento na hora.
 * Fechar sem pagar não perde nada — fica pendente na aba KO da Premiação.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import KoResultadoModal from './KoResultadoModal';
import api from '../../config/api';
import { imprimirBilheteKo } from './bilheteKo';

jest.mock('../../config/api', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('./bilheteKo', () => ({ imprimirBilheteKo: jest.fn() }));
jest.mock('../../contexts/CurrencyContext', () => ({
  useCurrency: () => ({ formatCurrency: (v) => `S/ ${Number(v).toFixed(2)}` }),
}));
jest.mock('react-i18next', () => {
  const t = (chave, vars) =>
    vars && typeof vars === 'object' ? `${chave}:${Object.values(vars).join(',')}` : chave;
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const KO = {
  id: 'k1', format: 'pko', eliminated_name: 'Zeca', bounty_value: '100.00',
  payouts: [
    { id: 'po1', eliminator_player_id: 'p1', eliminator_name: 'Ana', cash_amount: '50.00', added_to_bounty: '50.00', paid: false },
  ],
};

const abrir = (props = {}) => {
  const onFechar = jest.fn();
  const onPago = jest.fn();
  render(<KoResultadoModal tournamentId="t1" knockout={KO} torneioNome="START UP PKO"
    assentoDoJogador={() => ({ mesa: 2, assento: 5 })} onFechar={onFechar} onPago={onPago} {...props} />);
  return { onFechar, onPago };
};

beforeEach(() => {
  api.post.mockReset();
  imprimirBilheteKo.mockReset();
});

it('mostra quem recebe, o dinheiro e o que somou no bounty', () => {
  abrir();
  expect(screen.getByText('Ana')).toBeInTheDocument();
  expect(screen.getByText('S/ 50.00')).toBeInTheDocument();
  expect(screen.getByText(/ko.addedToBounty:S\/ 50.00/)).toBeInTheDocument();
});

it('"Pagar agora" paga pelo caixa geral e marca como pago', async () => {
  api.post.mockResolvedValue({ data: {} });
  const { onPago } = abrir();
  await userEvent.click(screen.getByRole('button', { name: 'ko.payNow' }));
  expect(api.post).toHaveBeenCalledWith('/tournaments/t1/knockouts/payouts/po1/pay', {});
  expect(await screen.findByText('ko.paid')).toBeInTheDocument();
  expect(onPago).toHaveBeenCalled();
});

it('recusa (sem saldo no caixa geral) aparece com o motivo', async () => {
  api.post.mockRejectedValue({ userMessage: 'Saldo insuficiente no caixa geral.' });
  abrir();
  await userEvent.click(screen.getByRole('button', { name: 'ko.payNow' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Saldo insuficiente no caixa geral.');
  expect(screen.getByRole('button', { name: 'ko.payNow' })).toBeEnabled();
});

it('imprime o bilhete com mesa e assento de quem recebe', async () => {
  abrir();
  await userEvent.click(screen.getByRole('button', { name: 'ko.printTicket' }));
  expect(imprimirBilheteKo).toHaveBeenCalledWith(expect.objectContaining({
    jogador: 'Ana', mesa: 2, assento: 5, valor: 50, vitima: 'Zeca', torneio: 'START UP PKO',
  }));
});

it('sem eliminador: avisa que o valor fica para o campeão', () => {
  abrir({ knockout: { ...KO, payouts: [] } });
  expect(screen.getByText('ko.keptForChampion')).toBeInTheDocument();
});

it('Mystery mostra o envelope sorteado', () => {
  abrir({ knockout: { ...KO, format: 'mystery' } });
  expect(screen.getByText('ko.envelopeDrawnTitle')).toBeInTheDocument();
  expect(screen.getByText('ko.pendingNoteMystery')).toBeInTheDocument();
  expect(screen.getByText(/ko.envelopeValue:S\/ 100.00/)).toBeInTheDocument();
});

it('fechar sem pagar', async () => {
  const { onFechar } = abrir();
  await userEvent.click(screen.getAllByRole('button', { name: 'common.close' })[1]);
  await waitFor(() => expect(onFechar).toHaveBeenCalled());
  expect(api.post).not.toHaveBeenCalled();
});
