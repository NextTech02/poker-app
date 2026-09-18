import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Segmented from './Segmented';

const OPCOES = [
  { value: 'all', label: 'Todas' },
  { value: 'open', label: 'Ativas', count: 2 },
  { value: 'done', label: 'Concluídas' },
];

describe('Segmented', () => {
  it('marca a opção ativa e nomeia o grupo para o leitor de tela', () => {
    render(<Segmented options={OPCOES} value="open" onChange={() => {}} ariaLabel="Filtrar" />);
    expect(screen.getByRole('group', { name: 'Filtrar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Ativas/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Todas' })).toHaveAttribute('aria-pressed', 'false');
    // O contador aparece junto do rótulo, sem virar outro botão.
    expect(screen.getByRole('button', { name: /Ativas/ })).toHaveTextContent('2');
  });

  it('clicar numa opção devolve o valor dela', async () => {
    const aoMudar = jest.fn();
    render(<Segmented options={OPCOES} value="all" onChange={aoMudar} ariaLabel="Filtrar" />);
    await userEvent.click(screen.getByRole('button', { name: 'Concluídas' }));
    expect(aoMudar).toHaveBeenCalledWith('done');
  });
});
