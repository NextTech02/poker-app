/**
 * Barras e seletores do topo: OfflineBanner, SelectedStageBar,
 * LanguageSelector e ErrorBoundary.
 *
 * O ponto comum é que essas peças aparecem em TODAS as telas, então um erro
 * nelas não fica contido:
 *
 * - O banner de offline é a única pista de que as ações estão indo para a
 *   fila. Ele só some quando está tudo online E sem pendências — mostrar
 *   "tudo certo" com operações não enviadas faria o operador fechar o
 *   navegador e perder o evento.
 * - O ErrorBoundary distingue "quebrou" de "sem conexão". A mensagem
 *   alarmante de erro no meio de um evento faz o operador achar que perdeu
 *   tudo; o aviso calmo de rede diz o que fazer.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import OfflineBanner from './OfflineBanner';
import SelectedStageBar from './SelectedStageBar';
import LanguageSelector from './LanguageSelector';
import ErrorBoundary from './ErrorBoundary';
import { useConnectivity } from '../contexts/ConnectivityContext';
import { useStage } from '../contexts/StageContext';
import { isOnline } from '../offline/connectivity';

jest.mock('../contexts/ConnectivityContext', () => ({ useConnectivity: jest.fn() }));
jest.mock('../contexts/StageContext', () => ({ useStage: jest.fn() }));
jest.mock('../offline/connectivity', () => ({ isOnline: jest.fn() }));

// O prefixo `mock` e exigido pelo Jest: so variaveis assim podem ser
// referenciadas de dentro da fabrica de um jest.mock.
const mockTrocarIdioma = jest.fn();
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (chave, padrao) => padrao || chave,
    i18n: {
      language: 'pt-BR',
      changeLanguage: (...a) => mockTrocarIdioma(...a),
    },
  }),
}));
jest.mock('i18next', () => ({ t: (chave, padrao) => padrao || chave }));

const comRouter = (ui) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('OfflineBanner', () => {
  const estado = (extra) =>
    useConnectivity.mockReturnValue({
      isOnline: true,
      pendingCount: 0,
      conflictCount: 0,
      ...extra,
    });

  it('some quando está tudo online e sem pendências', () => {
    estado();
    const { container } = comRouter(<OfflineBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('offline avisa que as ações estão sendo guardadas', () => {
    // É a única pista de que o trabalho não está indo para o servidor.
    estado({ isOnline: false });
    comRouter(<OfflineBanner />);
    expect(screen.getByRole('status')).toHaveTextContent(/Modo offline/);
  });

  it('offline mostra quantas operações estão na fila', () => {
    estado({ isOnline: false, pendingCount: 3 });
    comRouter(<OfflineBanner />);
    expect(screen.getByRole('status')).toHaveTextContent('3');
  });

  it('online com pendências mostra que está sincronizando', () => {
    // O operador precisa saber que ainda não pode fechar o navegador.
    estado({ pendingCount: 2 });
    comRouter(<OfflineBanner />);
    expect(screen.getByRole('status')).toHaveTextContent(/Sincronizando/);
  });

  it('conflito vira alerta clicável para a tela de revisão', () => {
    // Conflito não se resolve sozinho: alguém precisa decidir.
    estado({ conflictCount: 2 });
    comRouter(<OfflineBanner />);
    const alerta = screen.getByRole('alert');
    expect(alerta).toHaveTextContent('2');
    expect(alerta).toHaveAttribute('href', '/conflitos');
  });

  it('offline tem prioridade sobre conflito', () => {
    // Sem rede não dá para revisar nada; o aviso útil é o de offline.
    estado({ isOnline: false, conflictCount: 5 });
    comRouter(<OfflineBanner />);
    expect(screen.getByRole('status')).toHaveTextContent(/Modo offline/);
  });
});

describe('SelectedStageBar', () => {
  it('sem etapa selecionada não aparece', () => {
    useStage.mockReturnValue({ selectedStage: null, clearStage: jest.fn() });
    const { container } = render(<SelectedStageBar />);
    expect(container).toBeEmptyDOMElement();
  });

  it('mostra o nome da etapa ativa', () => {
    // É o que evita o operador registrar jogador na etapa errada.
    useStage.mockReturnValue({
      selectedStage: { id: 'e1', name: 'Etapa Rio' },
      clearStage: jest.fn(),
    });
    render(<SelectedStageBar />);
    expect(screen.getByText('Etapa Rio')).toBeInTheDocument();
  });

  it('mostra local e período quando existem', () => {
    useStage.mockReturnValue({
      selectedStage: {
        id: 'e1',
        name: 'Etapa Rio',
        location: 'Copacabana',
        start_date: '2026-06-08',
        end_date: '2026-06-12',
      },
      clearStage: jest.fn(),
    });
    const { container } = render(<SelectedStageBar />);
    expect(container.textContent).toContain('Copacabana');
    expect(container.querySelector('.stage-dates').textContent).toContain('/');
  });

  it('sem data final mostra só a inicial', () => {
    useStage.mockReturnValue({
      selectedStage: { id: 'e1', name: 'X', start_date: '2026-06-08' },
      clearStage: jest.fn(),
    });
    const { container } = render(<SelectedStageBar />);
    expect(container.querySelector('.stage-dates').textContent).not.toContain('-');
  });

  it('permite sair da etapa', async () => {
    const limpar = jest.fn();
    useStage.mockReturnValue({
      selectedStage: { id: 'e1', name: 'X' },
      clearStage: limpar,
    });
    render(<SelectedStageBar />);
    await userEvent.click(screen.getByRole('button'));
    expect(limpar).toHaveBeenCalled();
  });

  it('abre espaço para a barra no conteúdo e devolve ao sair', () => {
    // Sem a classe, a barra fixa cobre o topo da tela por baixo.
    document.body.innerHTML = '<div class="main-content"></div>';
    useStage.mockReturnValue({
      selectedStage: { id: 'e1', name: 'X' },
      clearStage: jest.fn(),
    });
    const { unmount } = render(<SelectedStageBar />);
    const conteudo = document.querySelector('.main-content');
    expect(conteudo).toHaveClass('with-stage-bar');
    unmount();
    expect(conteudo).not.toHaveClass('with-stage-bar');
  });
});

describe('LanguageSelector', () => {
  beforeEach(() => mockTrocarIdioma.mockClear());

  it('mostra o idioma atual', () => {
    render(<LanguageSelector />);
    expect(screen.getByText('PT')).toBeInTheDocument();
  });

  it('começa fechado', () => {
    render(<LanguageSelector />);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  });

  it('abre a lista dos três idiomas', async () => {
    render(<LanguageSelector />);
    await userEvent.click(screen.getByRole('button'));
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('marca o idioma ativo como selecionado', async () => {
    render(<LanguageSelector />);
    await userEvent.click(screen.getByRole('button'));
    const ativo = screen.getByRole('option', { selected: true });
    expect(ativo).toHaveTextContent('Português');
  });

  it('trocar de idioma aplica e fecha a lista', async () => {
    render(<LanguageSelector />);
    await userEvent.click(screen.getByRole('button'));
    await userEvent.click(screen.getByRole('option', { name: /English/ }));
    expect(mockTrocarIdioma).toHaveBeenCalledWith('en-US');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('clicar fora fecha a lista', async () => {
    // Sem isso, a lista fica aberta cobrindo o conteúdo até alguém acertar o
    // botão de novo.
    render(
      <div>
        <LanguageSelector />
        <button>fora</button>
      </div>
    );
    await userEvent.click(screen.getByRole('button', { name: /PT/ }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'fora' }));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('a direção da abertura é configurável', async () => {
    // No rodapé da barra lateral, abrir para baixo jogaria a lista para fora
    // da tela.
    const { container } = render(<LanguageSelector dropDirection="up" />);
    await userEvent.click(screen.getByRole('button'));
    expect(container.querySelector('.language-dropdown--up')).toBeInTheDocument();
  });
});

describe('ErrorBoundary', () => {
  const Explode = () => {
    throw new Error('quebrou');
  };

  let erroConsole;
  beforeEach(() => {
    erroConsole = jest.spyOn(console, 'error').mockImplementation(() => {});
    isOnline.mockReturnValue(true);
  });
  afterEach(() => erroConsole.mockRestore());

  it('sem erro, mostra o conteúdo', () => {
    render(<ErrorBoundary><span>conteúdo</span></ErrorBoundary>);
    expect(screen.getByText('conteúdo')).toBeInTheDocument();
  });

  it('erro com rede mostra a falha e o botão de tentar de novo', () => {
    render(<ErrorBoundary><Explode /></ErrorBoundary>);
    expect(screen.getByText(/Não foi possível carregar/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Tentar novamente/ })).toBeInTheDocument();
  });

  it('aceita título e subtítulo próprios', () => {
    render(
      <ErrorBoundary title="Relatório indisponível" subtitle="Tente mais tarde">
        <Explode />
      </ErrorBoundary>
    );
    expect(screen.getByText('Relatório indisponível')).toBeInTheDocument();
    expect(screen.getByText('Tente mais tarde')).toBeInTheDocument();
  });

  it('erro SEM rede mostra o aviso calmo de conexão', () => {
    // Uma tela nunca aberta online não tem cache e estoura ao renderizar. O
    // alarme de "erro na aplicação" faria o operador achar que perdeu o
    // evento; o aviso de rede diz o que fazer.
    isOnline.mockReturnValue(false);
    render(<ErrorBoundary><Explode /></ErrorBoundary>);
    expect(screen.getByText('Sem conexão')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Voltar/ })).toBeInTheDocument();
  });

  it('o botão de voltar usa o histórico do navegador', async () => {
    isOnline.mockReturnValue(false);
    const voltar = jest.spyOn(window.history, 'back').mockImplementation(() => {});
    render(<ErrorBoundary><Explode /></ErrorBoundary>);
    await userEvent.click(screen.getByRole('button', { name: /Voltar/ }));
    expect(voltar).toHaveBeenCalled();
    voltar.mockRestore();
  });

  it('registra o erro para diagnóstico', () => {
    render(<ErrorBoundary><Explode /></ErrorBoundary>);
    expect(erroConsole).toHaveBeenCalledWith(
      '[ErrorBoundary]',
      expect.any(Error),
      expect.any(Object)
    );
  });

  it('tentar de novo volta a renderizar o conteúdo', async () => {
    // Falha transitória (uma consulta que deu erro) não pode obrigar a
    // recarregar a página inteira e perder o estado das outras telas.
    let deveQuebrar = true;
    const Instavel = () => {
      if (deveQuebrar) throw new Error('quebrou');
      return <span>recuperado</span>;
    };
    render(<ErrorBoundary><Instavel /></ErrorBoundary>);
    deveQuebrar = false;
    await userEvent.click(screen.getByRole('button', { name: /Tentar novamente/ }));
    expect(screen.getByText('recuperado')).toBeInTheDocument();
  });
});
