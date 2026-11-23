/**
 * ONDE CADA PESSOA PAROU nos vídeos de suporte.
 *
 * Fica neste navegador, separado por usuário: no clube, o mesmo computador do
 * caixa passa de mão em mão, e o progresso de um não pode aparecer para o outro.
 *
 * Modo anônimo / storage bloqueado não pode derrubar a tela de ajuda: tudo em
 * try/catch, e sem storage os vídeos só começam do início.
 */
const PREFIXO = 'aceblind:videosSuporte:';

/** Antes disso a pessoa só abriu e fechou: não vale como "parou aqui". */
const MINIMO_PARA_RETOMAR = 5;
/** Os últimos segundos são encerramento: quem chegou ali assistiu tudo. */
const FOLGA_DO_FIM = 15;

const chave = (usuario) => `${PREFIXO}${usuario || 'anonimo'}`;

/** { [idDoVideo]: { posicao, duracao, idioma, concluido, em } } */
export const lerProgresso = (usuario) => {
  try {
    const dados = JSON.parse(window.localStorage.getItem(chave(usuario)));
    return dados && typeof dados === 'object' && !Array.isArray(dados) ? dados : {};
  } catch (_) {
    return {};
  }
};

const chegouAoFim = (posicao, duracao) => (
  duracao > 0 && duracao - posicao <= Math.min(FOLGA_DO_FIM, duracao * 0.05)
);

/**
 * Guarda o ponto e devolve o progresso atualizado. Quem já assistiu até o fim
 * continua como "assistido" mesmo se rever um pedaço depois.
 */
export const gravarProgresso = (usuario, idDoVideo, { posicao, duracao, idioma, terminou = false }) => {
  const atual = lerProgresso(usuario);
  const p = Number(posicao) || 0;
  const d = Number.isFinite(duracao) ? Number(duracao) : 0;
  const fim = terminou || chegouAoFim(p, d);
  if (!idDoVideo || (!fim && p < MINIMO_PARA_RETOMAR)) return atual;
  const novo = {
    ...atual,
    [idDoVideo]: {
      posicao: fim ? 0 : Math.floor(p),
      duracao: Math.round(d),
      idioma,
      concluido: fim || Boolean(atual[idDoVideo]?.concluido),
      em: Date.now(),
    },
  };
  try {
    window.localStorage.setItem(chave(usuario), JSON.stringify(novo));
  } catch (_) {
    /* sem storage vale só enquanto a tela está aberta */
  }
  return novo;
};

/** Começar do zero, sem perder o "assistido". */
export const zerarPosicao = (usuario, idDoVideo) => {
  const atual = lerProgresso(usuario);
  if (!atual[idDoVideo]) return atual;
  const novo = { ...atual, [idDoVideo]: { ...atual[idDoVideo], posicao: 0 } };
  try {
    window.localStorage.setItem(chave(usuario), JSON.stringify(novo));
  } catch (_) { /* idem */ }
  return novo;
};

/**
 * Em que segundo retomar. A narração muda de tamanho com o idioma, então quem
 * troca o idioma do app volta para o mesmo ponto proporcional, e não para o
 * mesmo segundo, que cairia em outro assunto.
 */
export const pontoDeRetomada = (registro, idioma, duracao) => {
  const posicao = Number(registro?.posicao) || 0;
  if (posicao < MINIMO_PARA_RETOMAR) return 0;
  const total = Number(duracao) || 0;
  const ponto = registro.idioma !== idioma && registro.duracao > 0 && total > 0
    ? Math.floor((posicao / registro.duracao) * total)
    : posicao;
  return total > 0 && chegouAoFim(ponto, total) ? 0 : ponto;
};

/** Para o cartão: quanto da barra encher e em que ponto parou. */
export const situacaoDoVideo = (registro, idioma, duracao) => {
  const parouEm = pontoDeRetomada(registro, idioma, duracao);
  const total = Number(duracao) || 0;
  return {
    parouEm,
    fracao: parouEm > 0 && total > 0 ? Math.min(1, parouEm / total) : 0,
    assistido: Boolean(registro?.concluido),
  };
};

/** Os que ficaram pela metade, o mais recente primeiro. */
export const videosEmAndamento = (videos, progresso) => videos
  .filter((v) => {
    const r = progresso[v.id];
    return r && !r.concluido && r.posicao >= MINIMO_PARA_RETOMAR;
  })
  .sort((a, b) => (progresso[b.id].em || 0) - (progresso[a.id].em || 0));

/** O capítulo que contém o segundo `tempo`; -1 antes do primeiro. */
export const capituloEm = (capitulos, tempo) => {
  let atual = -1;
  (capitulos || []).forEach((c, i) => { if (tempo >= c.inicio - 0.5) atual = i; });
  return atual;
};
