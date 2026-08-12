/**
 * Escolha do torneio para registrar a premiação.
 *
 * É uma tela de passagem, e o comportamento que importa é o atalho: **com um
 * torneio só, ela nem aparece**. O clube que roda um evento por vez não deve
 * ter que clicar num cartão único a cada premiação.
 *
 * A outra decisão é a nova tentativa automática: a lista de torneios é a
 * primeira chamada depois de abrir a tela, e um 503 momentâneo (deploy,
 * cold start) faria o operador ver "erro" quando bastava esperar 1,5s.
 * Erro do CLIENTE (403) não é retentado — não melhora tentando de novo.
 */
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import PremiacaoSelector from './PremiacaoSelector';
import api from '../config/api';

jest.mock('../config/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('../components/Sidebar', () => () => <nav data-testid="sidebar" />);

const mockNavegar = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavegar,
}));

jest.mock('react-i18next', () => {
  const t = (chave) => chave;
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const TORNEIOS = [
  { id: 't1', name: 'Main Event', created_at: '2026-06-01T10:00:00Z' },
  { id: 't2', name: 'Turbo', created_at: null },
];

const montar = () => render(<MemoryRouter><PremiacaoSelector /></MemoryRouter>);

beforeEach(() => {
  mockNavegar.mockClear();
  api.get.mockResolvedValue({ data: TORNEIOS });
});

describe('listagem', () => {
  it('mostra um cartão por torneio', async () => {
    montar();
    expect(await screen.findByText('Main Event')).toBeInTheDocument();
    expect(screen.getByText('Turbo')).toBeInTheDocument();
  });

  it('mostra a data de criação quando existe', async () => {
    montar();
    await screen.findByText('Main Event');
    expect(screen.getByText(/Criado em/)).toBeInTheDocument();
  });

  it('torneio sem data não mostra linha vazia', async () => {
    // Um "Criado em" sozinho pareceria defeito de renderização.
    montar();
    await screen.findByText('Turbo');
    expect(screen.getAllByText(/Criado em/)).toHaveLength(1);
  });

  it('escolher um torneio leva à premiação dele', async () => {
    montar();
    await userEvent.click(await screen.findByText('Main Event'));
    expect(mockNavegar).toHaveBeenCalledWith('/premiacao/t1');
  });

  it('com um torneio só entra direto, sem mostrar a escolha', async () => {
    // O clube que roda um evento por vez não deve clicar num cartão único a
    // cada premiação.
    api.get.mockResolvedValue({ data: [TORNEIOS[0]] });
    montar();
    await waitFor(() =>
      expect(mockNavegar).toHaveBeenCalledWith('/premiacao/t1', { replace: true })
    );
  });

  it('sem torneio nenhum explica o que falta', async () => {
    api.get.mockResolvedValue({ data: [] });
    montar();
    expect(await screen.findByText('prizeSelector.emptyTitle')).toBeInTheDocument();
  });

  it('resposta vazia não quebra', async () => {
    api.get.mockResolvedValue({ data: null });
    montar();
    expect(await screen.findByText('prizeSelector.emptyTitle')).toBeInTheDocument();
  });

  it('mostra o carregamento', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    montar();
    expect(screen.getByText('prizeSelector.loadingTournaments')).toBeInTheDocument();
  });
});

describe('falhas', () => {
  it('erro de servidor é retentado uma vez antes de desistir', async () => {
    // Um 503 momentâneo (deploy, cold start) faria o operador ver "erro"
    // quando bastava esperar.
    jest.useFakeTimers();
    api.get
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockResolvedValueOnce({ data: TORNEIOS });
    montar();
    await act(async () => {});
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    jest.useRealTimers();
    expect(await screen.findByText('Main Event')).toBeInTheDocument();
  });

  it('erro de rede também é retentado', async () => {
    jest.useFakeTimers();
    api.get
      .mockRejectedValueOnce(new Error('Network Error'))
      .mockResolvedValueOnce({ data: TORNEIOS });
    montar();
    await act(async () => {});
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    jest.useRealTimers();
  });

  it('erro do cliente NÃO é retentado', async () => {
    // 403 não melhora tentando de novo; insistir só atrasaria a mensagem.
    api.get.mockRejectedValue({ response: { status: 403 } });
    montar();
    expect(await screen.findByText('prizeSelector.errorLoad')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('a segunda falha mostra o erro e oferece tentar de novo', async () => {
    // Sem o botão, a saída seria recarregar a página inteira.
    jest.useFakeTimers();
    api.get.mockRejectedValue({ response: { status: 503 } });
    montar();
    await act(async () => {});
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });
    jest.useRealTimers();
    expect(await screen.findByText('prizeSelector.errorLoad')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'prizeSelector.retry' })).toBeInTheDocument();
  });

  it('tentar de novo refaz a busca', async () => {
    api.get.mockRejectedValue({ response: { status: 403 } });
    montar();
    await screen.findByText('prizeSelector.errorLoad');
    api.get.mockResolvedValue({ data: TORNEIOS });
    await userEvent.click(screen.getByRole('button', { name: 'prizeSelector.retry' }));
    expect(await screen.findByText('Main Event')).toBeInTheDocument();
  });
});
