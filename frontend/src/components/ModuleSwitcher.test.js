/**
 * Seletor de módulo (torneio × cash game) no topo do menu.
 *
 * A razão de este teste existir é uma diferença que parece detalhe e não é:
 * o `OrgSwitcher` ao lado precisa de `refreshSession()` + `window.location`
 * porque o RLS decide a organização por um CLAIM ASSINADO — com o token velho
 * na mão, o banco continua devolvendo os dados do clube anterior. Módulo não é
 * claim: quem decide o que abre é o servidor, pela organização. Então trocar de
 * módulo é estado + cache + navegação.
 *
 * Se alguém "padronizar" os dois switchers e colocar um reload aqui, a troca
 * passa a custar um recarregamento inteiro no meio da operação — e é isso que
 * este arquivo trava.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ModuleSwitcher from './ModuleSwitcher';
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

let selecionar;

const montar = ({ module = 'tournament', modules = ['tournament', 'cash'] } = {}) => {
  selecionar = jest.fn();
  useModule.mockReturnValue({
    module,
    modules,
    hasMultipleModules: modules.length > 1,
    selectModule: selecionar,
  });
  return render(<ModuleSwitcher />);
};

beforeEach(() => {
  mockNavegar.mockClear();
});

describe('quando aparece', () => {
  it('some para quem tem um módulo só', () => {
    // A esmagadora maioria dos clubes tem só torneio: eles não podem ganhar um
    // controle a mais no menu por causa de algo que não contrataram.
    const { container } = montar({ modules: ['tournament'] });
    expect(container).toBeEmptyDOMElement();
  });

  it('aparece com dois módulos', () => {
    montar();
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('lista os módulos contratados', () => {
    montar();
    expect(screen.getByRole('option', { name: 'Torneios' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Cash Game' })).toBeInTheDocument();
  });

  it('mostra o módulo ativo', () => {
    montar({ module: 'cash' });
    expect(screen.getByRole('combobox')).toHaveValue('cash');
  });
});

describe('troca', () => {
  it('avisa o contexto e navega para a home do módulo', async () => {
    montar();
    await userEvent.selectOptions(screen.getByRole('combobox'), 'cash');
    expect(selecionar).toHaveBeenCalledWith('cash');
    // Sai da tela atual antes de o menu trocar: a rota aberta pertence ao
    // módulo anterior e o menu novo nem a lista.
    expect(mockNavegar).toHaveBeenCalledWith('/cash', { replace: true });
  });

  it('não recarrega a página (é o que a diferencia do seletor de organização)', async () => {
    const recarregar = jest.fn();
    const original = Object.getOwnPropertyDescriptor(window, 'location');
    delete window.location;
    window.location = { assign: recarregar, reload: recarregar, href: '/' };

    montar();
    await userEvent.selectOptions(screen.getByRole('combobox'), 'cash');
    expect(recarregar).not.toHaveBeenCalled();

    if (original) Object.defineProperty(window, 'location', original);
  });
});
