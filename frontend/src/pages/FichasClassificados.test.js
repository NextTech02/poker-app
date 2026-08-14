/**
 * Fichas dos Classificados — a tela onde o operador registra o stack REAL de
 * cada sobrevivente antes de avançar para o dia final.
 *
 * O que está em jogo:
 *
 * - **O número digitado vira o stack inicial do jogador na final.** Por isso a
 *   tela recusa 0, negativo, decimal e texto: um erro aqui só é descoberto com
 *   a mesa já montada, quando não há mais como recontar as fichas.
 * - **A contagem acontece mesa a mesa.** Reabrir a tela precisa mostrar o que já
 *   foi digitado, e um erro ao salvar não pode limpar o que está na tela — o
 *   operador teria que recontar tudo.
 * - **Só o que mudou é enviado.** Reenviar a lista inteira desfaria a correção
 *   que outro operador acabou de fazer na mesma etapa.
 */
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import FichasClassificados from './FichasClassificados';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() },
}));
jest.mock('../components/Sidebar', () => () => <nav data-testid="sidebar" />);
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useParams: () => ({ dayId: 'd1' }),
  useNavigate: () => mockNavigate,
}));
jest.mock('react-i18next', () => {
  const t = (chave, segundo, terceiro) => {
    const vars = segundo && typeof segundo === 'object' ? segundo : terceiro;
    if (vars) return `${chave}:${Object.values(vars).join(',')}`;
    return typeof segundo === 'string' ? segundo : chave;
  };
  return { useTranslation: () => ({ t, i18n: { language: 'pt-BR' } }) };
});

const DIA = {
  id: 'd1', tournament_id: 't1', day_name: 'Classificatório 1',
  day_type: 'qualifying', qualifies_to_day_id: 'f1', status: 'active',
};

const sobrevivente = (player_id, nome, fichas = null, extra = {}) => ({
  player_id,
  players: { name: nome, nickname: `${nome[0]}zinho` },
  buy_in_count: 1, rebuy_count: 2, addon_count: 1,
  total_chips: 35000,
  final_chip_count: fichas,
  status: 'active',
  ...extra,
});

const SOBREVIVENTES = [
  sobrevivente('p1', 'Ana', 42000),
  sobrevivente('p2', 'Bruno'),
];

let toast;

const responder = ({ dia = DIA, sobreviventes = SOBREVIVENTES } = {}) => {
  api.get.mockImplementation((url) => {
    if (url === '/tournament-days/d1') {
      return dia instanceof Error ? Promise.reject(dia) : Promise.resolve({ data: dia });
    }
    if (url === '/tournament-days/d1/survivors') {
      return sobreviventes instanceof Error
        ? Promise.reject(sobreviventes)
        : Promise.resolve({ data: sobreviventes });
    }
    return Promise.resolve({ data: [] });
  });
};

const montar = async (opcoes) => {
  responder(opcoes);
  render(<MemoryRouter><FichasClassificados /></MemoryRouter>);
  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/tournament-days/d1/survivors'));
  await waitFor(() => expect(document.querySelector('.fc-skeleton')).toBeNull());
};

const campoDe = (playerId) =>
  within(screen.getByTestId(`linha-${playerId}`)).getByRole('spinbutton');

const digitar = (playerId, valor) =>
  fireEvent.change(campoDe(playerId), { target: { value: valor } });

const botaoSalvar = () => screen.getByRole('button', { name: 'common.save' });

beforeEach(() => {
  toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn() };
  useToast.mockReturnValue({ toast, confirm: jest.fn() });
  api.post.mockResolvedValue({ data: { success: true, updated_count: 1 } });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => console.error.mockRestore());

