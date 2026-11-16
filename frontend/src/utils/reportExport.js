// Exportação de relatórios para CSV, Excel (.xlsx) e PDF.
//
// A camada de UI monta um array de "seções" (já com rótulos i18n e dados crus)
// e chama exportSections(). As libs pesadas (xlsx/jspdf) são carregadas sob
// demanda via import() dinâmico — só entram no bundle quando o usuário exporta.
//
// Uma seção é uma de duas formas:
//   { kind: 'table',    title, columns: [{ key, label, type }], rows: [obj] }
//   { kind: 'keyvalue', title, rows: [{ label, value, type }] }
// type ∈ 'text' | 'int' | 'currency' | 'percent' | 'number' | 'date'
//
// Valores numéricos vão como NÚMERO real no Excel/CSV (bons para análise/BI);
// no PDF são formatados para leitura (moeda com símbolo, % etc.).

// ── helpers de valor ────────────────────────────────────────────────────────

const isNum = (v) => v !== null && v !== undefined && v !== '' && isFinite(Number(v));

// Valor "cru" para Excel/CSV: número quando faz sentido, senão string.
function rawValue(value, type) {
  switch (type) {
    case 'int':
    case 'number':
    case 'currency':
    case 'percent':
      return isNum(value) ? Number(value) : '';
    case 'date':
      return formatDate(value);
    default:
      return value == null ? '' : String(value);
  }
}

// Valor formatado para leitura (PDF e cabeçalhos): usa o formatador de moeda.
function displayValue(value, type, fmtCurrency) {
  if (value == null || value === '') return '—';
  switch (type) {
    case 'currency':
      return isNum(value) ? fmtCurrency(Number(value)) : String(value);
    case 'percent':
      return isNum(value) ? `${Number(value).toFixed(1)}%` : String(value);
    case 'int':
      return isNum(value) ? String(Math.round(Number(value))) : String(value);
    case 'number':
      return isNum(value) ? Number(value).toLocaleString() : String(value);
    case 'date':
      return formatDate(value);
    default:
      return String(value);
  }
}

// "06/11/2026 18:04": sem a vírgula e os segundos do toLocaleString(), que
// faziam a data quebrar em duas linhas no PDF.
function formatDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

const NUMERICOS = new Set(['int', 'number', 'currency', 'percent']);

// Formato de número das células do Excel: o valor continua NÚMERO (soma,
// filtra, vai para o BI), só a exibição ganha separador de milhar.
const FORMATO_EXCEL = {
  int: '#,##0',
  number: '#,##0.##',
  currency: '#,##0.00',
  // O valor já vem em pontos percentuais (46.5, não 0.465).
  percent: '0.0"%"',
};

function sectionColumns(section) {
  if (section.kind === 'keyvalue') {
    return [
      { key: 'label', label: section.keyLabel || 'Item', type: 'text' },
      { key: 'value', label: section.valueLabel || 'Valor', type: 'value' },
    ];
  }
  return section.columns;
}

// ── CSV (arquivo único, seções empilhadas) ──────────────────────────────────

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function sectionToCsvLines(section) {
  const lines = [];
  lines.push(csvCell(`### ${section.title}`));
  if (section.kind === 'keyvalue') {
    lines.push([section.keyLabel || 'Item', section.valueLabel || 'Valor'].map(csvCell).join(','));
    for (const r of section.rows) {
      lines.push([csvCell(r.label), csvCell(rawValue(r.value, r.type))].join(','));
    }
  } else {
    const cols = section.columns;
    lines.push(cols.map((c) => csvCell(c.label)).join(','));
    for (const row of section.rows) {
      lines.push(cols.map((c) => csvCell(rawValue(row[c.key], c.type))).join(','));
    }
  }
  return lines;
}

function exportCsv(sections, filename) {
  const blocks = sections.map((s) => sectionToCsvLines(s).join('\r\n'));
  // BOM para o Excel reconhecer UTF-8 (acentos).
  const content = '﻿' + blocks.join('\r\n\r\n');
  downloadBlob(new Blob([content], { type: 'text/csv;charset=utf-8' }), `${filename}.csv`);
}

// ── Excel (.xlsx) — uma aba por seção ───────────────────────────────────────

