/**
 * "Voltar" de toda tela (barra do topo e cabeçalho móvel).
 *
 * Com histórico dentro do app volta UMA tela, como a seta do navegador. Sem
 * histórico (link aberto direto, guia nova) vai para a casa do módulo. Na
 * casa, sem histórico, não há para onde voltar: o botão some.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BackButton from './BackButton';
import { useModule } from '../contexts/ModuleContext';

const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));
jest.mock('../contexts/ModuleContext', () => ({
  useModule: jest.fn(),
  MODULO_TORNEIO: 'tournament',
  MODULO_CASH: 'cash',
  MODULO_BAR: 'bar',
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key) }),
}));

const montar = ({ rota = '/control/d1', modulo = 'tournament', idx = null } = {}) => {
  useModule.mockReturnValue({ module: modulo });
  window.history.replaceState(idx === null ? null : { idx }, '');
  return render(
    <MemoryRouter initialEntries={[rota]}>
      <BackButton />
    </MemoryRouter>
  );
};

afterEach(() => {
  window.history.replaceState(null, '');
});

describe('Voltar', () => {
  it('com histórico no app, volta uma tela (como a seta do navegador)', () => {
    montar({ idx: 3 });
    fireEvent.click(screen.getByRole('button', { name: 'Voltar' }));
    expect(mockNavigate).toHaveBeenCalledWith(-1);
  });

  it('sem histórico (link direto / guia nova), vai para a casa do módulo', () => {
    montar({ rota: '/control/d1', idx: null });
    fireEvent.click(screen.getByRole('button', { name: 'Voltar' }));
    expect(mockNavigate).toHaveBeenCalledWith('/home');
  });

  it('a casa é a do módulo ativo: cash e bar têm a sua', () => {
    montar({ rota: '/cash/fila', modulo: 'cash', idx: 0 });
    fireEvent.click(screen.getByTestId('back-btn'));
    expect(mockNavigate).toHaveBeenCalledWith('/cash');
    mockNavigate.mockClear();
    document.body.innerHTML = '';
    montar({ rota: '/bar/pedidos', modulo: 'bar', idx: 0 });
    fireEvent.click(screen.getByTestId('back-btn'));
    expect(mockNavigate).toHaveBeenCalledWith('/bar');
  });

  it('na casa do módulo, sem histórico, não há para onde voltar: o botão some', () => {
    montar({ rota: '/home', idx: 0 });
    expect(screen.queryByTestId('back-btn')).toBeNull();
    document.body.innerHTML = '';
    montar({ rota: '/', idx: null });
    expect(screen.queryByTestId('back-btn')).toBeNull();
  });

  it('na casa COM histórico o botão existe e volta uma tela', () => {
    montar({ rota: '/home', idx: 2 });
    fireEvent.click(screen.getByTestId('back-btn'));
    expect(mockNavigate).toHaveBeenCalledWith(-1);
  });

  it('a classe extra entra (variante do celular)', () => {
    useModule.mockReturnValue({ module: 'tournament' });
    render(<MemoryRouter initialEntries={['/torneios']}><BackButton className="back-btn--mobile" /></MemoryRouter>);
    expect(screen.getByTestId('back-btn')).toHaveClass('back-btn--mobile');
  });
});
