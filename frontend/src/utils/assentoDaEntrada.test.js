/**
 * O assento de quem acabou de entrar, igual para a venda do Caixa e o resgate de
 * ticket. A entrada já está paga: nenhum caminho aqui pode rejeitar, porque isso
 * tiraria o bilhete da mão do jogador.
 */
import api from '../config/api';
import { pedirAssento, soMesasAtivas } from './assentoDaEntrada';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() },
}));
jest.mock('i18next', () => ({ t: (chave, padrao) => padrao || chave }));

const ENTRADA = { playerId: 'p1', tournamentId: 't1', dayId: 'd1', allocationType: 'automatic' };

/** Recusa no formato de hoje: `detail` é objeto, nunca texto. */
const recusa = (message) => ({
  response: { data: { detail: { code: 'alocacao_recusada', message } } },
});

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  console.error.mockRestore();
  console.warn.mockRestore();
});

describe('pedirAssento', () => {
  it('alocação manual não pede assento: quem senta é o staff', async () => {
    await expect(pedirAssento({ ...ENTRADA, allocationType: 'manual' }))
      .resolves.toEqual({ sem_assento: true });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('sem saber como o dia aloca, trata como manual', async () => {
    await expect(pedirAssento({ ...ENTRADA, allocationType: undefined }))
      .resolves.toEqual({ sem_assento: true });
  });

  it('pede o assento pelo dia', async () => {
    api.post.mockResolvedValue({ data: { table_number: 3, seat_number: 7 } });
    await expect(pedirAssento(ENTRADA))
      .resolves.toEqual({ alocacao: { table_number: 3, seat_number: 7 } });
    expect(api.post).toHaveBeenCalledWith('/allocations/day/d1/auto?player_id=p1');
  });

  it('sem dia, pede pelo torneio', async () => {
    api.post.mockResolvedValue({ data: {} });
    await pedirAssento({ ...ENTRADA, dayId: '' });
    expect(api.post).toHaveBeenCalledWith('/allocations/tournament/t1/auto?player_id=p1');
  });

  it.each([
    ['objeto com código', recusa('All tables are full')],
    ['texto', { response: { data: { detail: 'All tables are full' } } }],
  ])('mesa cheia vira alternado com detail em %s', async (_, erro) => {
    api.post.mockRejectedValue(erro);
    await expect(pedirAssento(ENTRADA))
      .resolves.toEqual({ is_alternate: true, motivo_alternate: 'lotadas' });
  });

  it('nenhuma mesa ativa não é fila: o motivo manda cadastrar as mesas', async () => {
    api.post.mockRejectedValue(recusa('No active tables available for this day'));
    await expect(pedirAssento(ENTRADA))
      .resolves.toEqual({ is_alternate: true, motivo_alternate: 'sem-mesas' });
  });

  it('outra recusa volta sem assento e com o motivo para avisar', async () => {
    api.post.mockRejectedValue(recusa('Jogador não está no dia'));
    await expect(pedirAssento(ENTRADA)).resolves.toEqual({
      sem_assento: true, falhou: true, motivo: 'Jogador não está no dia',
    });
  });

  it('queda de rede também não rejeita', async () => {
    api.post.mockRejectedValue(new Error('Network Error'));
    await expect(pedirAssento(ENTRADA))
      .resolves.toEqual({ sem_assento: true, falhou: true, motivo: '' });
  });

  describe('mesas travadas', () => {
    const TRAVADAS = { ...ENTRADA, tablesLocked: true };

    it('quem já conferiu as mesas não consulta de novo', async () => {
      await expect(pedirAssento({ ...TRAVADAS, semMesas: true }))
        .resolves.toEqual({ is_alternate: true, motivo_alternate: 'sem-mesas' });
      await expect(pedirAssento({ ...TRAVADAS, semMesas: false }))
        .resolves.toEqual({ is_alternate: true, motivo_alternate: 'travadas' });
      expect(api.get).not.toHaveBeenCalled();
      expect(api.post).not.toHaveBeenCalled();
    });

    it('sem a conferência, consulta o dia', async () => {
      api.get.mockResolvedValue({ data: [{ id: 'm1', status: 'closed' }] });
      await expect(pedirAssento(TRAVADAS))
        .resolves.toEqual({ is_alternate: true, motivo_alternate: 'sem-mesas' });
      expect(api.get).toHaveBeenCalledWith('/tables/day/d1');
    });

    it('com mesa ativa no dia é fila de alternados', async () => {
      api.get.mockResolvedValue({ data: [{ id: 'm1', status: 'active' }] });
      await expect(pedirAssento(TRAVADAS))
        .resolves.toEqual({ is_alternate: true, motivo_alternate: 'travadas' });
    });

    it('consulta que falha não vira "não tem mesa"', async () => {
      api.get.mockRejectedValue(new Error('500'));
      await expect(pedirAssento(TRAVADAS))
        .resolves.toEqual({ is_alternate: true, motivo_alternate: 'travadas' });
    });
  });
});

describe('soMesasAtivas', () => {
  it('mesa sem status conta como ativa; fechada não', () => {
    expect(soMesasAtivas([{ id: 1 }, { id: 2, status: 'active' }, { id: 3, status: 'closed' }]))
      .toEqual([{ id: 1 }, { id: 2, status: 'active' }]);
  });

  it('resposta que não é lista conta como nenhuma mesa', () => {
    expect(soMesasAtivas(null)).toEqual([]);
  });
});
