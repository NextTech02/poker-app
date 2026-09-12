/**
 * Módulo ativo (torneio × cash game).
 *
 * O clube contrata um módulo, o outro ou os dois. A escolha decide qual menu a
 * sidebar monta e quais rotas existem — mas NÃO é isolamento de dados (isso
 * continua sendo organization_id + RLS no servidor).
 *
 * O que estes testes travam:
 *
 * 1. **O piso `tournament`.** Todo clube que já usava o sistema fazia torneio.
 *    Lista vazia — enquanto as permissões carregam, ou quando a chamada falha —
 *    não pode virar "nenhum módulo": seria a sidebar em branco.
 * 2. **A escolha guardada só vale enquanto o clube ainda tem o módulo.** Se o
 *    cash for desligado (ou o funcionário trocar de clube), o valor velho no
 *    localStorage apontaria para telas que o backend recusa. Cair no primeiro
 *    disponível mantém a sessão utilizável sem exigir logout.
 * 3. **Trocar limpa o cache.** As respostas guardadas são do módulo anterior;
 *    sem a limpeza, a tela nova serviria dados da operação errada — é o mesmo
 *    motivo do StageContext.
 */
import { render, screen, act } from '@testing-library/react';
import { ModuleProvider, useModule } from './ModuleContext';
import { usePermissions } from './PermissionContext';
import { clearCache } from '../utils/apiCache';

jest.mock('./PermissionContext', () => ({ usePermissions: jest.fn() }));
jest.mock('../utils/apiCache', () => ({ clearCache: jest.fn() }));

let api;

function Sonda() {
  api = useModule();
  return (
    <div>
      <span data-testid="module">{api.module}</span>
      <span data-testid="modules">{api.modules.join(',')}</span>
      <span data-testid="multiplos">{String(api.hasMultipleModules)}</span>
      <span data-testid="home">{api.homePath}</span>
    </div>
  );
}

const montar = ({ modules = ['tournament'], loading = false } = {}) => {
  usePermissions.mockReturnValue({ modules, loading });
  return render(<ModuleProvider><Sonda /></ModuleProvider>);
};

/** As permissões chegam DEPOIS da primeira pintura, como no recarregar. */
const permissoesChegam = (utils, modules) => {
  usePermissions.mockReturnValue({ modules, loading: false });
  utils.rerender(<ModuleProvider><Sonda /></ModuleProvider>);
};

beforeEach(() => {
  localStorage.clear();
  clearCache.mockClear();
  api = null;
});

