/* Equilíbrio das mesas: o que o painel sugere ao floor.

   Só sugere. Quem escolhe o jogador que muda de mesa, e quando, é o floor.
   `mesas` traz só as ativas, cada uma com { id, numero, jogadores, lugares },
   onde `lugares` são as cadeiras que recebem jogador (sem as bloqueadas). */

const NADA = { mover: null, quebrar: null };

export function equilibrio(mesas) {
  const contam = mesas.filter((m) => m.lugares > 0);
  const jogadores = contam.reduce((soma, m) => soma + m.jogadores, 0);
  if (contam.length < 2 || jogadores === 0) return NADA;

  const cheia = contam.reduce((a, b) => (b.jogadores > a.jogadores ? b : a));
  // Empate na menor: a de número maior, que é a que o salão costuma desmontar.
  const vazia = contam.reduce((a, b) => (
    b.jogadores < a.jogadores || (b.jogadores === a.jogadores && b.numero > a.numero) ? b : a
  ));

  const lugaresNasOutras = contam.reduce((soma, m) => soma + m.lugares, 0) - vazia.lugares;
  // Quebrar já resolve o desequilíbrio: as duas dicas juntas brigariam.
  if (jogadores <= lugaresNasOutras) return { mover: null, quebrar: { mesa: vazia, jogadores } };
  if (cheia.jogadores - vazia.jogadores >= 2) return { mover: { de: cheia, para: vazia }, quebrar: null };
  return NADA;
}
