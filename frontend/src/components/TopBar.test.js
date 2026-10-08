import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TopBar, { localizarNoMenu } from './TopBar';
import { useModule } from '../contexts/ModuleContext';
import { useStage } from '../contexts/StageContext';
import { useCashDay } from '../contexts/CashDayContext';
import { useBarShift } from '../contexts/BarShiftContext';
import { useConnectivity } from '../contexts/ConnectivityContext';

jest.mock('../contexts/ModuleContext', () => ({
  useModule: jest.fn(),
  MODULO_TORNEIO: 'tournament',
  MODULO_CASH: 'cash',
  MODULO_BAR: 'bar',
}));
jest.mock('../contexts/StageContext', () => ({ useStage: jest.fn() }));
jest.mock('../contexts/CashDayContext', () => ({ useCashDay: jest.fn() }));
jest.mock('../contexts/BarShiftContext', () => ({ useBarShift: jest.fn() }));
jest.mock('../contexts/ConnectivityContext', () => ({ useConnectivity: jest.fn() }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallbackOrOpts, opts) => {
      const o = typeof fallbackOrOpts === 'object' ? fallbackOrOpts : opts;
      if (o && o.count !== undefined) return `${key}:${o.count}`;
      return key;
    },
  }),
}));

const montar = ({ modulo = 'tournament', rota = '/home', etapa = null, dia = null, turno = null, online = true, pendentes = 0 } = {}) => {
  useModule.mockReturnValue({ module: modulo });
  useStage.mockReturnValue({ selectedStage: etapa });
  useCashDay.mockReturnValue({ day: dia });
  useBarShift.mockReturnValue({ shift: turno });
  useConnectivity.mockReturnValue({ isOnline: online, pendingCount: pendentes });
  return render(
    <MemoryRouter initialEntries={[rota]}>
      <TopBar />
    </MemoryRouter>
  );
};

describe('localizarNoMenu', () => {
  test('acha o item mais específico e o grupo dele', () => {
    const r = localizarNoMenu('/caixa/jogadores', 'tournament');
    expect(r.item.path).toBe('/caixa/jogadores');
    expect(r.grupo.groupKey).toBe('caixa');
  });

  test('"/" cai no início; sub-rota herda o item pai', () => {
    expect(localizarNoMenu('/', 'tournament').item.path).toBe('/home');
    expect(localizarNoMenu('/torneios/abc', 'tournament').item.path).toBe('/torneios');
  });

  test('item do clube vale em qualquer módulo', () => {
    expect(localizarNoMenu('/jogadores', 'bar').item.path).toBe('/jogadores');
  });

  test('rota fora do menu não localiza nada', () => {
    expect(localizarNoMenu('/rota-inexistente', 'cash')).toBeNull();
  });
});

describe('migalhas', () => {
  test('módulo › grupo › tela', () => {
    montar({ rota: '/caixa/tickets' });
    const crumbs = screen.getByRole('navigation').textContent;
    expect(crumbs).toContain('modules.tournamentTitle');
    expect(crumbs).toContain('sidebar.cashRegister');
    expect(crumbs).toContain('sidebar.tournamentTickets');
  });
});

describe('chip de contexto', () => {
  test('torneio com etapa selecionada leva para /etapas', () => {
    montar({ etapa: { name: 'Etapa Rio' } });
    const chip = screen.getByRole('link', { name: /Etapa Rio/ });
    expect(chip).toHaveAttribute('href', '/etapas');
    expect(chip.className).toContain('tone-mod');
  });

  test('torneio sem etapa avisa', () => {
    montar();
    expect(screen.getByRole('link', { name: /topbar.noStage/ }).className).toContain('tone-warn');
  });

  test('cash mostra o dia de negócio sem passar por Date (sem fuso)', () => {
    montar({ modulo: 'cash', rota: '/cash', dia: { business_date: '2026-09-17', status: 'open' } });
    const chip = screen.getByRole('link', { name: /17\/09/ });
    expect(chip).toHaveTextContent('topbar.open');
    expect(chip).toHaveAttribute('href', '/cash/dias');
  });

  test('bar sem turno aponta para os turnos', () => {
    montar({ modulo: 'bar', rota: '/bar' });
    expect(screen.getByRole('link', { name: /topbar.noShift/ })).toHaveAttribute('href', '/bar/turnos');
  });

  test('offline aparece com a fila pendente', () => {
    montar({ online: false, pendentes: 3 });
    expect(screen.getByText('topbar.offline')).toBeInTheDocument();
    expect(screen.getByText('topbar.pending:3')).toBeInTheDocument();
  });
});

describe('Voltar na barra do topo', () => {
  it('toda tela fora da casa tem o botão "Voltar"', () => {
    montar({ rota: '/torneios' });
    expect(screen.getByTestId('back-btn')).toBeInTheDocument();
  });

  it('na casa, sem histórico, o botão não aparece', () => {
    window.history.replaceState(null, '');
    montar({ rota: '/home' });
    expect(screen.queryByTestId('back-btn')).toBeNull();
  });
});
