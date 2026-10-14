/**
 * Premiação por eliminação (KO fixo, PKO, Mystery) — regras que a TELA precisa.
 *
 * A conta do dinheiro mora no servidor (app/services/ko_regras.py): a tela só
 * decide o que perguntar ao floor e como mostrar. Os formatos:
 *
 * - `ko`      KO fixo: quem elimina leva o bounty inteiro da vítima;
 * - `pko`     progressivo: parte em dinheiro (padrão 50%), o resto soma no
 *             bounty de quem eliminou; o campeão leva o próprio no fim;
 * - `mystery` envelopes: depois que o floor inicia a fase, cada eliminação
 *             sorteia um envelope. Antes da fase, eliminar não paga nada.
 */
export const FORMATOS_KO = ['none', 'ko', 'pko', 'mystery'];
export const SEM_KO = 'none';

/** Formato do torneio; qualquer coisa desconhecida vale "sem KO". */
export const formatoKo = (torneio) => (
  FORMATOS_KO.includes(torneio?.ko_format) ? torneio.ko_format : SEM_KO
);

export const ehTorneioKo = (torneio) => formatoKo(torneio) !== SEM_KO;

export const faseMysteryIniciada = (torneio) => (
  formatoKo(torneio) === 'mystery' && !!torneio?.mystery_started_at
);

/**
 * Eliminar exige dizer QUEM eliminou? KO fixo e PKO sempre; Mystery só depois
 * de iniciada a fase (antes dela a eliminação não paga nada).
 */
export const exigeEliminador = (torneio) => {
  const formato = formatoKo(torneio);
  if (formato === 'ko' || formato === 'pko') return true;
  return formato === 'mystery' && faseMysteryIniciada(torneio);
};

/** Formatos que têm bounty "na cabeça" de cada jogador (mostrado nas mesas). */
export const temBountyPorJogador = (torneio) => ['ko', 'pko'].includes(formatoKo(torneio));

/** Campos KO do formulário do torneio → corpo da API. */
export const koParaApi = (form) => {
  const formato = FORMATOS_KO.includes(form?.ko_format) ? form.ko_format : SEM_KO;
  if (formato === SEM_KO) return { ko_format: SEM_KO };
  const pct = Number(form?.ko_percentage);
  const parte = Number(form?.ko_cash_share);
  return {
    ko_format: formato,
    ko_percentage: Number.isFinite(pct) ? pct : 0,
    ko_cash_share: formato === 'pko' && Number.isFinite(parte) ? parte : 100,
  };
};

/**
 * Candidatos a eliminador: vivos, sem a vítima; quem está na MESMA mesa vem
 * primeiro (é quase sempre um deles), depois os demais por nome.
 */
const VIVOS = new Set(['registered', 'active', 'winner']);
export const candidatosAEliminador = (inscritos, vitimaId, mesaPorInscrito = new Map(), mesaDaVitima = null) => (
  (inscritos || [])
    .filter((i) => i.id !== vitimaId && VIVOS.has(i.status || 'active'))
    .map((i) => ({ ...i, mesa: mesaPorInscrito.get(i.id) ?? null }))
    .sort((a, b) => {
      const aMesma = mesaDaVitima != null && a.mesa === mesaDaVitima ? 0 : 1;
      const bMesma = mesaDaVitima != null && b.mesa === mesaDaVitima ? 0 : 1;
      if (aMesma !== bMesma) return aMesma - bMesma;
      return String(a.nome || '').localeCompare(String(b.nome || ''));
    })
);

/**
 * Corpo da eliminação. O `client_mutation_id` vai no corpo (além da fila
 * offline): é com ele que o servidor reconhece o reenvio e não cria um
 * segundo KO. `quem` = { eliminated_by, no_eliminator } do "Quem eliminou?".
 */
export const corpoDaEliminacao = (tournamentPlayerId, clientMutationId, quem = null) => ({
  tournament_player_id: tournamentPlayerId,
  client_mutation_id: clientMutationId,
  ...(quem ? { eliminated_by: quem.eliminated_by || [], no_eliminator: !!quem.no_eliminator } : {}),
});

/** Código da recusa do servidor (`detail.code`), quando houver. */
export const codigoDaRecusa = (err) => {
  const detail = err?.response?.data?.detail;
  return detail && typeof detail === 'object' && !Array.isArray(detail) ? detail.code || null : null;
};
