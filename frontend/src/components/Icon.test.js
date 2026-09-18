import React from 'react';
import { render } from '@testing-library/react';
import Icon, { ICON_PATHS } from './Icon';

describe('Icon', () => {
  test('desenha com stroke e sem fill (traçado de contorno, não mancha)', () => {
    const { container } = render(<Icon name="wallet" />);
    const svg = container.querySelector('svg');

    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute('fill', 'none');
    expect(svg).toHaveAttribute('stroke', 'currentColor');
    expect(svg).toHaveAttribute('stroke-width', '2');
    expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
  });

  test('nenhum ícone do conjunto é preenchido com fill', () => {
    Object.keys(ICON_PATHS).forEach((name) => {
      const { container, unmount } = render(<Icon name={name} />);
      const svg = container.querySelector('svg');
      expect(svg).toHaveAttribute('fill', 'none');
      expect(svg).toHaveAttribute('stroke', 'currentColor');
      expect(container.querySelector('path')).toHaveAttribute('d', ICON_PATHS[name]);
      unmount();
    });
  });

  test('é decorativo por padrão: aria-hidden e sem role', () => {
    const { container } = render(<Icon name="dollar" />);
    const svg = container.querySelector('svg');

    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).not.toHaveAttribute('role');
    expect(svg.querySelector('title')).toBeNull();
  });

  test('com title deixa de ser decorativo e vira imagem anunciável', () => {
    const { container, getByTitle } = render(<Icon name="dollar" title="Caixa" />);
    const svg = container.querySelector('svg');

    expect(svg).not.toHaveAttribute('aria-hidden');
    expect(svg).toHaveAttribute('role', 'img');
    expect(getByTitle('Caixa')).toBeInTheDocument();
  });

  test('nome desconhecido não renderiza nada', () => {
    const { container } = render(<Icon name="nao-existe" />);
    expect(container.querySelector('svg')).toBeNull();
  });

  test('repassa className para o svg', () => {
    const { container } = render(<Icon name="trophy" className="meu-icone" />);
    expect(container.querySelector('svg')).toHaveClass('meu-icone');
  });

  // O menu lateral e a barra do topo desenham os ícones por NOME (menus.js).
  // Um nome sem traçado renderiza nada — e o item fica sem ícone em silêncio.
  test('todo ícone citado no menu tem traçado', () => {
    const { MENUS_POR_MODULO, MENU_COMUM } = require('./menus');
    const nomes = new Set();
    const coletar = (item) => {
      if (item.icon) nomes.add(item.icon);
      if (item.children) item.children.forEach(coletar);
    };
    Object.values(MENUS_POR_MODULO).forEach((itens) => itens.forEach(coletar));
    MENU_COMUM.forEach(coletar);
    ['trophy-cup', 'chips', 'cocktail', 'logout', 'chevron-left', 'chevron-right'].forEach((n) => nomes.add(n));

    expect(nomes.size).toBeGreaterThan(10);
    nomes.forEach((name) => {
      expect(ICON_PATHS[name]).toEqual(expect.any(String));
    });
  });
});
