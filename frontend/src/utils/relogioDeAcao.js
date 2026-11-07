/* O relógio de ação da mesa, sem tela e sem servidor.

   Ele roda no tablet do dealer: o toque precisa responder na hora, e a rede do
   salão não pode parar a contagem. Não acompanha a mão nem sabe quem está
   agindo: o dealer dá um toque por ação e só diz de quem é o cartão quando usa
   um. O tempo entra sempre por `agora`, para a conta ser testável. */

export const FASE = {
  PARADO: 'parado',
  CONTANDO: 'contando',
  PAUSADO: 'pausado',
  ESGOTADO: 'esgotado',
};

export const RUA = { PRE: 'pre', POS: 'pos' };

export const estadoInicial = {
  fase: FASE.PARADO,
  rua: RUA.PRE,
  fim: 0,
  // Só vale pausado: o que faltava quando a contagem parou.
  guardadoMs: 0,
  cartoesNaDecisao: 0,
  chamado: false,
};

const segundosDaRua = (rua, config) => (
  rua === RUA.POS ? config.postflop_seconds : config.preflop_seconds
);

const contar = (estado, segundos, agora, extra = {}) => ({
  ...estado,
  fase: FASE.CONTANDO,
  fim: agora + segundos * 1000,
  guardadoMs: 0,
  cartoesNaDecisao: 0,
  chamado: false,
  ...extra,
});

const somarCartao = (estado, agora, ms) => {
  if (estado.fase === FASE.PAUSADO) {
    return { ...estado, guardadoMs: estado.guardadoMs + ms, cartoesNaDecisao: estado.cartoesNaDecisao + 1 };
  }
  // Com tempo sobrando, soma ao que falta; esgotado, conta a partir de agora.
  return {
    ...estado,
    fase: FASE.CONTANDO,
    fim: Math.max(estado.fim, agora) + ms,
    cartoesNaDecisao: estado.cartoesNaDecisao + 1,
  };
};

const tirarCartao = (estado, agora, ms) => {
  // Depois da próxima ação o cartão já não é desta decisão: só o saldo volta.
  if (estado.cartoesNaDecisao === 0) return estado;
  const cartoesNaDecisao = estado.cartoesNaDecisao - 1;
  if (estado.fase === FASE.PAUSADO) {
    return { ...estado, guardadoMs: Math.max(0, estado.guardadoMs - ms), cartoesNaDecisao };
  }
  const fim = estado.fim - ms;
  return { ...estado, fim, cartoesNaDecisao, fase: fim <= agora ? FASE.ESGOTADO : FASE.CONTANDO };
};

export function relogioReducer(estado, { tipo, agora, config }) {
  switch (tipo) {
    case 'NOVA_MAO':
      return contar(estado, config.preflop_seconds, agora, { rua: RUA.PRE });
    case 'FLOP':
      return contar(estado, config.postflop_seconds, agora, { rua: RUA.POS });
    case 'PROXIMA':
      return contar(estado, segundosDaRua(estado.rua, config), agora);
    case 'CHAMAR':
      return contar(estado, config.called_clock_seconds, agora, { chamado: true });
    case 'PAUSAR':
      if (estado.fase !== FASE.CONTANDO) return estado;
      return { ...estado, fase: FASE.PAUSADO, guardadoMs: Math.max(0, estado.fim - agora) };
    case 'RETOMAR':
      if (estado.fase !== FASE.PAUSADO) return estado;
      return { ...estado, fase: FASE.CONTANDO, fim: agora + estado.guardadoMs, guardadoMs: 0 };
    case 'PARAR':
      return { ...estado, fase: FASE.PARADO, fim: 0, guardadoMs: 0, cartoesNaDecisao: 0, chamado: false };
    case 'CARTAO':
      return somarCartao(estado, agora, config.card_seconds * 1000);
    case 'DESFAZER_CARTAO':
      return tirarCartao(estado, agora, config.card_seconds * 1000);
    case 'TIQUE':
      if (estado.fase !== FASE.CONTANDO || agora < estado.fim) return estado;
      return { ...estado, fase: FASE.ESGOTADO };
    default:
      return estado;
  }
}

/** Para cima: o dealer lê 1 até o último instante, e 0 só quando acabou mesmo. */
export const segundosRestantes = (estado, agora) => {
  if (estado.fase === FASE.PAUSADO) return Math.ceil(estado.guardadoMs / 1000);
  if (estado.fase !== FASE.CONTANDO) return 0;
  return Math.max(0, Math.ceil((estado.fim - agora) / 1000));
};

export const nivelDeAlerta = (fase, segundos) => {
  if (fase === FASE.ESGOTADO) return 'urgente';
  if (fase !== FASE.CONTANDO) return '';
  if (segundos <= 5) return 'urgente';
  return segundos <= 10 ? 'aviso' : '';
};
