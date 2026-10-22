/**
 * KO × FIADO: o eliminador que deve recebe o líquido, e o abatimento vai
 * explícito no pagamento (o servidor recusa o pagamento de devedor sem ele).
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import KoResultadoModal from './KoResultadoModal';
import api from '../../config/api';

jest.mock('../../config/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
jest.mock('../../contexts/CurrencyContext', () => ({
  useCurrency: () => ({ formatCurrency: (v) => `R$ ${Number(v || 0).toFixed(2)}` }),
}));
jest.mock('./bilheteKo', () => ({ imprimirBilheteKo: jest.fn() }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'pt-BR' },
    t: (chave, padrao, vars) => {
      const texto = typeof padrao === 'string' ? padrao : (padrao?.defaultValue || chave);
      const valores = typeof padrao === 'object' ? padrao : vars;
      return texto.replace(/\{\{(\w+)\}\}/g, (_, k) => (valores ? valores[k] : ''));
    },
  }),
}));

const KO = {
  id: 'k1', format: 'fixed', status: 'active', eliminated_name: 'Zé',
  payouts: [{ id: 'po1', eliminator_player_id: 'p2', eliminator_name: 'Ana', cash_amount: 50, added_to_bounty: 0, paid: false }],
};

beforeEach(() => {
  jest.clearAllMocks();
  api.post.mockResolvedValue({ data: {} });
});

it('eliminador devedor: mostra o líquido e manda o abatimento', async () => {
  api.get.mockResolvedValue({ data: [{ player_id: 'p2', balance: 20 }] });
  render(<KoResultadoModal tournamentId="t1" knockout={KO} onFechar={() => {}} />);
  expect(await screen.findByText('Fiado: abate R$ 20.00 · paga R$ 30.00')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Pagar agora' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith(
    '/tournaments/t1/knockouts/payouts/po1/pay', { debt_offset_amount: 20 },
  ));
});

it('sem dívida o pagamento sai como sempre', async () => {
  api.get.mockResolvedValue({ data: [] });
  render(<KoResultadoModal tournamentId="t1" knockout={KO} onFechar={() => {}} />);
  await waitFor(() => expect(api.get).toHaveBeenCalled());
  await userEvent.click(screen.getByRole('button', { name: 'Pagar agora' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/tournaments/t1/knockouts/payouts/po1/pay', {}));
});
