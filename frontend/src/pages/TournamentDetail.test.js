/**
 * Detalhe do torneio — a lista de dias e o que cada um permite fazer.
 *
 * A tela é sobretudo uma máquina de estados: cada dia oferece exatamente as
 * ações que o seu status permite, e as que não permite não aparecem. Isso
 * importa porque:
 *
 * - **Excluir só vale para dia pendente.** Um dia ativo tem dinheiro e
 *   jogadores dentro; apagar reescreveria o caixa.
 * - **"Reiniciar" e "Reabrir" são coisas diferentes.** Reiniciar (dia ativo)
 *   ZERA o relógio; sem isso o botão parecia não fazer nada, porque o dia já
 *   estava ativo e o relógio seguia no nível onde parou. Reabrir (dia
 *   concluído) só reativa, preservando o relógio.
 * - **Avançar classificados** só existe num dia classificatório concluído que
 *   aponta para um dia final — é o momento em que os sobreviventes viram
 *   inscritos do dia seguinte.
 *
 * Torneio com classificatórios divide a lista em duas seções; sem eles, é uma
 * lista única. O código de TV é POR DIA, buscado sob demanda.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import TournamentDetail from './TournamentDetail';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock('../components/Sidebar', () => () => <nav data-testid="sidebar" />);
jest.mock('./TournamentDashboard', () => ({ tournamentId }) => (
  <div data-testid="painel">{tournamentId}</div>
));
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));
const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useParams: () => ({ id: 't1' }),
  useNavigate: () => mockNavigate,
}));
jest.mock('react-i18next', () => {
  const t = (chave, segundo, terceiro) => {
    const vars = segundo && typeof segundo === 'object' ? segundo : terceiro;
    if (vars) return `${chave}:${Object.values(vars).join(',')}`;
    return typeof segundo === 'string' ? segundo : chave;
  };
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const TORNEIO = { id: 't1', name: 'Main Event', has_qualifying: false };

const DIA_BASE = {
  buy_in: 500, rebuy_amount: 300, addon_amount: 200, max_players: 100,
  registered_players: 40, rake_percentage: 20, starting_chips: 30000,
  total_entries: 55,
};

const DIAS = [
  { ...DIA_BASE, id: 'd1', day_name: 'Dia 1A', status: 'pending', day_type: 'regular' },
  { ...DIA_BASE, id: 'd2', day_name: 'Dia 1B', status: 'active', day_type: 'regular' },
  { ...DIA_BASE, id: 'd3', day_name: 'Dia 1C', status: 'completed', day_type: 'regular' },
];

let toast;
let confirmar;

const responder = ({ torneio = TORNEIO, dias = DIAS, codigo = { code: 'ABC123' } } = {}) => {
  api.get.mockImplementation((url) => {
    if (url === '/tournaments/t1') {
      return torneio instanceof Error ? Promise.reject(torneio) : Promise.resolve({ data: torneio });
    }
    if (url === '/tournament-days/tournament/t1') return Promise.resolve({ data: dias });
    if (url.endsWith('/broadcast-code')) {
      return codigo instanceof Error ? Promise.reject(codigo) : Promise.resolve({ data: codigo });
    }
    return Promise.resolve({ data: [] });
  });
};

const montar = async (opcoes) => {
  responder(opcoes);
  render(<MemoryRouter><TournamentDetail /></MemoryRouter>);
  await waitFor(() => expect(screen.queryByText('common.loading')).toBeNull());
};

// Casa pelo TITULO do cartao: o nome do dia final tambem aparece dentro do
// cartao do classificatorio (como destino), e uma busca por texto solto
// devolveria o cartao errado.
const cartaoDoDia = (nome) =>
  Array.from(document.querySelectorAll('.day-card')).find(
    (el) => el.querySelector('.day-card-title h3')?.textContent === nome
  );

const acao = (nomeDia, rotulo) =>
  within(cartaoDoDia(nomeDia)).getByRole('button', { name: rotulo });

beforeEach(() => {
  toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn() };
  confirmar = jest.fn().mockResolvedValue(true);
  useToast.mockReturnValue({ toast, confirm: confirmar });
  useCurrency.mockReturnValue({ formatCurrency: (v) => `R$ ${Number(v || 0).toFixed(2)}` });
  api.post.mockResolvedValue({ data: { advanced_count: 9, final_day_name: 'Dia Final' } });
  api.patch.mockResolvedValue({ data: {} });
  api.delete.mockResolvedValue({ data: {} });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => console.error.mockRestore());

describe('carga', () => {
  it('mostra o carregamento antes dos dados', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<MemoryRouter><TournamentDetail /></MemoryRouter>);
    expect(screen.getByText('common.loading')).toBeInTheDocument();
  });

  it('mostra o nome do torneio', async () => {
    await montar();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Main Event');
  });

  it('torneio inexistente oferece o caminho de volta', async () => {
    await montar({ torneio: new Error('404') });
    expect(screen.getByText('common.noData')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'common.back' }));
    expect(mockNavigate).toHaveBeenCalledWith('/torneios');
  });

  it('o painel do torneio é montado com o id da rota', async () => {
    await montar();
    expect(screen.getByTestId('painel')).toHaveTextContent('t1');
  });

  it('sem dia nenhum orienta a criar o primeiro', async () => {
    await montar({ dias: [] });
    expect(screen.getByText('Nenhum dia configurado')).toBeInTheDocument();
  });
});

describe('ações conforme o status do dia', () => {
  it('dia PENDENTE só oferece iniciar', async () => {
    await montar();
    const cartao = cartaoDoDia('Dia 1A');
    expect(within(cartao).getByRole('button', { name: 'tournamentDays.startDay' })).toBeInTheDocument();
    expect(within(cartao).queryByRole('button', { name: 'tournamentDays.finishDay' })).toBeNull();
  });

  it('dia ATIVO oferece ver, controlar, reiniciar e encerrar', async () => {
    await montar();
    const cartao = cartaoDoDia('Dia 1B');
    expect(within(cartao).getByRole('button', { name: 'control.title' })).toBeInTheDocument();
    expect(within(cartao).getByRole('button', { name: 'tournamentDays.restartDay' })).toBeInTheDocument();
    expect(within(cartao).getByRole('button', { name: 'tournamentDays.finishDay' })).toBeInTheDocument();
    expect(within(cartao).queryByRole('button', { name: 'tournamentDays.startDay' })).toBeNull();
  });

  it('dia CONCLUÍDO oferece reabrir', async () => {
    await montar();
    const cartao = cartaoDoDia('Dia 1C');
    expect(within(cartao).getByRole('button', { name: 'tournamentDays.reopenDay' })).toBeInTheDocument();
  });

  it('só dia PENDENTE pode ser excluído', async () => {
    // Um dia ativo tem dinheiro e jogadores dentro; apagar reescreveria o
    // caixa da etapa.
    await montar();
    expect(acao('Dia 1A', 'common.delete')).toBeEnabled();
    expect(acao('Dia 1B', 'common.delete')).toBeDisabled();
    expect(acao('Dia 1C', 'common.delete')).toBeDisabled();
  });

  it('a etiqueta de status aparece em cada dia', async () => {
    await montar();
    expect(within(cartaoDoDia('Dia 1A')).getByText('common.pending')).toBeInTheDocument();
    expect(within(cartaoDoDia('Dia 1B')).getByText('common.active')).toBeInTheDocument();
  });

  it('status desconhecido não some da tela', async () => {
    // Um status novo no backend não pode deixar o cartão sem etiqueta.
    await montar({ dias: [{ ...DIA_BASE, id: 'd9', day_name: 'Novo', status: 'paused' }] });
    expect(screen.getByText('paused')).toBeInTheDocument();
  });
});

describe('iniciar, encerrar e reiniciar', () => {
  it('iniciar pede confirmação nomeando o dia', async () => {
    await montar();
    await userEvent.click(acao('Dia 1A', 'tournamentDays.startDay'));
    expect(confirmar).toHaveBeenCalledWith(
      'tournamentDays.confirmStartMessage:Dia 1A',
      expect.anything()
    );
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/tournament-days/d1', { status: 'active' })
    );
  });

  it('recusar não inicia', async () => {
    confirmar.mockResolvedValue(false);
    await montar();
    await userEvent.click(acao('Dia 1A', 'tournamentDays.startDay'));
    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('encerrar marca o dia como concluído', async () => {
    await montar();
    await userEvent.click(acao('Dia 1B', 'tournamentDays.finishDay'));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/tournament-days/d2', { status: 'completed' })
    );
  });

  it('REINICIAR um dia ativo zera o relógio de verdade', async () => {
    // Sem o reset o botão parecia não fazer nada: o dia já estava ativo e o
    // relógio continuava no nível em que parou.
    await montar();
    await userEvent.click(acao('Dia 1B', 'tournamentDays.restartDay'));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/tournament-days/d2/timer/reset')
    );
    expect(toast.success).toHaveBeenCalledWith('Dia reiniciado.');
  });

  it('REABRIR um dia concluído preserva o relógio', async () => {
    // Reabrir é para corrigir um encerramento precoce; zerar o relógio
    // apagaria o nível em que o torneio estava.
    await montar();
    await userEvent.click(acao('Dia 1C', 'tournamentDays.reopenDay'));
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(api.post).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('Dia reaberto.');
  });

  it('reabrir também carimba um novo horário de início', async () => {
    await montar();
    await userEvent.click(acao('Dia 1C', 'tournamentDays.reopenDay'));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        '/tournament-days/d3',
        expect.objectContaining({ status: 'active', start_time: expect.any(String) })
      )
    );
  });

  it('erro ao reiniciar mostra o motivo do servidor', async () => {
    api.patch.mockRejectedValue({ userMessage: 'Dia bloqueado' });
    await montar();
    await userEvent.click(acao('Dia 1B', 'tournamentDays.restartDay'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Dia bloqueado'));
  });

  it('erro ao encerrar avisa', async () => {
    api.patch.mockRejectedValue(new Error('500'));
    await montar();
    await userEvent.click(acao('Dia 1B', 'tournamentDays.finishDay'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('common.error'));
  });
});

describe('excluir dia', () => {
  it('a confirmação nomeia o dia e avisa que é definitivo', async () => {
    await montar();
    await userEvent.click(acao('Dia 1A', 'common.delete'));
    expect(confirmar).toHaveBeenCalledWith(
      'tournamentDays.confirmDeleteMessage:Dia 1A',
      expect.objectContaining({ variant: 'danger' })
    );
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/tournament-days/d1'));
  });

  it('recusar não exclui', async () => {
    confirmar.mockResolvedValue(false);
    await montar();
    await userEvent.click(acao('Dia 1A', 'common.delete'));
    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('erro ao excluir avisa', async () => {
    api.delete.mockRejectedValue(new Error('409'));
    await montar();
    await userEvent.click(acao('Dia 1A', 'common.delete'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('common.error'));
  });
});

describe('torneio com classificatórios', () => {
  const COM_QUALI = { ...TORNEIO, has_qualifying: true };
  const DIAS_QUALI = [
    { ...DIA_BASE, id: 'q1', day_name: 'Classificatório 1', status: 'completed',
      day_type: 'qualifying', qualifies_to_day_id: 'f1' },
    { ...DIA_BASE, id: 'f1', day_name: 'Dia Final', status: 'pending', day_type: 'final',
      registered_players: 9 },
  ];

  it('a lista se divide em classificatórios e final', async () => {
    await montar({ torneio: COM_QUALI, dias: DIAS_QUALI });
    expect(screen.getByText(/tournamentDays.qualifyingDays \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/tournamentDays.finalDay \(1\)/)).toBeInTheDocument();
  });

  it('sem classificatório ainda, a seção explica', async () => {
    await montar({ torneio: COM_QUALI, dias: [DIAS_QUALI[1]] });
    expect(screen.getByText('tournamentDays.noQualifyingDays')).toBeInTheDocument();
  });

  it('sem dia final ainda, a seção explica', async () => {
    await montar({ torneio: COM_QUALI, dias: [DIAS_QUALI[0]] });
    expect(screen.getByText('tournamentDays.noFinalDay')).toBeInTheDocument();
  });

  it('torneio sem classificatórios usa lista única', async () => {
    await montar();
    expect(screen.getByText(/tournamentDays.title \(3\)/)).toBeInTheDocument();
    expect(screen.queryByText(/qualifyingDays/)).toBeNull();
  });

  it('o classificatório mostra para qual dia ele leva', async () => {
    // Sem isso o operador não sabe onde os sobreviventes vão parar.
    await montar({ torneio: COM_QUALI, dias: DIAS_QUALI });
    expect(within(cartaoDoDia('Classificatório 1')).getByText('Dia Final')).toBeInTheDocument();
  });

  it('avançar classificados só aparece em classificatório CONCLUÍDO com destino', async () => {
    await montar({ torneio: COM_QUALI, dias: DIAS_QUALI });
    expect(
      within(cartaoDoDia('Classificatório 1')).getByRole('button', { name: 'tournamentDays.advanceQualifiers' })
    ).toBeInTheDocument();
    expect(
      within(cartaoDoDia('Dia Final')).queryByRole('button', { name: 'tournamentDays.advanceQualifiers' })
    ).toBeNull();
  });

  it('classificatório sem destino não oferece avançar', async () => {
    // Avançar para lugar nenhum perderia os sobreviventes.
    await montar({
      torneio: COM_QUALI,
      dias: [{ ...DIAS_QUALI[0], qualifies_to_day_id: null }],
    });
    expect(
      within(cartaoDoDia('Classificatório 1')).queryByRole('button', { name: 'tournamentDays.advanceQualifiers' })
    ).toBeNull();
  });

  it('avançar diz quantos passaram e para onde', async () => {
    await montar({ torneio: COM_QUALI, dias: DIAS_QUALI });
    await userEvent.click(acao('Classificatório 1', 'tournamentDays.advanceQualifiers'));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/tournament-days/q1/advance-qualifiers')
    );
    expect(toast.success).toHaveBeenCalledWith(
      expect.stringContaining('9')
    );
  });

  it('recusar não avança ninguém', async () => {
    confirmar.mockResolvedValue(false);
    await montar({ torneio: COM_QUALI, dias: DIAS_QUALI });
    await userEvent.click(acao('Classificatório 1', 'tournamentDays.advanceQualifiers'));
    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    expect(api.post).not.toHaveBeenCalled();
  });

  it('erro ao avançar mostra o motivo do servidor', async () => {
    const e = new Error('400');
    e.response = { data: { detail: 'Dia final já iniciado' } };
    api.post.mockRejectedValue(e);
    await montar({ torneio: COM_QUALI, dias: DIAS_QUALI });
    await userEvent.click(acao('Classificatório 1', 'tournamentDays.advanceQualifiers'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Dia final já iniciado'));
  });
});

describe('informações de cada dia', () => {
  it('dia normal mostra buy-in, rebuy, add-on e lotação', async () => {
    await montar({ dias: [DIAS[0]] });
    const cartao = cartaoDoDia('Dia 1A');
    expect(cartao).toHaveTextContent('R$ 500.00');
    expect(cartao).toHaveTextContent('40 / 100');
    expect(cartao).toHaveTextContent('20%');
  });

  it('rebuy e add-on ausentes viram travessão, não zero', async () => {
    // "R$ 0,00" diria que o rebuy é de graça; travessão diz que não existe.
    await montar({ dias: [{ ...DIAS[0], rebuy_amount: null, addon_amount: null }] });
    expect(within(cartaoDoDia('Dia 1A')).getAllByText('-').length).toBe(2);
  });

  it('dia FINAL não mostra buy-in nem entradas', async () => {
    // O dia final não vende entrada: quem chega vem do classificatório.
    await montar({
      torneio: { ...TORNEIO, has_qualifying: true },
      dias: [{ ...DIA_BASE, id: 'f1', day_name: 'Dia Final', status: 'pending', day_type: 'final' }],
    });
    const cartao = cartaoDoDia('Dia Final');
    expect(cartao).not.toHaveTextContent('tournaments.buyIn');
    expect(cartao).toHaveTextContent('tournaments.registeredPlayers');
  });

  it('a etiqueta de tipo aparece só em classificatório e final', async () => {
    await montar();
    expect(document.querySelector('.day-type-badge')).toBeNull();
  });
});

describe('navegação para as telas do dia', () => {
  it.each([
    ['common.details', '/torneios/dia/d2/estatisticas'],
    ['blinds.title', '/blinds/d2'],
    ['tables.title', '/alocacao/dia/d2'],
    ['Broadcast', '/torneios/t1/dia/d2/broadcast'],
    ['common.edit', '/torneios/t1/dia/editar/d2'],
    ['control.title', '/control/d2'],
    ['common.view', '/broadcast/d2'],
  ])('o botão %s leva a %s', async (rotulo, destino) => {
    await montar();
    await userEvent.click(acao('Dia 1B', rotulo));
    expect(mockNavigate).toHaveBeenCalledWith(destino);
  });

  it('criar dia leva ao formulário de novo dia', async () => {
    await montar({ dias: [] });
    await userEvent.click(screen.getByRole('button', { name: 'tournamentDayForm.createDay' }));
    expect(mockNavigate).toHaveBeenCalledWith('/torneios/t1/dia/novo');
  });

  it('a premiação é do torneio, não do dia', async () => {
    // O prêmio é único e sai no dia final; um link por dia sugeriria o
    // contrário.
    await montar();
    await userEvent.click(acao('Dia 1B', 'rankings.prize'));
    expect(mockNavigate).toHaveBeenCalledWith('/premiacao/t1');
  });

  it('em torneio com classificatórios o cabeçalho não repete a premiação', async () => {
    await montar({ torneio: { ...TORNEIO, has_qualifying: true }, dias: DIAS });
    const cabecalho = document.querySelector('.header-actions');
    expect(within(cabecalho).queryByRole('button', { name: 'rankings.prize' })).toBeNull();
  });

  it('dia classificatório não oferece premiação própria', async () => {
    await montar({
      torneio: { ...TORNEIO, has_qualifying: true },
      dias: [{ ...DIA_BASE, id: 'q1', day_name: 'Classificatório 1', status: 'pending', day_type: 'qualifying' }],
    });
    expect(
      within(cartaoDoDia('Classificatório 1')).queryByRole('button', { name: 'rankings.prize' })
    ).toBeNull();
  });
});

describe('código de TV', () => {
  it('o código é buscado só quando o operador pede', async () => {
    await montar();
    expect(api.get).not.toHaveBeenCalledWith('/tournament-days/d2/broadcast-code');
    await userEvent.click(acao('Dia 1B', 'Código TV'));
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/tournament-days/d2/broadcast-code')
    );
    expect(screen.getByText('ABC123')).toBeInTheDocument();
  });

  it('o código é POR DIA', async () => {
    // Um código por torneio mostraria os blinds do dia errado na TV.
    await montar();
    await userEvent.click(acao('Dia 1B', 'Código TV'));
    await screen.findByText('ABC123');
    expect(within(cartaoDoDia('Dia 1A')).queryByText('ABC123')).toBeNull();
  });

  it('clicar de novo fecha o cartão', async () => {
    await montar();
    await userEvent.click(acao('Dia 1B', 'Código TV'));
    await screen.findByText('ABC123');
    await userEvent.click(acao('Dia 1B', 'Código TV'));
    expect(screen.queryByText('ABC123')).toBeNull();
  });

  it('reabrir não busca o código de novo', async () => {
    await montar();
    const botao = () => acao('Dia 1B', 'Código TV');
    await userEvent.click(botao());
    await screen.findByText('ABC123');
    await userEvent.click(botao());
    const antes = api.get.mock.calls.filter((c) => c[0].endsWith('/broadcast-code')).length;
    await userEvent.click(botao());
    await screen.findByText('ABC123');
    expect(api.get.mock.calls.filter((c) => c[0].endsWith('/broadcast-code')).length).toBe(antes);
  });

  it('dá para abrir a tela da TV aqui mesmo', async () => {
    await montar();
    await userEvent.click(acao('Dia 1B', 'Código TV'));
    await screen.findByText('ABC123');
    await userEvent.click(screen.getByRole('button', { name: 'Abrir aqui' }));
    expect(mockNavigate).toHaveBeenCalledWith('/tv/ABC123');
  });

  it('falha ao gerar o código avisa', async () => {
    await montar({ codigo: new Error('500') });
    await userEvent.click(acao('Dia 1B', 'Código TV'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Não foi possível gerar o código de TV.')
    );
  });
});
