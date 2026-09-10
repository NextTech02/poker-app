/**
 * Escolha do módulo depois do login.
 *
 * A decisão que este arquivo protege é o AUTO-SKIP: todo clube que já usa o
 * sistema tem só o módulo de torneio, e nenhum deles pode ganhar um passo a
 * mais no login por causa de uma funcionalidade que não comprou. A tela só se
 * mostra para quem contratou os dois.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SelectModule from './SelectModule';
import { useModule } from '../contexts/ModuleContext';

jest.mock('../contexts/ModuleContext', () => ({
  useModule: jest.fn(),
  HOME_DO_MODULO: { tournament: '/', cash: '/cash' },
  MODULO_TORNEIO: 'tournament',
  MODULO_CASH: 'cash',
}));

// Prefixo `mock` obrigatório: o factory de jest.mock é içado para o topo do
// arquivo e só enxerga variáveis com esse nome.
const mockNavegar = jest.fn();
jest.mock('react-router-dom', () => ({ useNavigate: () => mockNavegar }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (chave, padrao) => padrao || chave }),
}));
jest.mock('../components/LanguageSelector', () => () => <div data-testid="language-selector" />);
jest.mock('../assets/aceblind-logo-white.png', () => 'logo.png');

let selecionar;

const montar = ({
  module = 'tournament', modules = ['tournament', 'cash'], loading = false,
} = {}) => {
  selecionar = jest.fn();
  useModule.mockReturnValue({
    module,
    modules,
    hasMultipleModules: modules.length > 1,
    selectModule: selecionar,
    loading,
  });
  return render(<SelectModule />);
};

beforeEach(() => {
  mockNavegar.mockClear();
});

describe('auto-skip', () => {
  it('com um módulo só, entra direto na operação', async () => {
    montar({ modules: ['tournament'] });
    await waitFor(() => expect(mockNavegar).toHaveBeenCalledWith('/', { replace: true }));
  });

  it('clube só de cash entra direto no salão', async () => {
    montar({ module: 'cash', modules: ['cash'] });
    await waitFor(() => expect(mockNavegar).toHaveBeenCalledWith('/cash', { replace: true }));
  });

  it('não pula enquanto as permissões carregam', () => {
    // Pular com a lista ainda incompleta mandaria o usuário para o módulo
    // errado e ele teria que trocar na mão logo depois.
    montar({ modules: ['tournament'], loading: true });
    expect(mockNavegar).not.toHaveBeenCalled();
  });

  it('com dois módulos, espera a escolha', () => {
    montar();
    expect(mockNavegar).not.toHaveBeenCalled();
    expect(screen.getByText('Escolha o módulo')).toBeInTheDocument();
  });
});

describe('escolha', () => {
  it('mostra os dois módulos com o que cada um faz', () => {
    montar();
    expect(screen.getByText('Torneios')).toBeInTheDocument();
    expect(screen.getByText('Cash Game')).toBeInTheDocument();
    expect(screen.getByText(/Mesas abertas, fila de espera/)).toBeInTheDocument();
  });

  it('escolher o cash grava e entra no salão', async () => {
    montar();
    await userEvent.click(screen.getByText('Cash Game'));
    expect(selecionar).toHaveBeenCalledWith('cash');
    expect(mockNavegar).toHaveBeenCalledWith('/cash', { replace: true });
  });

  it('não lista módulo que o clube não contratou', () => {
    // Aqui `hasMultipleModules` vem forçado para a tela não pular — o que
    // importa é que a lista respeite o contratado.
    useModule.mockReturnValue({
      module: 'tournament',
      modules: ['tournament'],
      hasMultipleModules: true,
      selectModule: jest.fn(),
      loading: false,
    });
    render(<SelectModule />);
    expect(screen.getByText('Torneios')).toBeInTheDocument();
    expect(screen.queryByText('Cash Game')).toBeNull();
  });
});
