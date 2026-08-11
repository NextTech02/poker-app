/**
 * A etapa selecionada mora no localStorage e entra em quase toda chamada à
 * API. Duas coisas precisam valer sempre:
 *
 * - um valor corrompido não pode derrubar a tela (é só um filtro de visão,
 *   não uma credencial);
 * - sem etapa, os parâmetros saem INTACTOS. Mandar `stage_id: null` faria o
 *   backend filtrar por "etapa nula" e devolver lista vazia — a tela abriria
 *   em branco sem erro nenhum, que é o pior tipo de falha.
 */
import {
  getSelectedStage,
  getSelectedStageId,
  addStageToParams,
  addStageToData,
  hasSelectedStage,
} from './stageUtils';

const ETAPA = { id: 'etapa-1', name: 'Etapa Rio' };

describe('leitura da etapa selecionada', () => {
  beforeEach(() => localStorage.clear());

  it('devolve a etapa guardada', () => {
    localStorage.setItem('selected_stage', JSON.stringify(ETAPA));
    expect(getSelectedStage()).toEqual(ETAPA);
  });

  it('sem nada guardado devolve null', () => {
    expect(getSelectedStage()).toBeNull();
  });

  it('JSON corrompido devolve null em vez de estourar', () => {
    localStorage.setItem('selected_stage', '{isso nao e json');
    const erro = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(getSelectedStage()).toBeNull();
    erro.mockRestore();
  });

  it('devolve o id da etapa', () => {
    localStorage.setItem('selected_stage', JSON.stringify(ETAPA));
    expect(getSelectedStageId()).toBe('etapa-1');
  });

  it('etapa sem id devolve null', () => {
    localStorage.setItem('selected_stage', JSON.stringify({ name: 'Sem id' }));
    expect(getSelectedStageId()).toBeNull();
  });

  it('informa se há etapa selecionada', () => {
    expect(hasSelectedStage()).toBe(false);
    localStorage.setItem('selected_stage', JSON.stringify(ETAPA));
    expect(hasSelectedStage()).toBe(true);
  });
});

describe('injeção da etapa na chamada', () => {
  beforeEach(() => localStorage.clear());

  it('acrescenta o stage_id aos parâmetros', () => {
    localStorage.setItem('selected_stage', JSON.stringify(ETAPA));
    expect(addStageToParams({ status: 'active' })).toEqual({
      status: 'active',
      stage_id: 'etapa-1',
    });
  });

  it('sem etapa, os parâmetros saem intactos', () => {
    expect(addStageToParams({ status: 'active' })).toEqual({ status: 'active' });
  });

  it('sem argumento devolve objeto vazio', () => {
    expect(addStageToParams()).toEqual({});
  });

  it('não muda o objeto recebido', () => {
    // Vários pontos reaproveitam o mesmo objeto de filtros entre chamadas;
    // mutar aqui contaminaria a próxima requisição.
    localStorage.setItem('selected_stage', JSON.stringify(ETAPA));
    const original = { status: 'active' };
    addStageToParams(original);
    expect(original).toEqual({ status: 'active' });
  });

  it('acrescenta o stage_id ao corpo', () => {
    localStorage.setItem('selected_stage', JSON.stringify(ETAPA));
    expect(addStageToData({ name: 'Torneio' })).toEqual({
      name: 'Torneio',
      stage_id: 'etapa-1',
    });
  });

  it('sem etapa, o corpo sai intacto', () => {
    expect(addStageToData({ name: 'Torneio' })).toEqual({ name: 'Torneio' });
  });

  it('a etapa selecionada vence a que veio no corpo', () => {
    localStorage.setItem('selected_stage', JSON.stringify(ETAPA));
    expect(addStageToData({ stage_id: 'outra' }).stage_id).toBe('etapa-1');
  });
});
