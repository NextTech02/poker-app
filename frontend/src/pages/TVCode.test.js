/**
 * Entrada das TVs do salão por código. A mesma TV pode mostrar o relógio de
 * blinds ou o quadro de mesas e assentos; o código é o mesmo (o do dia).
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import TVCode from './TVCode';
import api from '../config/api';

jest.mock('../config/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('react-i18next', () => {
  const traducao = { t: (chave) => chave, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const Onde = () => <div data-testid="onde">{useLocation().pathname}</div>;

const montar = (inicio = '/tv') => render(
  <MemoryRouter initialEntries={[inicio]}>
    <Routes>
      <Route path="/tv" element={<TVCode />} />
      <Route path="/tv/:code" element={<TVCode />} />
      <Route path="*" element={<Onde />} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  api.get.mockResolvedValue({ data: { day_id: 'd1', tournament_id: 't1' } });
});

it('por padrão o código abre o relógio de blinds do dia', async () => {
  montar();
  await userEvent.type(screen.getByPlaceholderText('XXXXXX'), 'abc234');
  await userEvent.click(screen.getByRole('button', { name: 'tv.enter' }));
  await waitFor(() => expect(screen.getByTestId('onde')).toHaveTextContent('/broadcast/d1'));
  expect(api.get).toHaveBeenCalledWith('/public/tv/ABC234', { _public: true });
});

it('"Mesas e assentos" abre o quadro de mesas com o mesmo código', async () => {
  montar();
  await userEvent.click(screen.getByRole('radio', { name: 'tv.screenSeating' }));
  expect(screen.getByRole('radio', { name: 'tv.screenSeating' })).toHaveAttribute('aria-checked', 'true');
  await userEvent.type(screen.getByPlaceholderText('XXXXXX'), 'abc234');
  await userEvent.click(screen.getByRole('button', { name: 'tv.enter' }));
  await waitFor(() => expect(screen.getByTestId('onde')).toHaveTextContent('/tv/ABC234/mesas'));
});

it('código inválido continua na tela com o aviso', async () => {
  api.get.mockRejectedValue({ response: { status: 404 } });
  montar();
  await userEvent.click(screen.getByRole('radio', { name: 'tv.screenSeating' }));
  await userEvent.type(screen.getByPlaceholderText('XXXXXX'), 'zzz');
  await userEvent.click(screen.getByRole('button', { name: 'tv.enter' }));
  expect(await screen.findByText('tv.invalid')).toBeInTheDocument();
  expect(screen.queryByTestId('onde')).toBeNull();
});

it('link direto /tv/<código> continua indo para os blinds', async () => {
  montar('/tv/ABC234');
  await waitFor(() => expect(screen.getByTestId('onde')).toHaveTextContent('/broadcast/d1'));
});
