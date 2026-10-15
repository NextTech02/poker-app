/**
 * Torneio por equipes — o que a TELA decide. Os pontos, o ranking e o sorteio
 * são do servidor (equipes_regras.py); aqui ficam o formulário do torneio, a
 * prévia das mesas e QUEM joga em cada nível da final por revezamento.
 */

export const JOGADORES_POR_EQUIPE = 4;
export const MAX_POR_MESA = 8;
export const MAX_FINALISTAS = 8;
export const CRITERIOS_DE_DESEMPATE = ['best_individual', 'manual'];

/** Campos de equipe do formulário a partir do torneio gravado. */
export const equipesDoTorneio = (torneio) => ({
  team_mode: !!torneio?.team_mode,
  team_finalists: torneio?.team_finalists != null ? String(torneio.team_finalists) : '',
  team_tiebreak: CRITERIOS_DE_DESEMPATE.includes(torneio?.team_tiebreak) ? torneio.team_tiebreak : 'best_individual',
  team_allow_reentry: !!torneio?.team_allow_reentry,
});

/** Formulário → API. Torneio comum não manda nada; desligar o modo de um
 * torneio que ERA por equipes manda `team_mode: false`. */
export const equipesParaApi = (form, eraPorEquipes = false) => {
  if (!form?.team_mode) return eraPorEquipes ? { team_mode: false } : {};
  const finalistas = parseInt(form.team_finalists, 10);
  return {
    team_mode: true,
    team_finalists: Number.isFinite(finalistas) && finalistas >= 1 ? Math.min(finalistas, MAX_FINALISTAS) : null,
    team_tiebreak: CRITERIOS_DE_DESEMPATE.includes(form.team_tiebreak) ? form.team_tiebreak : 'best_individual',
    team_allow_reentry: !!form.team_allow_reentry,
  };
};

/** Mesas da Fase 1: os integrantes de cada equipe em mesas diferentes e no
 * máximo 8 por mesa — mínimo de 4 mesas. */
export const mesasMinimas = (jogadores) =>
  (jogadores > 0 ? Math.max(JOGADORES_POR_EQUIPE, Math.ceil(jogadores / MAX_POR_MESA)) : 0);

/** Prévia dos tamanhos das mesas: [8, 7, 7, 7, 7] para 36 jogadores. */
export const previaDasMesas = (jogadores) => {
  const mesas = mesasMinimas(jogadores);
  if (!mesas) return [];
  const base = Math.floor(jogadores / mesas);
  const sobra = jogadores % mesas;
  // Com menos jogadores que mesas, mesa vazia não entra na prévia.
  return Array.from({ length: mesas }, (_, i) => base + (i < sobra ? 1 : 0)).filter((n) => n > 0);
};

/** "1×8, 4×7" — os tamanhos agrupados, maiores primeiro. */
export const resumoDasMesas = (tamanhos) => {
  const contagem = new Map();
  tamanhos.forEach((n) => contagem.set(n, (contagem.get(n) || 0) + 1));
  return [...contagem.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([tamanho, quantas]) => `${quantas}×${tamanho}`)
    .join(', ');
};

/** Índice (0..n−1) de quem joga no nível exibido: a cada nível entra o próximo
 * da ordem. Antes do início (ou sem nível), joga o primeiro. */
export const membroDaVez = (integrantes, nivel, nivelInicial = 1) => {
  if (!integrantes || integrantes <= 0) return 0;
  const n = Number(nivel);
  if (!Number.isFinite(n) || n < nivelInicial) return 0;
  return (n - nivelInicial) % integrantes;
};

/**
 * Quem joga agora e quem entra no próximo nível, para uma equipe da final.
 * No INTERVALO o nível exibido continua sendo o último jogado: quem jogou fica
 * "agora" e o próximo é quem volta depois do intervalo.
 */
export const revezamentoDaEquipe = (membros, nivel, nivelInicial = 1) => {
  const lista = Array.isArray(membros) ? membros : [];
  if (!lista.length) return { atual: null, proximo: null };
  const i = membroDaVez(lista.length, nivel, nivelInicial);
  return { atual: lista[i], proximo: lista[(i + 1) % lista.length] };
};

/** Nome curto para o telão e o cartão: apelido, senão o primeiro nome. */
export const nomeCurto = (membro) => {
  if (!membro) return '';
  if (typeof membro === 'string') return membro;
  const apelido = String(membro.nickname || '').trim();
  if (apelido) return apelido;
  return String(membro.name || '').trim().split(/\s+/)[0] || '';
};

/** Pontos com uma casa só quando há meio ponto (empate dividido). */
export const formatarPontos = (pontos) => {
  if (pontos == null) return '—';
  const n = Number(pontos);
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
};
