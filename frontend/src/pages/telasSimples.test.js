/**
 * Telas simples: ComingSoon/404, acesso da TV por código e revisão de
 * conflitos de sincronização.
 *
 * As três só existem por causa de um caminho de exceção:
 *
 * - **ComingSoon** cobre rotas do menu que ainda não têm tela. Sem ela, o
 *   operador clicaria e cairia numa página em branco.
 * - **TVCode** é a única entrada PÚBLICA do sistema: a TV do salão não faz
 *   login. Digita-se o código e ela vai para a transmissão do dia.
 * - **SyncConflicts** é o destino das operações offline que o servidor
 *   REJEITOU. Descartar é a única saída possível — mas tem que limpar a
 *   fila junto, senão a operação seria reenviada para sempre.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ComingSoon from './ComingSoon';
import TVCode from './TVCode';
import SyncConflicts from './SyncConflicts';
import api from '../config/api';
import { getConflicts, removeConflict, removeMutation } from '../offline/db';
import { notifyQueueChanged } from '../offline/queue';

jest.mock('../config/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('../components/Sidebar', () => () => <nav data-testid="sidebar" />);
jest.mock('../offline/db', () => ({
  getConflicts: jest.fn(),
  removeConflict: jest.fn(),
  removeMutation: jest.fn(),
}));
jest.mock('../offline/queue', () => ({ notifyQueueChanged: jest.fn() }));

const mockNavegar = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavegar,
}));

jest.mock('react-i18next', () => {
  const t = (chave, padrao) => (typeof padrao === 'string' ? padrao : chave);
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

beforeEach(() => {
  mockNavegar.mockClear();
  getConflicts.mockResolvedValue([]);
  removeConflict.mockResolvedValue(undefined);
  removeMutation.mockResolvedValue(undefined);
});

describe('ComingSoon', () => {
  const montar = (props) =>
    render(
      <MemoryRouter>
        <ComingSoon {...props} />
      </MemoryRouter>
    );

  it('avisa que a tela está em construção', () => {
    montar();
    expect(screen.getByText('Em Construção')).toBeInTheDocument();
    expect(screen.getByText('🚧')).toBeInTheDocument();
  });

  it('a variante de rota inexistente tem texto próprio', () => {
    // "Em construção" numa URL digitada errada seria mentira e faria o
    // operador esperar por uma tela que nunca virá.
    montar({ variant: 'notFound' });
    expect(screen.getByText('Página não encontrada')).toBeInTheDocument();
    expect(screen.getByText('404')).toBeInTheDocument();
  });

  it('oferece o caminho de volta', () => {
    // Sem o botão, a saída seria o botão do navegador — e o menu lateral
    // some em telas de erro em algumas rotas.
    montar();
    expect(screen.getByRole('button', { name: /Voltar ao Início/ })).toBeInTheDocument();
  });

  it('voltar leva para a raiz', async () => {
    montar();
    await userEvent.click(screen.getByRole('button', { name: /Voltar ao Início/ }));
    expect(mockNavegar).toHaveBeenCalledWith('/');
  });

  it('mantém o menu lateral', () => {
    montar();
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
  });
});

describe('TVCode', () => {
  const montar = (rota = '/tv') =>
    render(
      <MemoryRouter initialEntries={[rota]}>
        <Routes>
          <Route path="/tv" element={<TVCode />} />
          <Route path="/tv/:code" element={<TVCode />} />
        </Routes>
      </MemoryRouter>
    );

  it('pede o código', () => {
    montar();
    expect(screen.getByPlaceholderText('XXXXXX')).toBeInTheDocument();
  });

  it('o código digitado vira maiúsculo', () => {
    // O código é comparado exato no servidor; quem digita na TV não vai
    // se preocupar com caixa.
    montar();
    const campo = screen.getByPlaceholderText('XXXXXX');
    return userEvent.type(campo, 'abc234').then(() => {
      expect(campo).toHaveValue('ABC234');
    });
  });

  it('o botão fica travado sem código', () => {
    montar();
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('código válido leva à transmissão do DIA', async () => {
    api.get.mockResolvedValue({ data: { day_id: 'dia-1', tournament_id: 't1' } });
    montar();
    await userEvent.type(screen.getByPlaceholderText('XXXXXX'), 'ABC234');
    await userEvent.click(screen.getByRole('button'));
    await waitFor(() =>
      expect(mockNavegar).toHaveBeenCalledWith('/broadcast/dia-1', { replace: true })
    );
  });

  it('substitui a entrada no histórico', async () => {
    // Sem `replace`, o botão "voltar" da TV traria de volta a tela de
    // código — e alguém teria que redigitar.
    api.get.mockResolvedValue({ data: { day_id: 'dia-1' } });
    montar();
    await userEvent.type(screen.getByPlaceholderText('XXXXXX'), 'ABC234');
    await userEvent.click(screen.getByRole('button'));
    await waitFor(() =>
      expect(mockNavegar).toHaveBeenCalledWith(expect.any(String), { replace: true })
    );
  });

  it('sem dia cai no torneio', async () => {
    // Código antigo, de antes de a transmissão ser por dia.
    api.get.mockResolvedValue({ data: { tournament_id: 't1' } });
    montar();
    await userEvent.type(screen.getByPlaceholderText('XXXXXX'), 'ABC234');
    await userEvent.click(screen.getByRole('button'));
    await waitFor(() =>
      expect(mockNavegar).toHaveBeenCalledWith('/broadcast/t1', { replace: true })
    );
  });

  it('sem dia nem torneio avisa em vez de navegar para lugar nenhum', async () => {
    api.get.mockResolvedValue({ data: {} });
    montar();
    await userEvent.type(screen.getByPlaceholderText('XXXXXX'), 'ABC234');
    await userEvent.click(screen.getByRole('button'));
    expect(await screen.findByText(/Torneio sem dia para exibir/)).toBeInTheDocument();
    expect(mockNavegar).not.toHaveBeenCalled();
  });

  it('código inválido avisa sem revelar nada do torneio', async () => {
    // A rota é aberta à internet: a mensagem não pode confirmar a existência
    // de um evento.
    api.get.mockRejectedValue({ response: { status: 404 } });
    montar();
    await userEvent.type(screen.getByPlaceholderText('XXXXXX'), 'ZZZZZZ');
    await userEvent.click(screen.getByRole('button'));
    expect(await screen.findByText(/Código inválido/)).toBeInTheDocument();
  });

  it('sem rede não diz que o código é inválido', async () => {
    // Servidor fora ou TV sem internet: "código inválido" mandaria o operador
    // conferir um código que está certo.
    api.get.mockRejectedValue({ message: 'Network Error' });
    montar();
    await userEvent.type(screen.getByPlaceholderText('XXXXXX'), 'ABC234');
    await userEvent.click(screen.getByRole('button'));
    expect(await screen.findByText(/Não foi possível conectar/)).toBeInTheDocument();
    expect(screen.queryByText(/Código inválido/)).not.toBeInTheDocument();
  });

  it('consulta o código SEM o token de quem estiver logado no navegador', async () => {
    // Regressão: um código certo dava "inválido" quando a TV era aberta num
    // navegador logado em OUTRA organização — o token ia junto e o backend
    // buscava o dia sob o RLS desse usuário. A TV não faz login.
    api.get.mockResolvedValue({ data: { day_id: 'dia-1' } });
    montar();
    await userEvent.type(screen.getByPlaceholderText('XXXXXX'), 'ABC234');
    await userEvent.click(screen.getByRole('button'));
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/public/tv/ABC234', { _public: true })
    );
  });

  it('espaços em volta do código são removidos', async () => {
    api.get.mockResolvedValue({ data: { day_id: 'dia-1' } });
    render(
      <MemoryRouter initialEntries={['/tv/  abc234  ']}>
        <Routes>
          <Route path="/tv/:code" element={<TVCode />} />
        </Routes>
      </MemoryRouter>
    );
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/public/tv/ABC234', { _public: true })
    );
  });

  it('o código na URL resolve sozinho', async () => {
    // É assim que o clube salva o link direto na TV, sem ninguém digitar.
    api.get.mockResolvedValue({ data: { day_id: 'dia-9' } });
    montar('/tv/XYZ789');
    await waitFor(() =>
      expect(mockNavegar).toHaveBeenCalledWith('/broadcast/dia-9', { replace: true })
    );
  });

  it('código vazio na URL não dispara consulta', async () => {
    montar('/tv');
    await waitFor(() => expect(api.get).not.toHaveBeenCalled());
  });
});

describe('SyncConflicts', () => {
  const conflito = (extra = {}) => ({
    id: 'c1',
    reason: 'Jogador já inscrito neste dia',
    at: 1749000000000,
    mutation: {
      kind: 'register',
      method: 'post',
      url: '/tournament-players',
      meta: { name: 'Ana Souza' },
    },
    ...extra,
  });

  const montar = async (conflitos = []) => {
    getConflicts.mockResolvedValue(conflitos);
    render(
      <MemoryRouter>
        <SyncConflicts />
      </MemoryRouter>
    );
    await waitFor(() => expect(getConflicts).toHaveBeenCalled());
  };

  it('sem conflito mostra o estado tranquilo', async () => {
    await montar([]);
    expect(await screen.findByText('Nenhum conflito')).toBeInTheDocument();
  });

  it('mostra o motivo da rejeição', async () => {
    // Sem o motivo, o operador não tem como decidir o que fazer.
    await montar([conflito()]);
    expect(await screen.findByText('Jogador já inscrito neste dia')).toBeInTheDocument();
  });

  it('mostra o tipo de operação em português', async () => {
    // "register" não diz nada para quem opera o caixa.
    await montar([conflito()]);
    expect(await screen.findByText('Registro')).toBeInTheDocument();
  });

  it('tipo desconhecido aparece como veio, sem quebrar', async () => {
    await montar([conflito({ mutation: { kind: 'operacao_nova', url: '/x' } })]);
    expect(await screen.findByText('operacao_nova')).toBeInTheDocument();
  });

  it('mostra o nome do jogador envolvido', async () => {
    // Um conflito que só mostra um uuid é inútil no balcão.
    await montar([conflito()]);
    expect(await screen.findByText(/Ana Souza/)).toBeInTheDocument();
  });

  it('conflito sem motivo tem um texto padrão', async () => {
    await montar([conflito({ reason: null })]);
    expect(await screen.findByText('Rejeitado pelo servidor')).toBeInTheDocument();
  });

  it('os mais recentes vêm primeiro', async () => {
    await montar([
      conflito({ id: 'antigo', at: 1, mutation: { kind: 'rebuy', url: '/a' } }),
      conflito({ id: 'novo', at: 9999, mutation: { kind: 'addon', url: '/b' } }),
    ]);
    await screen.findByText('Add-on');
    const cartoes = document.querySelectorAll('.conflict-card');
    expect(cartoes[0]).toHaveTextContent('Add-on');
  });

  it('descartar limpa o conflito E a fila', async () => {
    // Só remover o conflito deixaria a operação na fila, e ela seria
    // reenviada para sempre — rejeitada de novo a cada tentativa.
    await montar([conflito()]);
    await userEvent.click(await screen.findByRole('button', { name: 'Descartar' }));
    await waitFor(() => expect(removeConflict).toHaveBeenCalledWith('c1'));
    expect(removeMutation).toHaveBeenCalledWith('c1');
  });

  it('descartar avisa a interface para atualizar o contador', async () => {
    await montar([conflito()]);
    await userEvent.click(await screen.findByRole('button', { name: 'Descartar' }));
    await waitFor(() => expect(notifyQueueChanged).toHaveBeenCalled());
  });

  it('conflito sem operação associada não quebra a tela', async () => {
    // Dado inconsistente não pode impedir o operador de limpar a lista.
    await montar([{ id: 'c9', reason: 'erro', at: 1 }]);
    expect(await screen.findByText('erro')).toBeInTheDocument();
  });
});