describe('escolha inicial', () => {
  it('com um módulo só, é ele o ativo', () => {
    montar({ modules: ['tournament'] });
    expect(screen.getByTestId('module')).toHaveTextContent('tournament');
    expect(screen.getByTestId('multiplos')).toHaveTextContent('false');
  });

  it('clube só de cash abre no cash', () => {
    montar({ modules: ['cash'] });
    expect(screen.getByTestId('module')).toHaveTextContent('cash');
    expect(screen.getByTestId('home')).toHaveTextContent('/cash');
  });

  it('restaura a escolha guardada', () => {
    localStorage.setItem('selected_module', 'cash');
    montar({ modules: ['tournament', 'cash'] });
    expect(screen.getByTestId('module')).toHaveTextContent('cash');
  });

  it('sem escolha guardada, com dois módulos, fica no primeiro', () => {
    montar({ modules: ['tournament', 'cash'] });
    expect(screen.getByTestId('module')).toHaveTextContent('tournament');
    expect(screen.getByTestId('multiplos')).toHaveTextContent('true');
  });

  it('lista vazia cai no torneio', () => {
    // Acontece enquanto as permissões carregam e quando a chamada falha.
    montar({ modules: [] });
    expect(screen.getByTestId('modules')).toHaveTextContent('tournament');
  });

  it('módulo guardado que o clube não tem mais é descartado', () => {
    // O cash foi desligado: a escolha velha levaria a telas que o backend
    // recusa com 403. O ATIVO passa a ser o torneio.
    //
    // O que este teste NÃO afirma mais, de propósito: que o localStorage seja
    // reescrito. Ele era, e essa gravação era o bug do F5 — ver
    // "o F5 não pode apagar a escolha" abaixo. Deixar o valor velho guardado
    // não custa nada, porque o módulo ativo é derivado a cada render.
    localStorage.setItem('selected_module', 'cash');
    montar({ modules: ['tournament'] });
    expect(screen.getByTestId('module')).toHaveTextContent('tournament');
  });

  it('o F5 não pode apagar a escolha enquanto as permissões não chegam', () => {
    // O BUG. Ao recarregar, `getSession` ainda não respondeu: o
    // PermissionContext não tem usuário e devolve a lista PADRÃO. Se o módulo
    // ativo fosse gravado nesse instante, o cash guardado viraria torneio —
    // permanentemente, porque telas comuns aos dois módulos (Jogadores,
    // Financeiro) não carregam `module="cash"` e nada corrigiria de volta.
    localStorage.setItem('selected_module', 'cash');

    // `loading: false` de propósito, e é ISSO que reproduz o bug: o
    // PermissionContext AFIRMAVA ter carregado nesse instante (ele tratava
    // "sessão ainda resolvendo" como "ninguém logado"). O efeito antigo se
    // protegia de `loading: true`, então a proteção nunca entrava — o guarda
    // era contra a situação errada.
    const utils = montar({ modules: ['tournament'], loading: false });
    expect(localStorage.getItem('selected_module')).toBe('cash');

    permissoesChegam(utils, ['tournament', 'cash']);
    expect(screen.getByTestId('module')).toHaveTextContent('cash');
    expect(localStorage.getItem('selected_module')).toBe('cash');
  });

  it('só uma escolha explícita grava', () => {
    // A regra que fecha a classe inteira de bug: valor derivado nunca
    // sobrescreve valor escolhido. O derivado se recalcula; o escolhido não
    // volta.
    localStorage.setItem('selected_module', 'cash');
    montar({ modules: ['tournament'] });
    expect(localStorage.getItem('selected_module')).toBe('cash');
  });
});

describe('troca de módulo', () => {
  it('troca e guarda a escolha', () => {
    montar({ modules: ['tournament', 'cash'] });
    act(() => api.selectModule('cash'));
    expect(screen.getByTestId('module')).toHaveTextContent('cash');
    expect(localStorage.getItem('selected_module')).toBe('cash');
  });

  it('limpa o cache ao trocar', () => {
    montar({ modules: ['tournament', 'cash'] });
    act(() => api.selectModule('cash'));
    expect(clearCache).toHaveBeenCalled();
  });

  it('trocar para o módulo já ativo não mexe em nada', () => {
    montar({ modules: ['tournament', 'cash'] });
    act(() => api.selectModule('tournament'));
    expect(clearCache).not.toHaveBeenCalled();
  });

  it('ignora módulo não contratado', () => {
    // A tela não deve conseguir se colocar num módulo que o servidor recusa.
    montar({ modules: ['tournament'] });
    act(() => api.selectModule('cash'));
    expect(screen.getByTestId('module')).toHaveTextContent('tournament');
    expect(clearCache).not.toHaveBeenCalled();
  });

  it('a home acompanha o módulo', () => {
    montar({ modules: ['tournament', 'cash'] });
    expect(screen.getByTestId('home')).toHaveTextContent('/');
    act(() => api.selectModule('cash'));
    expect(screen.getByTestId('home')).toHaveTextContent('/cash');
  });
});

describe('consulta', () => {
  it('hasModule responde pelo que está contratado', () => {
    montar({ modules: ['tournament', 'cash'] });
    expect(api.hasModule('cash')).toBe(true);
    expect(api.hasModule('tournament')).toBe(true);
  });

  it('hasModule é falso para o que não foi contratado', () => {
    montar({ modules: ['tournament'] });
    expect(api.hasModule('cash')).toBe(false);
  });
});
