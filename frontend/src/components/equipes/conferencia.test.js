/** Folha de conferência da Fase 1: cada equipe, os pontos de cada integrante e a assinatura do capitão. */
import { htmlDaConferencia } from './conferencia';

const t = (chave, padrao) => padrao || chave;

it('lista equipes, integrantes e a linha de assinatura, sem deixar HTML passar', () => {
  const html = htmlDaConferencia({
    torneio: 'Torneo <b>',
    t,
    ranking: [{
      rank: 1, name: 'Los Ases', points: 47.5,
      members: [
        { name: 'Ana', is_captain: true, table_number: 2, position: 1, points: 40 },
        { name: 'Beto', is_captain: false, table_number: null, position: null, points: 7.5 },
      ],
    }],
  });
  expect(html).toContain('1º · Los Ases — 47.5 pts');
  expect(html).toContain('Ana (Capitão)');
  expect(html).toContain('<td>7.5</td>');
  expect(html).toContain('Assinatura do capitão');
  expect(html).toContain('Torneo &lt;b&gt;');
});
