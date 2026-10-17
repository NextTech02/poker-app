/**
 * Bilhete de inscrição impresso no Caixa (térmica de 80 mm) — layout pedido
 * pelo NSOP: imagem do clube no topo, cidade, "Registro de torneio", o
 * torneio em destaque, participante, MESA e ASSENTO em caixas, o que foi
 * comprado com as fichas, total de fichas, sede, data/hora, valor, caixa e a
 * linha da assinatura. Enfeites geométricos nos cantos, se o clube ligar.
 *
 * Função PURA (só monta o HTML): a janela de impressão é aberta por quem chama.
 * Todo texto que vem do clube ou do jogador é escapado.
 */

export const LABELS = {
  pt: {
    titulo: 'REGISTRO DE TORNEIO', tituloFichas: 'BILHETE DE FICHAS', participante: 'PARTICIPANTE',
    mesa: 'MESA', assento: 'ASSENTO', modalidade: 'MODALIDADE', fichas: 'FICHAS', totalFichas: 'TOTAL DE FICHAS',
    sede: 'LOCAL', dataHora: 'DATA / HORA', valor: 'VALOR', caixa: 'CAIXA', assinatura: 'ASSINATURA DO JOGADOR',
    alternate: 'ALTERNATE', alternateSub: 'Aguarde ser chamado pelo staff.', dia: 'DIA',
  },
  es: {
    titulo: 'REGISTRO DE TORNEO', tituloFichas: 'BOLETO DE FICHAS', participante: 'PARTICIPANTE',
    mesa: 'MESA', assento: 'POSICIÓN', modalidade: 'MODALIDAD', fichas: 'FICHAS', totalFichas: 'TOTAL DE FICHAS',
    sede: 'SEDE', dataHora: 'FECHA / HORA', valor: 'VALOR', caixa: 'CAJERO', assinatura: 'FIRMA DEL JUGADOR',
    alternate: 'ALTERNATE', alternateSub: 'Espere a ser llamado por el staff.', dia: 'DÍA',
  },
  en: {
    titulo: 'TOURNAMENT REGISTRATION', tituloFichas: 'CHIPS TICKET', participante: 'PLAYER',
    mesa: 'TABLE', assento: 'SEAT', modalidade: 'ENTRY', fichas: 'CHIPS', totalFichas: 'TOTAL CHIPS',
    sede: 'VENUE', dataHora: 'DATE / TIME', valor: 'AMOUNT', caixa: 'CASHIER', assinatura: 'PLAYER SIGNATURE',
    alternate: 'ALTERNATE', alternateSub: 'Wait to be called by staff.', dia: 'DAY',
  },
};

export const idiomaDoBilhete = (idioma) => {
  const texto = String(idioma || '');
  if (texto.startsWith('es')) return 'es';
  if (texto.startsWith('en')) return 'en';
  return 'pt';
};

const LOCALE = { pt: 'pt-BR', es: 'es-ES', en: 'en-US' };

