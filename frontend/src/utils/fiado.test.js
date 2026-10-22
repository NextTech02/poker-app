import { abatimentosDePremios } from './fiado';

describe('abatimentosDePremios', () => {
  it('o mesmo jogador com dois prêmios abate a dívida uma vez só', () => {
    const pagamentos = [
      { id: 'a', eliminator_player_id: 'p1', cash_amount: 30 },
      { id: 'b', eliminator_player_id: 'p1', cash_amount: 30 },
      { id: 'c', eliminator_player_id: 'p2', cash_amount: 30 },
    ];
    expect(abatimentosDePremios(pagamentos, { p1: 40 })).toEqual({ a: 30, b: 10 });
  });

  it('quem não deve não entra', () => {
    expect(abatimentosDePremios([{ id: 'a', eliminator_player_id: 'p1', cash_amount: 30 }], {})).toEqual({});
  });
});