function uniqueSheetName(base, used) {
  // Nome de aba do Excel: máx 31 chars, sem : \ / ? * [ ]
  let name = (base || 'Aba').replace(/[:\\/?*[\]]/g, ' ').slice(0, 31).trim() || 'Aba';
  let candidate = name;
  let i = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = ` ${i++}`;
    candidate = `${name.slice(0, 31 - suffix.length)}${suffix}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

async function exportXlsx(sections, filename, meta) {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  const used = new Set();

  sections.forEach((section) => {
    let aoa;
    // Tipo de cada célula, para o formato de número: por coluna na tabela,
    // por linha no chave-valor (cada linha é uma métrica diferente).
    let tipoDaCelula;
    if (section.kind === 'keyvalue') {
      aoa = [[section.keyLabel || 'Item', section.valueLabel || 'Valor']];
      section.rows.forEach((r) => aoa.push([r.label, rawValue(r.value, r.type)]));
      tipoDaCelula = (linha, coluna) => (coluna === 1 ? section.rows[linha - 1]?.type : 'text');
    } else {
      const cols = section.columns;
      aoa = [cols.map((c) => c.label)];
      section.rows.forEach((row) => aoa.push(cols.map((c) => rawValue(row[c.key], c.type))));
      tipoDaCelula = (linha, coluna) => cols[coluna]?.type;
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = computeColWidths(aoa);
    formatarCelulasDoExcel(XLSX, ws, aoa, tipoDaCelula, section.kind !== 'keyvalue');
    XLSX.utils.book_append_sheet(wb, ws, uniqueSheetName(section.title, used));
  });

  if (meta) wb.Props = { Title: meta.title, CreatedDate: undefined };
  XLSX.writeFile(wb, `${filename}.xlsx`);
}

// Separador de milhar nos números e, nas tabelas, filtro no cabeçalho (no
// chave-valor de duas colunas o filtro só atrapalha).
function formatarCelulasDoExcel(XLSX, ws, aoa, tipoDaCelula, comFiltro) {
  const { encode_cell: celula, encode_range: intervalo } = XLSX.utils;
  if (typeof celula !== 'function') return;
  for (let r = 1; r < aoa.length; r++) {
    aoa[r].forEach((valor, c) => {
      const formato = FORMATO_EXCEL[tipoDaCelula(r, c)];
      const ref = celula({ r, c });
      if (formato && typeof valor === 'number' && ws[ref]) ws[ref].z = formato;
    });
  }
  const colunas = aoa[0]?.length || 0;
  if (comFiltro && aoa.length > 1 && colunas > 0 && typeof intervalo === 'function') {
    ws['!autofilter'] = { ref: intervalo({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: colunas - 1 } }) };
  }
}

function computeColWidths(aoa) {
  const widths = [];
  aoa.forEach((row) => {
    row.forEach((cell, i) => {
      // Número aparece com milhar e centavos ("139,100.00"): mais largo que o cru.
      const len = typeof cell === 'number'
        ? String(Math.round(Math.abs(cell))).length + 5
        : String(cell ?? '').length;
      widths[i] = Math.max(widths[i] || 8, Math.min(len + 2, 48));
    });
  });
  return widths.map((wch) => ({ wch }));
}

// ── PDF — cabeçalho de marca + tabela por seção ─────────────────────────────

// Acima disso, as colunas não cabem legíveis numa A4 em pé.
const COLUNAS_NA_FOLHA_EM_PE = 9;

// Espaço que um título precisa abaixo dele (o título + cabeçalho + 3 linhas):
// sem isso o título ficava sozinho no pé da página e a tabela, na outra.
const ESPACO_MINIMO_DA_SECAO = 120;

// Largura de uma tabela chave-valor: esticada na folha inteira, o valor
// ficava longe do rótulo.
const LARGURA_DO_CHAVE_VALOR = 380;

/**
 * Estilo por coluna: número alinhado à direita (como numa planilha) e
 * largura mínima do maior valor, para "S/ 30,000.00" e a data não quebrarem
 * em duas linhas. O cabeçalho continua podendo quebrar entre palavras.
 */
function estilosDasColunas(doc, tipos, corpo, estilo) {
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(estilo.fontSize);
  const colunas = {};
  tipos.forEach((tipo, i) => {
    if (!NUMERICOS.has(tipo) && tipo !== 'date') return;
    const maior = corpo.reduce((mx, linha) => Math.max(mx, doc.getTextWidth(String(linha[i] ?? ''))), 0);
    colunas[i] = { minCellWidth: Math.ceil(maior + estilo.cellPadding * 2 + 2) };
    if (NUMERICOS.has(tipo)) colunas[i].halign = 'right';
  });
  return colunas;
}

async function exportPdf(sections, filename, meta, fmtCurrency) {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;

  // Uma coluna por meio de entrada deixa "Torneios" e "Jogadores" largas
  // demais para a folha em pé: com tabela larga, o documento sai deitado.
  const larga = (section) => section.kind !== 'keyvalue' && (section.columns || []).length > COLUNAS_NA_FOLHA_EM_PE;
  const orientation = sections.some(larga) ? 'landscape' : 'portrait';
  const doc = new jsPDF({ orientation, unit: 'pt', format: 'a4' });
  const brand = meta?.brandRgb || [114, 51, 248];
  const pageW = doc.internal.pageSize.getWidth();

  // Cabeçalho
  doc.setFillColor(brand[0], brand[1], brand[2]);
  doc.rect(0, 0, pageW, 70, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.text(meta?.title || 'Relatório', 40, 34);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  if (meta?.subtitle) doc.text(meta.subtitle, 40, 52);

  let cursorY = 92;

  sections.forEach((section) => {
    if (cursorY > doc.internal.pageSize.getHeight() - ESPACO_MINIMO_DA_SECAO) {
      doc.addPage();
      cursorY = 48;
    }
    doc.setTextColor(30, 25, 40);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text(section.title, 40, cursorY);
    cursorY += 8;

    const chaveValor = section.kind === 'keyvalue';
    let head;
    let body;
    let tipos;
    if (chaveValor) {
      head = [[section.keyLabel || 'Item', section.valueLabel || 'Valor']];
      body = section.rows.map((r) => [r.label, displayValue(r.value, r.type, fmtCurrency)]);
      // O valor é sempre a 2ª coluna; à direita, como os números da planilha.
      tipos = ['text', 'number'];
    } else {
      const cols = section.columns;
      head = [cols.map((c) => c.label)];
      body = section.rows.map((row) => cols.map((c) => displayValue(row[c.key], c.type, fmtCurrency)));
      tipos = cols.map((c) => c.type);
    }

    const estilo = larga(section)
      ? { fontSize: 7, cellPadding: 3, overflow: 'linebreak' }
      : { fontSize: 8, cellPadding: 4, overflow: 'linebreak' };
    const columnStyles = estilosDasColunas(doc, tipos, body, estilo);

    autoTable(doc, {
      head,
      body,
      startY: cursorY,
      margin: { left: 40, right: 40 },
      tableWidth: chaveValor ? Math.min(LARGURA_DO_CHAVE_VALOR, pageW - 80) : 'auto',
      styles: estilo,
      columnStyles,
      headStyles: { fillColor: brand, textColor: 255, fontStyle: 'bold', valign: 'bottom' },
      alternateRowStyles: { fillColor: [244, 242, 250] },
      theme: 'grid',
      // O cabeçalho de uma coluna de número também vai para a direita.
      didParseCell: (data) => {
        if (data.section === 'head' && columnStyles[data.column.index]?.halign) {
          data.cell.styles.halign = columnStyles[data.column.index].halign;
        }
      },
    });
    cursorY = doc.lastAutoTable.finalY + 24;
  });

  // Rodapé com paginação
  const pages = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(150, 150, 150);
    doc.text(
      `${meta?.footer || ''}  ${i}/${pages}`,
      pageW - 40,
      doc.internal.pageSize.getHeight() - 20,
      { align: 'right' }
    );
  }

  doc.save(`${filename}.pdf`);
}

// ── util comum ──────────────────────────────────────────────────────────────

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── entrada pública ─────────────────────────────────────────────────────────

/**
 * @param {Array} sections   Seções (table|keyvalue) já rotuladas.
 * @param {Object} opts
 * @param {'csv'|'xlsx'|'pdf'} opts.format
 * @param {string} opts.filename   Sem extensão.
 * @param {Object} [opts.meta]     { title, subtitle, footer, brandRgb }
 * @param {Function} [opts.formatCurrency]  usado no PDF.
 */
export async function exportSections(sections, opts) {
  const { format, filename, meta, formatCurrency } = opts;
  const fmt = typeof formatCurrency === 'function' ? formatCurrency : (n) => String(n);
  const clean = (sections || []).filter(Boolean);
  if (!clean.length) throw new Error('no-sections');

  if (format === 'csv') return exportCsv(clean, filename);
  if (format === 'xlsx') return exportXlsx(clean, filename, meta);
  if (format === 'pdf') return exportPdf(clean, filename, meta, fmt);
  throw new Error(`unknown-format:${format}`);
}

export { sectionColumns };
