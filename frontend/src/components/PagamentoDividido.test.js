/**
 * O editor das partes de um pagamento dividido.
 *
 * O que trava:
 * 1. O rodapé diz quanto falta ou sobra para fechar o total.
 * 2. "Outra forma" nasce num meio ainda não usado, já com o que falta.
 * 3. Remover uma parte devolve a lista sem ela; com uma parte só, não há remover.
 */
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PagamentoDividido from './PagamentoDividido';
import { useCurrency } from '../contexts/CurrencyContext';

jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));
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
