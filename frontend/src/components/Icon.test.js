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

  // Guarda contra divergência entre cabeçalho (JS) e menu lateral (CSS):
  // se alguém mudar um traçado só num lugar, este teste falha.
  test('todos os traçados são idênticos aos do Sidebar.css', () => {
    const fs = require('fs');
    const path = require('path');
    const css = fs.readFileSync(path.join(__dirname, 'Sidebar.css'), 'utf8');

    const doCss = {};
    const regra = /\.nav-icon\[class\*="([^"]+)"\]::before[\s\S]*?d='([^']+)'/g;
    let m = regra.exec(css);
    while (m) {
      doCss[m[1]] = m[2];
      m = regra.exec(css);
    }

    expect(Object.keys(doCss).length).toBeGreaterThan(0);
    Object.entries(doCss).forEach(([name, d]) => {
      expect(ICON_PATHS[name]).toBe(d);
    });
  });
});
