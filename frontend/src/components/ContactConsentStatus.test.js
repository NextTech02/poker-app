import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ContactConsentStatus from './ContactConsentStatus';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { post: jest.fn() },
}));
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (chave, padrao, vars) => {
      if (typeof padrao !== 'string') return chave;
      return padrao.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars ? vars[k] : ''));
    },
  }),
}));

const JOGADOR = { id: 'p1', email: 'ana@exemplo.com', contact_consent: 'pending' };
let toast;

beforeEach(() => {
  jest.clearAllMocks();
  toast = { success: jest.fn(), error: jest.fn() };
  useToast.mockReturnValue({ toast });
});

it.each([
  ['granted', 'Contatos autorizados'],
  ['denied', 'Contatos recusados'],
  ['pending', 'Aguardando autorização'],
  [null, 'Autorização não pedida'],
])('status %s mostra "%s"', (status, texto) => {
  render(<ContactConsentStatus player={{ ...JOGADOR, contact_consent: status }} />);
  expect(screen.getByText(texto)).toBeInTheDocument();
});

it('quem já respondeu não recebe botão de reenvio', () => {
  render(<ContactConsentStatus player={{ ...JOGADOR, contact_consent: 'denied' }} />);
  expect(screen.queryByRole('button')).toBeNull();
});

it('na lista (compact) mostra só o selo', () => {
  render(<ContactConsentStatus player={JOGADOR} compact />);
  expect(screen.queryByRole('button')).toBeNull();
});

it('reenviar chama a API e avisa', async () => {
  api.post.mockResolvedValue({ data: { sent: true, contact_consent: 'pending' } });
  const onChange = jest.fn();
  render(<ContactConsentStatus player={JOGADOR} onChange={onChange} />);
  await userEvent.click(screen.getByRole('button', { name: 'Reenviar pedido' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/players/p1/consent/resend'));
  expect(toast.success).toHaveBeenCalledWith('Pedido de autorização enviado para ana@exemplo.com');
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ contact_consent: 'pending' }));
});

it('recusa do servidor vira toast de erro', async () => {
  api.post.mockRejectedValue({ userMessage: 'O pedido acabou de ser enviado.' });
  render(<ContactConsentStatus player={JOGADOR} />);
  await userEvent.click(screen.getByRole('button', { name: 'Reenviar pedido' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('O pedido acabou de ser enviado.'));
});