describe('carga da lista', () => {
  it('mostra uma linha por classificado, com nome e apelido', async () => {
    await montar();
    expect(within(screen.getByTestId('linha-p1')).getByText('Ana')).toBeInTheDocument();
    expect(within(screen.getByTestId('linha-p1')).getByText('"Azinho"')).toBeInTheDocument();
    expect(screen.getByTestId('linha-p2')).toBeInTheDocument();
  });

  it('mostra as fichas TEÓRICAS como referência da contagem', async () => {
    // O operador confere o que foi concedido contra o que contou na mesa; uma
    // diferença grande denuncia ficha perdida ou rebuy não lançado.
    await montar();
    expect(within(screen.getByTestId('linha-p1')).getByText(
      Number(35000).toLocaleString()
    )).toBeInTheDocument();
  });

  it('pré-preenche o que já tinha sido registrado antes', async () => {
    // A contagem é feita mesa a mesa: reabrir a tela não pode zerar o trabalho.
    await montar();
    expect(campoDe('p1')).toHaveValue(42000);
    expect(campoDe('p2')).toHaveValue(null);
  });

  it('ordena por nome', async () => {
    await montar({ sobreviventes: [sobrevivente('p3', 'Zeca'), sobrevivente('p1', 'Ana')] });
    const linhas = Array.from(document.querySelectorAll('.fc-linha'));
    expect(linhas[0]).toHaveAttribute('data-testid', 'linha-p1');
  });

  it('dia sem sobreviventes explica em vez de mostrar formulário vazio', async () => {
    await montar({ sobreviventes: [] });
    expect(screen.getByText('Nenhum classificado neste dia')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'common.save' })).toBeNull();
  });

  it('falha ao carregar oferece o caminho de volta', async () => {
    await montar({ sobreviventes: new Error('500') });
    expect(screen.getByText('Não foi possível carregar os classificados deste dia.')).toBeInTheDocument();
  });
});

