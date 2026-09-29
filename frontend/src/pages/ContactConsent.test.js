/**
 * Página PÚBLICA do consentimento de contatos (LGPD).
 *
 * O que os testes travam:
 * 1. Autorizar e recusar mandam a resposta pelo token do link.
 * 2. Recusar é tão fácil quanto autorizar (dois botões, lado a lado).
 * 3. Link já respondido, vencido ou inválido não oferece os botões.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ContactConsent from './ContactConsent';
import api from '../config/api';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() },
}));
jest.mock('../components/LanguageSelector', () => () => <div data-testid="lang" />);
jest.mock('react-router-dom', () => ({ useParams: () => ({ token: 'tok-123' }) }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (chave, padrao, vars) => {
      if (typeof padrao !== 'string') return chave;
      return padrao.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars ? vars[k] : ''));
    },
  }),
}));

const PEDIDO = {
  organization_name: 'Clube Royal', player_first_name: 'Ana',
  status: 'pending', used: false, expired: false,
};

beforeEach(() => {
  jest.clearAllMocks();
});

it('mostra o clube e o primeiro nome, com os dois botões', async () => {
  api.get.mockResolvedValue({ data: PEDIDO });
  render(<ContactConsent />);
  expect(await screen.findByText('Olá, Ana!')).toBeInTheDocument();
  expect(screen.getByText(/O Clube Royal pode enviar a você novidades/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Sim, autorizo' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Não autorizo' })).toBeEnabled();
  expect(api.get).toHaveBeenCalledWith('/public/consent/tok-123', expect.anything());
});

it('autorizar envia accept=true e confirma', async () => {
  api.get.mockResolvedValue({ data: PEDIDO });
  api.post.mockResolvedValue({ data: { status: 'granted' } });
  render(<ContactConsent />);
  await userEvent.click(await screen.findByRole('button', { name: 'Sim, autorizo' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith(
    '/public/consent/tok-123', { accept: true }, expect.anything(),
  ));
  expect(await screen.findByText('Obrigado! Contatos autorizados.')).toBeInTheDocument();
});

it('recusar envia accept=false e confirma', async () => {
  api.get.mockResolvedValue({ data: PEDIDO });
  api.post.mockResolvedValue({ data: { status: 'denied' } });
  render(<ContactConsent />);
  await userEvent.click(await screen.findByRole('button', { name: 'Não autorizo' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith(
    '/public/consent/tok-123', { accept: false }, expect.anything(),
  ));
  expect(await screen.findByText(/Você não receberá contatos promocionais/)).toBeInTheDocument();
});

it('pedido já respondido mostra a resposta, sem botões', async () => {
  api.get.mockResolvedValue({ data: { ...PEDIDO, status: 'granted', used: true } });
  render(<ContactConsent />);
  expect(await screen.findByText('Obrigado! Contatos autorizados.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Sim, autorizo' })).toBeNull();
});

it('link vencido pede um novo ao clube', async () => {
  api.get.mockResolvedValue({ data: { ...PEDIDO, expired: true } });
  render(<ContactConsent />);
  expect(await screen.findByText('Este link expirou')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Não autorizo' })).toBeNull();
});

it('token desconhecido é link inválido', async () => {
  api.get.mockRejectedValue({ response: { status: 404 } });
  render(<ContactConsent />);
  expect(await screen.findByText('Link inválido')).toBeInTheDocument();
});
