/**
 * Etapa selecionada.
 *
 * A etapa viaja num HEADER (`X-Stage-ID`), não na URL. Isso significa que
 * duas telas idênticas de etapas diferentes têm a mesma chave de cache — e
 * por isso trocar de etapa PRECISA limpar o cache. Sem essa limpeza, o
 * operador troca de etapa e continua vendo os jogadores e o caixa da etapa
 * anterior, sem nada na tela indicando o engano.
 */
import { render, screen, act, waitFor } from '@testing-library/react';
import { StageProvider, useStage } from './StageContext';
import { clearCache } from '../utils/apiCache';

jest.mock('../utils/apiCache', () => ({ clearCache: jest.fn() }));

const ETAPA = { id: 'etapa-1', name: 'Etapa Rio' };
const OUTRA = { id: 'etapa-2', name: 'Etapa Medellín' };

let api;

function Sonda() {
  api = useStage();
  return (
    <div>
      <span data-testid="etapa">{api.selectedStage?.name || 'nenhuma'}</span>
      <span data-testid="loading">{String(api.loading)}</span>
    </div>
  );
}

const montar = async () => {
  render(<StageProvider><Sonda /></StageProvider>);
  await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
};

beforeEach(() => {
  localStorage.clear();
  api = null;
});

describe('carga inicial', () => {
  it('sem etapa guardada começa vazio', async () => {
    await montar();
    expect(screen.getByTestId('etapa')).toHaveTextContent('nenhuma');
  });

  it('restaura a etapa guardada', async () => {
    // O operador não pode ter que reselecionar a etapa a cada F5 no meio do
    // evento.
    localStorage.setItem('selected_stage', JSON.stringify(ETAPA));
    await montar();
    expect(screen.getByTestId('etapa')).toHaveTextContent('Etapa Rio');
  });

  it('valor corrompido é descartado em vez de derrubar a aplicação', async () => {
    localStorage.setItem('selected_stage', '{quebrado');
    const erro = jest.spyOn(console, 'error').mockImplementation(() => {});
    await montar();
    expect(screen.getByTestId('etapa')).toHaveTextContent('nenhuma');
    expect(localStorage.getItem('selected_stage')).toBeNull();
    erro.mockRestore();
  });
});

describe('seleção', () => {
  it('guarda a escolha e reflete na tela', async () => {
    await montar();
    act(() => api.selectStage(ETAPA));
    expect(screen.getByTestId('etapa')).toHaveTextContent('Etapa Rio');
    expect(JSON.parse(localStorage.getItem('selected_stage'))).toEqual(ETAPA);
  });

  it('trocar de etapa limpa o cache', async () => {
    // A etapa vai num header, não na URL: as chaves de cache das duas etapas
    // são idênticas. Sem limpar, a tela mostra o caixa da etapa anterior.
    await montar();
    act(() => api.selectStage(ETAPA));
    clearCache.mockClear();
    act(() => api.selectStage(OUTRA));
    expect(clearCache).toHaveBeenCalled();
    expect(screen.getByTestId('etapa')).toHaveTextContent('Etapa Medellín');
  });

  it('limpar a etapa apaga o registro e o cache', async () => {
    localStorage.setItem('selected_stage', JSON.stringify(ETAPA));
    await montar();
    clearCache.mockClear();
    act(() => api.clearStage());
    expect(screen.getByTestId('etapa')).toHaveTextContent('nenhuma');
    expect(localStorage.getItem('selected_stage')).toBeNull();
    expect(clearCache).toHaveBeenCalled();
  });
});