export const escapar = (texto) => String(texto ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** Campos do bilhete no formulário do torneio, a partir do torneio gravado. */
export const bilheteDoTorneio = (torneio) => ({
  ticket_logo_path: torneio?.ticket_logo_path || '',
  ticket_city: torneio?.ticket_city || '',
  ticket_venue: torneio?.ticket_venue || '',
});

/**
 * Formulário → API. Na criação só vai o que foi preenchido (em branco = o
 * padrão do clube); na edição vão os três, para "apagar" voltar ao do clube.
 */
export const bilheteParaApi = (form, edicao = false) => {
  const campos = {
    ticket_logo_path: (form?.ticket_logo_path || '').trim(),
    ticket_city: (form?.ticket_city || '').trim(),
    ticket_venue: (form?.ticket_venue || '').trim(),
  };
  if (edicao) {
    return Object.fromEntries(Object.entries(campos).map(([k, v]) => [k, v || null]));
  }
  return Object.fromEntries(Object.entries(campos).filter(([, v]) => v));
};

/**
 * O que vale no bilhete: o do TORNEIO, se ele tiver; senão o do CLUBE.
 * Os enfeites são só do clube. `urlDe` transforma o caminho do arquivo na URL
 * pública (Storage).
 */
export const brandingFinal = (clube, torneio, urlDe = (caminho) => caminho) => {
  const c = clube || {};
  const t = torneio || {};
  const caminho = t.ticket_logo_path || c.ticket_logo_path || '';
  return {
    logoUrl: caminho ? urlDe(caminho) : '',
    city: (t.ticket_city || c.ticket_city || '').trim(),
    venue: (t.ticket_venue || c.ticket_venue || '').trim(),
    ornaments: !!c.ticket_ornaments,
  };
};

// Enfeite escalonado (o do topo; o de baixo é o mesmo espelhado na vertical).
const enfeite = (espelhar = false, virar = false) => {
  const transform = [
    virar ? 'scale(-1,1) translate(-60,0)' : '',
    espelhar ? 'scale(1,-1) translate(0,-20)' : '',
  ].filter(Boolean).join(' ');
  return `<svg class="bt-enfeite" viewBox="0 0 60 20" aria-hidden="true"><g transform="${transform}" fill="none" stroke="#000" stroke-width="2">`
    + '<path d="M0 17 H10 V11 H18 V5 H26 V11"/><rect x="12.5" y="12.5" width="4" height="4" stroke-width="1.6"/>'
    + '<path d="M30 11 H60"/></g></svg>';
};

const formatarData = (iso, idioma) => {
  const data = iso ? new Date(iso) : new Date();
  if (Number.isNaN(data.getTime())) return '';
  const dia = data.toLocaleDateString(LOCALE[idioma], { day: '2-digit', month: '2-digit', year: 'numeric' });
  const hora = data.toLocaleTimeString(LOCALE[idioma], { hour: '2-digit', minute: '2-digit' });
  return `${dia} - ${hora}`;
};

/**
 * HTML do bilhete.
 * @param {object} p
 * @param {object} p.allocation  dados do bilhete (ver SeatTicket)
 * @param {object} p.branding    { logoUrl, city, venue, ornaments }
 * @param {string} p.idioma      'pt' | 'es' | 'en' (ou o código do i18n)
 * @param {Function} p.formatarValor  dinheiro já com a moeda do clube
 * @param {string} p.caixa       nome de quem vendeu
 * @param {boolean} p.imprimir   false = só a prévia (sem abrir a impressão)
 */
export const htmlDoBilhete = ({
  allocation = {}, branding = {}, idioma = 'pt', formatarValor = (v) => Number(v || 0).toFixed(2),
  caixa = '', imprimir = true,
}) => {
  const lang = idiomaDoBilhete(idioma);
  const L = LABELS[lang];
  const fichas = (n) => Number(n || 0).toLocaleString(LOCALE[lang]);
  const itens = Array.isArray(allocation.itens) ? allocation.itens : [];
  const totalFichas = allocation.total_chips ?? itens.reduce((s, i) => s + (Number(i.chips) || 0), 0);
  const totalValor = allocation.total_amount ?? itens.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const alternate = !!allocation.is_alternate;
  const semAssento = !alternate && !!allocation.sem_assento;
  const titulo = allocation.so_fichas ? L.tituloFichas : L.titulo;

  const topo = branding.logoUrl
    ? `<img class="bt-logo" src="${escapar(branding.logoUrl)}" alt="">`
    : '';
  const cabecalho = `<div class="bt-cabecalho">
      ${branding.ornaments ? enfeite() : ''}
      <div class="bt-logo-box">${topo}</div>
      ${branding.ornaments ? enfeite(false, true) : ''}
    </div>`;
  const cidade = branding.city ? `<div class="bt-cidade">${escapar(branding.city)}</div>` : '';

  const torneio = allocation.tournament_name
    ? `<div class="bt-caixa bt-torneio">${escapar(allocation.tournament_name)}${
      allocation.day_name ? `<div class="bt-dia">${escapar(allocation.day_name)}</div>` : ''}</div>`
    : '';

  let assento = `<div class="bt-duas">
      <div class="bt-caixa bt-numero"><div class="bt-rotulo">${L.mesa}</div><div class="bt-grande">${escapar(allocation.table_number ?? '')}</div></div>
      <div class="bt-caixa bt-numero"><div class="bt-rotulo">${L.assento}</div><div class="bt-grande">${escapar(allocation.seat_number ?? '')}</div></div>
    </div>`;
  if (alternate) {
    assento = `<div class="bt-caixa bt-alternate"><div class="bt-grande-texto">${L.alternate}</div><div class="bt-sub">${L.alternateSub}</div></div>`;
  } else if (semAssento) {
    assento = '';
  }

  const linha = (rotulo, valor, classe = '') => `<div class="bt-linha ${classe}"><span class="bt-linha-rotulo">${rotulo}</span><span class="bt-linha-valor">${valor}</span></div>`;
  let compra = '';
  if (itens.length === 1) {
    compra = linha(`${L.modalidade}:`, escapar(itens[0].name)) + linha(`${L.fichas}:`, fichas(itens[0].chips));
  } else if (itens.length > 1) {
    // Vários itens: "NOME: valor / fichas", o formato que o clube já usava.
    compra = itens.map((i) => linha(`${escapar(i.name)}:`, `${escapar(formatarValor(i.amount))} / ${fichas(i.chips)}`)).join('');
  }
  const total = itens.length
    ? `<div class="bt-caixa bt-total"><span>${L.totalFichas}:</span><span class="bt-total-num">${fichas(totalFichas)}</span></div>`
    : '';

  const dado = (rotulo, valor) => (valor
    ? `<div class="bt-dado"><span class="bt-dado-rotulo">${rotulo}:</span><span class="bt-dado-valor">${valor}</span></div>`
    : '');
  const dados = [
    dado(L.sede, escapar(branding.venue)),
    dado(L.dataHora, escapar(formatarData(allocation.created_at, lang))),
    itens.length ? dado(L.valor, escapar(formatarValor(totalValor))) : '',
    dado(L.caixa, escapar(caixa)),
  ].join('');

  const rodape = `<div class="bt-rodape">
      ${branding.ornaments ? enfeite(true) : ''}
      <span class="bt-id">${escapar(allocation.id || '')}</span>
      ${branding.ornaments ? enfeite(true, true) : ''}
    </div>`;

  const script = imprimir
    ? '<script>window.onload=function(){window.print();setTimeout(function(){window.close();},100);};</script>'
    : '';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapar(titulo)} - ${escapar(allocation.player_name)}</title>
<style>
@media print { @page { size: 80mm auto; margin: 0; } body { margin: 0; } }
* { box-sizing: border-box; }
body { width: 80mm; margin: 0 auto; padding: 4mm; background: #fff; color: #000;
  font-family: 'Arial Narrow', Arial, Helvetica, sans-serif; text-transform: uppercase; }
.bt-cabecalho { display: flex; align-items: center; justify-content: center; gap: 2mm; }
.bt-enfeite { width: 15mm; height: 5mm; flex: 0 0 auto; }
.bt-logo-box { flex: 1 1 auto; text-align: center; }
.bt-logo { max-width: 100%; max-height: 24mm; object-fit: contain; }
.bt-cidade { text-align: center; font-weight: 900; font-size: 15px; letter-spacing: 1px; margin: 2mm 0 1mm; }
.bt-titulo { text-align: center; font-weight: 900; font-size: 19px; padding: 2mm 0; margin: 1mm 0 2mm;
  border-top: 2px solid #000; border-bottom: 2px solid #000; }
.bt-caixa { border: 2px solid #000; border-radius: 3mm; padding: 2mm; text-align: center; }
.bt-torneio { font-weight: 900; font-size: 20px; line-height: 1.1; }
.bt-dia { font-size: 12px; font-weight: 700; margin-top: 1mm; }
.bt-separador { display: flex; align-items: center; gap: 2mm; font-size: 11px; letter-spacing: 1px; margin: 2mm 0 1mm; }
.bt-separador::before, .bt-separador::after { content: ''; flex: 1; border-top: 1.5px solid #000; }
.bt-jogador { text-align: center; font-weight: 900; font-size: 17px; margin-bottom: 2mm; }
.bt-duas { display: flex; gap: 2mm; margin-bottom: 2mm; }
.bt-numero { flex: 1; }
.bt-rotulo { font-weight: 800; font-size: 13px; }
.bt-grande { font-weight: 900; font-size: 44px; line-height: 1; }
.bt-alternate { margin-bottom: 2mm; }
.bt-grande-texto { font-weight: 900; font-size: 26px; }
.bt-sub { font-size: 11px; text-transform: none; }
.bt-linha { display: flex; gap: 3mm; padding: 1.2mm 0; border-bottom: 1.5px solid #000; font-weight: 900; font-size: 14px; }
.bt-linha-rotulo { flex: 0 0 42%; }
.bt-total { display: flex; justify-content: space-between; align-items: baseline; font-weight: 900; font-size: 14px; margin: 2mm 0; }
.bt-total-num { font-size: 24px; }
.bt-dado { display: flex; gap: 2mm; font-size: 11px; font-weight: 800; margin: 1.2mm 0; }
.bt-dado-rotulo { flex: 0 0 30%; }
.bt-dado-valor { flex: 1; border-bottom: 1px solid #000; }
.bt-assinatura { margin: 8mm 6mm 0; border-top: 1.5px solid #000; text-align: center; font-size: 11px; padding-top: 1mm; }
.bt-rodape { display: flex; align-items: center; justify-content: center; gap: 2mm; margin-top: 3mm; }
.bt-id { font-size: 7px; text-transform: none; flex: 1; text-align: center; word-break: break-all; }
</style></head><body>
${cabecalho}
${cidade}
<div class="bt-titulo">${escapar(titulo)}</div>
${torneio}
<div class="bt-separador">${L.participante}</div>
<div class="bt-jogador">${escapar(allocation.player_name)}</div>
${assento}
${compra}
${total}
${dados}
<div class="bt-assinatura">${L.assinatura}</div>
${rodape}
${script}
</body></html>`;
};
