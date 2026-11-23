/**
 * O editor das partes de um pagamento dividido.
 *
 * O que trava:
 * 1. O rodapé diz quanto falta ou sobra para fechar o total.
 * 2. "Outra forma" nasce num meio ainda não usado, já com o que falta.
 * 3. Com duas formas, digitar o valor de uma ajusta a outra; a forma em branco
 *    não fecha (ela sumia em silêncio e a venda saía num meio só).
 * 4. Remover uma parte devolve a lista sem ela; com uma parte só, não há remover.
 */
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PagamentoDividido from './PagamentoDividido';
import { useCurrency } from '../contexts/CurrencyContext';

jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));
jest.mock('../contexts/PaymentMethodsContext', () => ({
  usePaymentMethods: () => ({ labelFor: (code) => ({ plin: 'PLIN' }[code] || null) }),
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (chave, padrao, vars) => {
      if (typeof padrao !== 'string') return chave;
      return padrao.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars ? vars[k] : ''));
    },
  }),
}));

const METODOS = [
  { code: 'cash', label: 'Dinheiro' },
  { code: 'transfer', label: 'Transferência' },
  { code: 'yape', label: 'Yape' },
];

beforeEach(() => {
  useCurrency.mockReturnValue({ formatCurrency: (v) => `R$ ${Number(v || 0).toFixed(2)}` });
});

// Guarda as partes como a tela guardaria (o componente é controlado).
function Tela({ total = 500, inicial }) {
  const [partes, setPartes] = useState(inicial);
  return (
    <>
      <PagamentoDividido total={total} partes={partes} onChange={setPartes} metodos={METODOS} />
      <output data-testid="estado">{JSON.stringify(partes)}</output>
    </>
  );
}

const estado = () => JSON.parse(screen.getByTestId('estado').textContent);

it('com o total inteiro numa parte, fecha', () => {
  render(<Tela inicial={[{ payment_method: 'cash', amount: '500' }]} />);
  expect(screen.getByText('Fecha R$ 500.00')).toBeInTheDocument();
  // Uma parte só: nada a remover.
  expect(screen.queryByRole('button', { name: 'Remover parte 1' })).not.toBeInTheDocument();
});

it('diz quanto falta e a próxima forma já nasce com o que falta, num meio novo', async () => {
  render(<Tela inicial={[{ payment_method: 'cash', amount: '300' }]} />);
  expect(screen.getByText('Falta R$ 200.00')).toBeInTheDocument();

  await userEvent.click(screen.getByRole('button', { name: '+ Outra forma' }));
  expect(estado()).toEqual([
    { payment_method: 'cash', amount: '300' },
    { payment_method: 'transfer', amount: '200' },
  ]);
  expect(screen.getByText('Fecha R$ 500.00')).toBeInTheDocument();
});

it('diz quanto passa do total', async () => {
  render(<Tela inicial={[{ payment_method: 'cash', amount: '300' }, { payment_method: 'yape', amount: '250' }]} />);
  expect(screen.getByText('Passa R$ 50.00')).toBeInTheDocument();

  const valor = screen.getByLabelText('Valor da parte 2');
  await userEvent.clear(valor);
  await userEvent.type(valor, '200');
  expect(screen.getByText('Fecha R$ 500.00')).toBeInTheDocument();
});

it('troca o meio de uma parte e remove outra', async () => {
  render(<Tela inicial={[{ payment_method: 'cash', amount: '300' }, { payment_method: 'yape', amount: '200' }]} />);
  await userEvent.selectOptions(screen.getByLabelText('Meio da parte 2'), 'transfer');
  expect(estado()[1].payment_method).toBe('transfer');

  await userEvent.click(screen.getByRole('button', { name: 'Remover parte 1' }));
  expect(estado()).toEqual([{ payment_method: 'transfer', amount: '200' }]);
});

it('com duas formas, o valor de uma é o que falta da outra', async () => {
  render(<Tela inicial={[{ payment_method: 'cash', amount: '500' }, { payment_method: 'transfer', amount: '' }]} />);
  await userEvent.type(screen.getByLabelText('Valor da parte 2'), '200');
  expect(estado()).toEqual([
    { payment_method: 'cash', amount: '300' },
    { payment_method: 'transfer', amount: '200' },
  ]);
  expect(screen.getByText('Fecha R$ 500.00')).toBeInTheDocument();
});

it('forma em branco não fecha, e a tela diz por quê', () => {
  render(<Tela inicial={[{ payment_method: 'cash', amount: '500' }, { payment_method: 'transfer', amount: '' }]} />);
  expect(screen.getByText('Informe o valor de cada forma ou remova a que sobrou.')).toBeInTheDocument();
  expect(screen.queryByText('Fecha R$ 500.00')).not.toBeInTheDocument();
});

it('com três formas, nenhuma é ajustada sozinha', async () => {
  render(<Tela inicial={[
    { payment_method: 'cash', amount: '300' }, { payment_method: 'transfer', amount: '100' }, { payment_method: 'yape', amount: '100' },
  ]} />);
  const valor = screen.getByLabelText('Valor da parte 3');
  await userEvent.clear(valor);
  await userEvent.type(valor, '50');
  expect(estado().map((p) => p.amount)).toEqual(['300', '100', '50']);
  expect(screen.getByText('Falta R$ 50.00')).toBeInTheDocument();
});

it('meio desativado numa venda antiga continua aparecendo como ele mesmo', () => {
  render(<Tela inicial={[{ payment_method: 'plin', amount: '300' }, { payment_method: 'cash', amount: '200' }]} />);
  expect(screen.getByLabelText('Meio da parte 1')).toHaveDisplayValue('PLIN');
});
