/**
 * Bilhete de KO — o papel que o jogador leva ao caixa (ou que o caixa entrega
 * junto com o dinheiro). Mesmo formato pedido para o add-on:
 *
 *   NOME DO JOGADOR
 *   MESA E ASSENTO
 *   KO: valor
 *
 * Os rótulos seguem o idioma da tela, como o bilhete de assento (SeatTicket).
 */
const LANGS = {
  pt: { titulo: 'BILHETE DE KO', tituloMystery: 'BILHETE MYSTERY', tituloComprovante: 'COMPROVANTE MYSTERY', umEnvelope: 'MYSTERY: 1 ENVELOPE', rodapeComprovante: 'Troque este comprovante por um envelope no ponto de troca.', mesa: (m, a) => `MESA ${m} - ASSENTO ${a}`, eliminou: 'Eliminou', mystery: 'MYSTERY', hora: 'Data e Hora', rodape: 'Apresente este bilhete no caixa.' },
  es: { titulo: 'BOLETO DE KO', tituloMystery: 'BOLETO MYSTERY', tituloComprovante: 'COMPROBANTE MYSTERY', umEnvelope: 'MYSTERY: 1 SOBRE', rodapeComprovante: 'Canjee este comprobante por un sobre en el punto de canje.', mesa: (m, a) => `MESA ${m} - ASIENTO ${a}`, eliminou: 'Eliminó a', mystery: 'MYSTERY', hora: 'Fecha y Hora', rodape: 'Presente este boleto en la caja.' },
  en: { titulo: 'KO TICKET', tituloMystery: 'MYSTERY TICKET', tituloComprovante: 'MYSTERY VOUCHER', umEnvelope: 'MYSTERY: 1 ENVELOPE', rodapeComprovante: 'Exchange this voucher for an envelope at the exchange point.', mesa: (m, a) => `TABLE ${m} - SEAT ${a}`, eliminou: 'Eliminated', mystery: 'MYSTERY', hora: 'Date & Time', rodape: 'Present this ticket at the cashier.' },
};

const escapar = (texto) => String(texto ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const idiomaDe = (lang) => {
  if (String(lang || '').startsWith('es')) return 'es';
  if (String(lang || '').startsWith('en')) return 'en';
  return 'pt';
};

/** Monta o HTML do bilhete (separado da impressão para poder testar). */
export const htmlDoBilheteKo = ({
  jogador, mesa, assento, valor, vitima, formato, torneio, quando, idioma, formatarValor = (v) => String(v),
  comprovante = false,
}) => {
  const L = LANGS[idiomaDe(idioma)];
  const rotulo = formato === 'mystery' ? L.mystery : 'KO';
  // Sorteio físico: o comprovante não tem valor — o jogador troca por um envelope.
  let titulo = formato === 'mystery' ? L.tituloMystery : L.titulo;
  if (comprovante) titulo = L.tituloComprovante;
  const linhaValor = comprovante ? L.umEnvelope : `${rotulo}: ${escapar(formatarValor(valor))}`;
  const rodape = comprovante ? L.rodapeComprovante : L.rodape;
  const data = new Date(quando || Date.now()).toLocaleString(
    idiomaDe(idioma) === 'en' ? 'en-US' : idiomaDe(idioma) === 'es' ? 'es-ES' : 'pt-BR'
  );
  const blocoMesa = mesa != null && assento != null
    ? `<div class="kt-mesa">${escapar(L.mesa(mesa, assento))}</div>` : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${titulo}</title>
<style>
@media print { @page { size: 80mm auto; margin: 0; } body { margin: 0; } }
body { font-family: 'Courier New', monospace; width: 80mm; margin: 0 auto; padding: 8mm; }
.kt { border: 2px dashed #333; padding: 6mm; text-align: center; }
.kt-titulo { font-size: 16px; font-weight: bold; border-bottom: 2px solid #333; padding-bottom: 8px; margin-bottom: 10px; }
.kt-torneio { font-size: 12px; color: #444; margin-bottom: 8px; }
.kt-nome { font-size: 20px; font-weight: bold; margin: 10px 0; text-transform: uppercase; }
.kt-mesa { font-size: 16px; font-weight: bold; margin: 8px 0; }
.kt-valor { font-size: 22px; font-weight: bold; margin: 12px 0; border: 2px solid #333; padding: 8px; }
.kt-vitima, .kt-hora { font-size: 11px; color: #555; margin-top: 6px; }
.kt-rodape { font-size: 10px; color: #666; border-top: 2px solid #333; margin-top: 12px; padding-top: 8px; }
</style></head><body><div class="kt">
<div class="kt-titulo">${titulo}</div>
${torneio ? `<div class="kt-torneio">${escapar(torneio)}</div>` : ''}
<div class="kt-nome">${escapar(jogador)}</div>
${blocoMesa}
<div class="kt-valor">${linhaValor}</div>
${vitima ? `<div class="kt-vitima">${L.eliminou}: ${escapar(vitima)}</div>` : ''}
<div class="kt-hora">${L.hora}: ${escapar(data)}</div>
<div class="kt-rodape">${rodape}</div>
</div><script>window.onload=function(){window.print();setTimeout(function(){window.close();},100);}</script></body></html>`;
};

export const imprimirBilheteKo = (dados) => {
  const janela = window.open('', '_blank');
  if (!janela) return false;
  janela.document.write(htmlDoBilheteKo(dados));
  janela.document.close();
  return true;
};
