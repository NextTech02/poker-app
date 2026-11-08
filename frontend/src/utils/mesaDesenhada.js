/* A mesa desenhada no tablet: onde fica cada assento e quanto falta no nível.

   O dealer fica embaixo, no meio. O assento 1 é o primeiro à esquerda dele, e a
   numeração segue no sentido horário, como na mesa de verdade. As posições são
   em porcentagem da área da mesa, para servir a qualquer tela. */

// Arco livre embaixo, onde fica o dealer.
const VAO_DO_DEALER = 60;
const RAIO_X = 44;
const RAIO_Y = 42;

export const posicaoDoAssento = (indice, total) => {
  // Um lugar só vai para o alto, de frente para o dealer.
  const graus = total > 1
    ? 90 + VAO_DO_DEALER / 2 + (indice * (360 - VAO_DO_DEALER)) / (total - 1)
    : 270;
  const radianos = (graus * Math.PI) / 180;
  return {
    x: total > 1 ? 50 + RAIO_X * Math.cos(radianos) : 50,
    y: 50 + RAIO_Y * Math.sin(radianos),
  };
};

/** Todos os lugares da mesa, com quem está sentado e se o floor bloqueou. */
export const assentosDaMesa = (lugares, sentados = [], bloqueados = []) => {
  const porNumero = new Map(sentados.map((s) => [s.seat_number, s]));
  // Jogador num lugar além do tamanho cadastrado não pode sumir da tela.
  const total = Math.max(lugares || 0, ...sentados.map((s) => s.seat_number));
  return Array.from({ length: total }, (_, i) => ({
    numero: i + 1,
    jogador: porNumero.get(i + 1) || null,
    bloqueado: bloqueados.includes(i + 1),
  }));
};

/**
 * Segundos que faltam no nível. Conta pelo relógio do servidor: `diferenca` é
 * quanto o servidor está à frente do aparelho, medida quando a mesa chegou.
 * Pausado não há fim do nível, e vale o que restava.
 */
export const segundosDoNivel = (timer, diferenca, agoraMs) => {
  if (timer?.level_ends_at) {
    return Math.max(0, Math.ceil(timer.level_ends_at - (agoraMs / 1000 + diferenca)));
  }
  if (timer?.time_remaining != null) return Math.max(0, Math.ceil(timer.time_remaining));
  return null;
};

export const formatarTempo = (segundos) => {
  if (segundos == null) return '--:--';
  const horas = Math.floor(segundos / 3600);
  const minutos = Math.floor((segundos % 3600) / 60);
  const resto = String(segundos % 60).padStart(2, '0');
  return horas > 0 ? `${horas}:${String(minutos).padStart(2, '0')}:${resto}` : `${minutos}:${resto}`;
};