describe('guardas de contexto', () => {
  it('dia FINAL avisa e não mostra o formulário', async () => {
    // Só dia classificatório tem "classificados"; a tela num dia final gravaria
    // fichas que ninguém lê.
    await montar({ dia: { ...DIA, day_type: 'final' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Este dia não é classificatório');
    expect(screen.queryByRole('button', { name: 'common.save' })).toBeNull();
  });

  it('classificatório sem dia final vinculado avisa, mas deixa registrar', async () => {
    // Vincular o dia final é conserto de configuração; enquanto isso a contagem
    // das mesas não pode parar.
    await montar({ dia: { ...DIA, qualifies_to_day_id: null } });
    expect(screen.getByRole('alert')).toHaveTextContent('ainda não aponta para um dia final');
    expect(botaoSalvar()).toBeInTheDocument();
  });
});

describe('validação do stack digitado', () => {
  it.each([['0'], ['-5'], ['12.5']])('recusa %s com erro na própria linha', async (valor) => {
    await montar();
    digitar('p2', valor);
    expect(within(screen.getByTestId('linha-p2')).getByRole('alert'))
      .toHaveTextContent('Use um número inteiro maior que zero.');
    expect(botaoSalvar()).toBeDisabled();
  });

  it('apagar um valor já registrado é erro, não intenção de zerar', async () => {
    await montar();
    digitar('p1', '');
    expect(within(screen.getByTestId('linha-p1')).getByRole('alert'))
      .toHaveTextContent('Informe as fichas.');
    expect(botaoSalvar()).toBeDisabled();
  });

  it('campo ainda não preenchido não vira erro vermelho', async () => {
    // Quem ainda não chegou naquela mesa fica vazio; marcar erro faria a tela
    // inteira parecer quebrada no começo da contagem.
    await montar();
    expect(within(screen.getByTestId('linha-p2')).queryByRole('alert')).toBeNull();
  });

  it('sem nenhuma mudança não há o que salvar', async () => {
    await montar();
    expect(botaoSalvar()).toBeDisabled();
  });

  it('um valor inválido trava o salvar da lista inteira', async () => {
    await montar();
    digitar('p2', '30000');
    expect(botaoSalvar()).toBeEnabled();
    digitar('p1', '0');
    expect(botaoSalvar()).toBeDisabled();
  });
});

describe('resumo ao vivo', () => {
  it('soma o chipcount e calcula o stack médio conforme o operador digita', async () => {
    // É o número que a mesa confere: chipcount total dividido pelos que já
    // foram contados.
    await montar();
    const rodape = document.querySelector('.fc-rodape');
    expect(within(rodape).getByText('1/2')).toBeInTheDocument();

    digitar('p2', '18000');
    expect(within(rodape).getByText('2/2')).toBeInTheDocument();
    expect(within(rodape).getByText(Number(60000).toLocaleString())).toBeInTheDocument();
    expect(within(rodape).getByText(Number(30000).toLocaleString())).toBeInTheDocument();
  });

  it('avisa enquanto faltar ficha de alguém, porque o avanço fica bloqueado', async () => {
    await montar();
    expect(screen.getByText(/só é liberado quando todos os classificados/)).toBeInTheDocument();
    digitar('p2', '18000');
    expect(screen.queryByText(/só é liberado quando todos os classificados/)).toBeNull();
  });
});

describe('salvar', () => {
  it('envia SÓ os classificados alterados, numa chamada', async () => {
    // Reenviar a lista toda desfaria a correção que outro operador acabou de
    // fazer na mesma etapa.
    await montar();
    digitar('p2', '18000');
    await userEvent.click(botaoSalvar());
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/tournament-days/d1/bulk-update-chips',
      { updates: [{ player_id: 'p2', chip_count: 18000 }] }
    ));
  });

  it('recarrega a lista depois de salvar, para reconciliar com o servidor', async () => {
    await montar();
    digitar('p2', '18000');
    await userEvent.click(botaoSalvar());
    await waitFor(() => expect(
      api.get.mock.calls.filter((c) => c[0].endsWith('/survivors')).length
    ).toBe(2));
    expect(toast.success).toHaveBeenCalled();
  });

  it('gravou menos do que enviou vira aviso, não sucesso', async () => {
    // Menos linhas gravadas = algum jogador não está mais neste dia. Dizer
    // "salvo" faria o operador seguir para o avanço e levar um 400.
    api.post.mockResolvedValue({ data: { updated_count: 0 } });
    await montar();
    digitar('p2', '18000');
    await userEvent.click(botaoSalvar());
    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('erro ao salvar mostra o motivo e PRESERVA o que foi digitado', async () => {
    // Limpar a tela obrigaria a recontar as mesas.
    const e = new Error('500');
    e.response = { data: { detail: 'Dia encerrado' } };
    api.post.mockRejectedValue(e);
    await montar();
    digitar('p2', '18000');
    await userEvent.click(botaoSalvar());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Dia encerrado'));
    expect(campoDe('p2')).toHaveValue(18000);
  });
});

describe('busca', () => {
  const muitos = Array.from({ length: 25 }, (_, i) =>
    sobrevivente(`p${i}`, `Jogador ${String(i).padStart(2, '0')}`));

  it('a busca só aparece quando a lista é grande demais para varrer com o olho', async () => {
    await montar();
    expect(screen.queryByRole('searchbox')).toBeNull();
    await montar({ sobreviventes: muitos });
    expect(screen.getByRole('searchbox')).toBeInTheDocument();
  });

  it('filtra por nome sem perder o que já foi digitado nas outras linhas', async () => {
    await montar({ sobreviventes: muitos });
    digitar('p3', '15000');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Jogador 07' } });
    expect(screen.getByTestId('linha-p7')).toBeInTheDocument();
    expect(screen.queryByTestId('linha-p3')).toBeNull();

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
    expect(campoDe('p3')).toHaveValue(15000);
  });
});

describe('navegação', () => {
  it('voltar leva ao torneio do dia', async () => {
    await montar();
    await userEvent.click(screen.getByRole('button', { name: 'common.back' }));
    expect(mockNavigate).toHaveBeenCalledWith('/torneios/t1');
  });
});
