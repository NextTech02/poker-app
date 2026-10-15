/**
 * Final por revezamento no Controle: quem joga em cada nível sai do relógio
 * (e da ordem carregada), não de uma consulta a cada troca de nível.
 */
import { act, render, screen } from '@testing-library/react';
import RevezamentoCard from './RevezamentoCard';
import api from '../../config/api';

jest.mock('../../config/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('../../hooks/useRealtimeRefresh', () => ({ useRealtimeRefresh: () => {} }));
jest.mock('react-i18next', () => {
  const t = (chave, segundo, terceiro) => {
    const padrao = typeof segundo === 'string' ? segundo : chave;
    const vars = typeof segundo === 'string' ? terceiro : segundo;
    if (!vars) return padrao;
    return padrao.replace(/\{\{(\w+)\}\}/g, (bruto, nome) => (vars[nome] === undefined ? bruto : String(vars[nome])));
  };
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const RELAY = {
  final_day_id: 'd2', start_level: 1,
  teams: [
    { team_id: 'A', name: 'Los Ases', status: 'active', members: [
      { name: 'Ana Souza' }, { name: 'Beto', nickname: 'Tiburón' }, { name: 'Caio' }, { name: 'Davi' },
    ] },
    { team_id: 'B', name: 'Los Reyes', status: 'eliminated', members: [{ name: 'Eva' }] },
  ],
};

beforeEach(() => api.get.mockResolvedValue({ data: RELAY }));

it('mostra quem joga agora e quem entra no próximo nível', async () => {
  render(<RevezamentoCard tournamentId="t1" dayId="d2" nivel={2} />);
  expect(await screen.findByText('Agora: Tiburón')).toBeInTheDocument();
  expect(screen.getByText('Próximo nível: Caio')).toBeInTheDocument();
  expect(screen.getByText('eliminada')).toBeInTheDocument();
});

it('no intervalo: quem jogou e quem volta depois', async () => {
  render(<RevezamentoCard tournamentId="t1" dayId="d2" nivel={4} emIntervalo />);
  expect(await screen.findByText('Jogou: Davi')).toBeInTheDocument();
  expect(screen.getByText('Depois do intervalo: Ana')).toBeInTheDocument();
});

it('na troca de nível avisa o floor', async () => {
  const { rerender } = render(<RevezamentoCard tournamentId="t1" dayId="d2" nivel={1} />);
  await screen.findByText('Agora: Ana');
  act(() => rerender(<RevezamentoCard tournamentId="t1" dayId="d2" nivel={2} />));
  expect(screen.getByRole('status')).toHaveTextContent('entra o próximo de cada equipe');
});

it('em outro dia (ou sem final montada) não aparece', async () => {
  api.get.mockResolvedValue({ data: { ...RELAY, final_day_id: 'outro' } });
  const { container } = render(<RevezamentoCard tournamentId="t1" dayId="d2" nivel={1} />);
  await act(async () => {});
  expect(container).toBeEmptyDOMElement();
});
