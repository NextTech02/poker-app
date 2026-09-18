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

const montar = ({ modules = ['tournament'], loading = false, hasPermission } = {}) => {
  usePermissions.mockReturnValue({ modules, loading, hasPermission });
  return render(<ModuleProvider><Sonda /></ModuleProvider>);
};

/** Cargo com SÓ estas chaves (sem `hasPermission` o contexto trata tudo como permitido). */
const cargoCom = (...chaves) => (k) => !k || chaves.includes(k);

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

  it('sem escolha guardada, com dois módulos, fica no torneio', () => {
    montar({ modules: ['tournament', 'cash'] });
    expect(screen.getByTestId('module')).toHaveTextContent('tournament');
    expect(screen.getByTestId('multiplos')).toHaveTextContent('true');
  });

  it('o padrão é o torneio MESMO que a lista chegue em ordem alfabética', () => {
    // O BUG: um backend antigo devolvia `sorted()`, e 'bar' < 'cash' <
    // 'tournament'. Quem só tinha um módulo nunca gravou escolha (a tela de
    // escolha pula sem gravar), então "o primeiro da lista" mandava o caixa de
    // torneio para a home do bar — sem permissão para ela, e o guard de rota o
    // devolvia para a mesma home, em laço.
    montar({ modules: ['bar', 'cash', 'tournament'] });
    expect(screen.getByTestId('module')).toHaveTextContent('tournament');
    expect(screen.getByTestId('home')).toHaveTextContent('/home');
  });

  it('clube só de bar abre no bar', () => {
    montar({ modules: ['bar'] });
    expect(screen.getByTestId('module')).toHaveTextContent('bar');
    expect(screen.getByTestId('home')).toHaveTextContent('/bar');
  });

  it('sem torneio, o cash vem antes do bar', () => {
    montar({ modules: ['bar', 'cash'] });
    expect(screen.getByTestId('module')).toHaveTextContent('cash');
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
    // `toHaveTextContent('/')` casaria com QUALQUER caminho — foi por isso que
    // este teste não percebeu quando a home do torneio mudou de `/` para
    // `/home`. Comparação exata.
    expect(screen.getByTestId('home').textContent).toBe('/home');
    act(() => api.selectModule('cash'));
    expect(screen.getByTestId('home').textContent).toBe('/cash');
  });

  it('a casa é a primeira tela que o CARGO pode abrir, não a home padrão', () => {
    // A sangeur só tem `sangi`: no cash a casa dela é /sangi. Cair em /cash
    // (que pede cash.operate) era a recusa no meio da tela, sem sair do lugar.
    montar({ modules: ['tournament', 'cash'], hasPermission: cargoCom('sangi') });
    expect(screen.getByTestId('module').textContent).toBe('cash');
    expect(screen.getByTestId('home').textContent).toBe('/sangi');
    expect(api.casaDoModulo('cash')).toBe('/sangi');
  });

  it('caixa sem dashboard abre o torneio em /caixa', () => {
    montar({ modules: ['tournament', 'cash'], hasPermission: cargoCom('cashier', 'cashbox.operate') });
    expect(screen.getByTestId('module').textContent).toBe('tournament');
    expect(screen.getByTestId('home').textContent).toBe('/caixa');
  });

  it('sem escolha guardada, o padrão é o primeiro módulo em que o cargo tem tela', () => {
    // Bar com `bar.operate` e nada no torneio: abre no bar, não na home do
    // torneio onde tudo lhe seria recusado.
    montar({ modules: ['tournament', 'cash', 'bar'], hasPermission: cargoCom('bar.operate') });
    expect(screen.getByTestId('module').textContent).toBe('bar');
    expect(screen.getByTestId('home').textContent).toBe('/bar');
  });

  it('a escolha guardada vence, e a casa segue o cargo dentro dela', () => {
    localStorage.setItem('selected_module', 'cash');
    montar({ modules: ['tournament', 'cash'], hasPermission: cargoCom('cashier', 'sangi') });
    expect(screen.getByTestId('module').textContent).toBe('cash');
    // `cashier` no cash é a entrada da Sangeur para quem gerencia.
    expect(screen.getByTestId('home').textContent).toBe('/sangi');
  });

  it('cargo sem tela em módulo nenhum cai na home padrão (a recusa aparece com o menu)', () => {
    montar({ modules: ['tournament', 'cash'], hasPermission: cargoCom('nada') });
    expect(screen.getByTestId('module').textContent).toBe('tournament');
    expect(screen.getByTestId('home').textContent).toBe('/home');
  });

  it('nenhuma home é a raiz — senão a raiz redireciona para si mesma', () => {
    // A raiz é NEUTRA: ela manda para a casa do módulo aberto. Se alguma casa
    // fosse `/`, o redirecionamento entraria em laço e a tela ficaria branca.
    [['tournament'], ['cash'], ['tournament', 'cash']].forEach((modules) => {
      localStorage.clear();
      const { unmount } = montar({ modules });
      expect(screen.getByTestId('home').textContent).not.toBe('/');
      unmount();
    });
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
