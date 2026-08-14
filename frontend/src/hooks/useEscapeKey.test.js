import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { useEscapeKey } from './useEscapeKey';

/**
 * O Esc é o caminho de teclado para fechar um modal — o clique no fundo escuro
 * só existe para o mouse. Estes testes protegem exatamente isso.
 */

const Modal = ({ aberto, aoFechar }) => {
  useEscapeKey(aberto, aoFechar);
  return aberto ? <div>modal aberto</div> : null;
};

const pressionar = (tecla) => fireEvent.keyDown(document, { key: tecla });

it('Esc dispara o fechamento quando o modal está aberto', () => {
  const aoFechar = jest.fn();
  render(<Modal aberto aoFechar={aoFechar} />);
  pressionar('Escape');
  expect(aoFechar).toHaveBeenCalledTimes(1);
});

it('outras teclas não fecham nada', () => {
  const aoFechar = jest.fn();
  render(<Modal aberto aoFechar={aoFechar} />);
  pressionar('Enter');
  pressionar('a');
  expect(aoFechar).not.toHaveBeenCalled();
});

it('com o modal fechado o Esc é ignorado', () => {
  const aoFechar = jest.fn();
  render(<Modal aberto={false} aoFechar={aoFechar} />);
  pressionar('Escape');
  expect(aoFechar).not.toHaveBeenCalled();
});

it('o listener é removido ao desmontar', () => {
  const aoFechar = jest.fn();
  const { unmount } = render(<Modal aberto aoFechar={aoFechar} />);
  unmount();
  pressionar('Escape');
  expect(aoFechar).not.toHaveBeenCalled();
});

it('sem callback não quebra', () => {
  render(<Modal aberto aoFechar={undefined} />);
  pressionar('Escape');
  expect(screen.getByText('modal aberto')).toBeInTheDocument();
});
