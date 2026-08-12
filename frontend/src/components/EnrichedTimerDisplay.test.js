/**
 * Painel de blinds ao lado do relógio.
 *
 * Ele responde as duas perguntas que os jogadores fazem ao staff durante a
 * mão: "quanto está o blind?" e "quando é o intervalo?".
 *
 * A decisão mais importante é o **fracasso silencioso**: se o relógio falhar,
 * o componente não renderiza nada em vez de mostrar erro. Ele é secundário na
 * tela — o relógio principal continua funcionando, e um bloco vermelho de
 * erro no meio da transmissão assustaria o salão inteiro por um detalhe.
 *
 * O intervalo tem tratamento próprio: durante ele não existe blind, e mostrar
 * "0/0" faria o staff achar que a estrutura quebrou.
 */
import { render, screen } from '@testing-library/react';
import EnrichedTimerDisplay from './EnrichedTimerDisplay';
import { useTimerSync } from '../hooks/useTimerSync';

jest.mock('../hooks/useTimerSync', () => ({
  useTimerSync: jest.fn(),
  formatTime: (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`,
  formatTimeHuman: (s) => `${Math.round(s / 60)}min`,
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (chave, vars) =>
      vars && typeof vars === 'object'
        ? `${chave} ${Object.values(vars).join(' ')}`
        : chave,
  }),
}));

const estado = (extra = {}) => ({
  timerState: {
    current_blind: { small_blind: 100, big_blind: 200, ante: 0, duration: 15, is_break: false },
    next_blind: { small_blind: 200, big_blind: 400, ante: 200, duration: 15, is_break: false },
    next_break: { time_until_break: 1200 },
    time_remaining_current_level: 300,
    ...extra,
  },
  isLoading: false,
  error: null,
});

const montar = (props = {}, sobrescreve = {}) => {
  useTimerSync.mockReturnValue({ ...estado(), ...sobrescreve });
  return render(<EnrichedTimerDisplay dayId="d1" {...props} />);
};

describe('estados de falha', () => {
  it('enquanto carrega mostra um aviso curto', () => {
    montar({}, { timerState: null, isLoading: true, error: null });
    expect(screen.getByText('common.loading')).toBeInTheDocument();
  });

  it('erro no relógio não mostra nada', () => {
    // Um bloco de erro no meio da transmissão assustaria o salão por um
    // detalhe: o relógio principal continua funcionando.
    const { container } = montar({}, { timerState: null, isLoading: false, error: 'falhou' });
    expect(container).toBeEmptyDOMElement();
  });

  it('sem estado do relógio também não mostra nada', () => {
    const { container } = montar({}, { timerState: null, isLoading: false, error: null });
    expect(container).toBeEmptyDOMElement();
  });
});

describe('versão completa', () => {
  it('mostra os blinds atuais', () => {
    montar();
    expect(screen.getByText('100')).toBeInTheDocument();
    expect(screen.getByText('200')).toBeInTheDocument();
  });

  it('sem ante a linha não aparece', () => {
    // Um "Ante 0" faria o dealer procurar uma ficha que ninguém deve pôr.
    montar();
    expect(screen.queryByText('timer.ante')).toBeNull();
  });

  it('com ante a linha aparece', () => {
    useTimerSync.mockReturnValue(
      estado({ current_blind: { small_blind: 100, big_blind: 200, ante: 200, is_break: false } })
    );
    render(<EnrichedTimerDisplay dayId="d1" />);
    expect(screen.getByText('timer.ante')).toBeInTheDocument();
  });

  it('durante o intervalo mostra o intervalo, não blinds zerados', () => {
    // "0/0" faria o staff achar que a estrutura quebrou.
    useTimerSync.mockReturnValue(
      estado({ current_blind: { small_blind: 0, big_blind: 0, ante: 0, is_break: true } })
    );
    render(<EnrichedTimerDisplay dayId="d1" />);
    expect(screen.getByText('timer.break')).toBeInTheDocument();
    expect(screen.queryByText('timer.smallBlind')).toBeNull();
  });

  it('mostra o próximo nível', () => {
    // É o que o jogador pergunta antes de decidir se entra na mão.
    montar();
    expect(screen.getByText('timer.nextLevel')).toBeInTheDocument();
    expect(screen.getByText(/200 \/ 400/)).toBeInTheDocument();
  });

  it('próximo nível sendo intervalo mostra a duração', () => {
    useTimerSync.mockReturnValue(
      estado({ next_blind: { is_break: true, duration: 600 } })
    );
    render(<EnrichedTimerDisplay dayId="d1" />);
    expect(screen.getByText(/timer.breakMinutes 10/)).toBeInTheDocument();
  });

  it('mostra quanto falta para o intervalo', () => {
    // Sem isso o jogador não sabe se dá tempo de sair da mesa.
    montar();
    expect(screen.getByText('20min')).toBeInTheDocument();
  });

  it('durante o intervalo não mostra a contagem para o próximo', () => {
    // Já está nele; a contagem seria informação contraditória.
    useTimerSync.mockReturnValue(
      estado({ current_blind: { small_blind: 0, big_blind: 0, ante: 0, is_break: true } })
    );
    render(<EnrichedTimerDisplay dayId="d1" />);
    expect(screen.queryByText('timer.nextBreak')).toBeNull();
  });

  it('sem intervalo à frente a seção some', () => {
    useTimerSync.mockReturnValue(estado({ next_break: null }));
    render(<EnrichedTimerDisplay dayId="d1" />);
    expect(screen.queryByText('timer.nextBreak')).toBeNull();
  });

  it('sem próximo nível a seção some', () => {
    // Último nível da estrutura.
    useTimerSync.mockReturnValue(estado({ next_blind: null }));
    render(<EnrichedTimerDisplay dayId="d1" />);
    expect(screen.queryByText('timer.nextLevel')).toBeNull();
  });

  it('sem blind atual a seção some', () => {
    useTimerSync.mockReturnValue(estado({ current_blind: null }));
    render(<EnrichedTimerDisplay dayId="d1" />);
    expect(screen.queryByText('timer.smallBlind')).toBeNull();
  });
});

describe('versão compacta', () => {
  it('mostra só próximo nível e contagem do intervalo', () => {
    // Cabe ao lado do relógio sem competir com ele.
    montar({ compact: true });
    expect(screen.getByText('timer.next')).toBeInTheDocument();
    expect(screen.getByText('timer.breakIn')).toBeInTheDocument();
    expect(screen.queryByText('timer.smallBlind')).toBeNull();
  });

  it('mostra os valores do próximo nível com ante', () => {
    montar({ compact: true });
    expect(screen.getByText(/200\/400/)).toBeInTheDocument();
    expect(screen.getByText(/\(200\)/)).toBeInTheDocument();
  });

  it('próximo sendo intervalo mostra a duração', () => {
    useTimerSync.mockReturnValue(estado({ next_blind: { is_break: true, duration: 600 } }));
    render(<EnrichedTimerDisplay dayId="d1" compact />);
    expect(screen.getByText(/timer.breakWithDuration 10/)).toBeInTheDocument();
  });

  it('sem próximo nível a seção some', () => {
    useTimerSync.mockReturnValue(estado({ next_blind: null }));
    render(<EnrichedTimerDisplay dayId="d1" compact />);
    expect(screen.queryByText('timer.next')).toBeNull();
  });

  it('sem intervalo à frente a contagem some', () => {
    useTimerSync.mockReturnValue(estado({ next_break: null }));
    render(<EnrichedTimerDisplay dayId="d1" compact />);
    expect(screen.queryByText('timer.breakIn')).toBeNull();
  });
});
