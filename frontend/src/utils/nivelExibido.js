/**
 * Número de nível que a TV e o painel MOSTRAM.
 *
 * No banco `level` é POSIÇÃO na estrutura, e o intervalo ocupa uma: 1, 2, ...,
 * INTERVALO=7, 8... A tela de blinds renumera pulando os intervalos (800/1600 é
 * "Nível 9"), mas o telão mostrava a posição crua ("NÍVEL 10") — e a diferença
 * crescia a cada intervalo. Aqui conta-se só os níveis de jogo até a posição
 * (inclusive); num intervalo, é o número do último nível jogado.
 *
 * Preferência: o servidor já manda `display_level`. Sem ele (estado montado
 * localmente ao trocar de nível sem rede), conta na estrutura em cache. Sem
 * estrutura, cai na posição crua — melhor um número que nenhum.
 */
export function contarNivelExibido(blinds, level) {
  if (typeof level !== 'number') return null;
  if (!Array.isArray(blinds) || blinds.length === 0) return null;
  return blinds.reduce((n, b) => (
    typeof b?.level === 'number' && b.level <= level && !b.is_break ? n + 1 : n
  ), 0);
}

/**
 * `alvo` é um blind (`{ level, display_level? }`) ou o estado do relógio
 * (`{ current_level, display_level? }`). `fallbackLevel` cobre o caso sem alvo.
 */
export function nivelExibido(alvo, blinds, fallbackLevel) {
  if (typeof alvo?.display_level === 'number') return alvo.display_level;
  let level = fallbackLevel;
  if (typeof alvo?.level === 'number') level = alvo.level;
  else if (typeof alvo?.current_level === 'number') level = alvo.current_level;
  const contado = contarNivelExibido(blinds, level);
  return contado != null ? contado : level;
}
