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

function formatDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  return d.toLocaleString();
}

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
    if (section.kind === 'keyvalue') {
      aoa = [[section.keyLabel || 'Item', section.valueLabel || 'Valor']];
      section.rows.forEach((r) => aoa.push([r.label, rawValue(r.value, r.type)]));
    } else {
      const cols = section.columns;
      aoa = [cols.map((c) => c.label)];
      section.rows.forEach((row) => aoa.push(cols.map((c) => rawValue(row[c.key], c.type))));
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = computeColWidths(aoa);
    XLSX.utils.book_append_sheet(wb, ws, uniqueSheetName(section.title, used));
  });

  if (meta) wb.Props = { Title: meta.title, CreatedDate: undefined };
  XLSX.writeFile(wb, `${filename}.xlsx`);
}

function computeColWidths(aoa) {
  const widths = [];
  aoa.forEach((row) => {
    row.forEach((cell, i) => {
      const len = String(cell ?? '').length;
      widths[i] = Math.max(widths[i] || 8, Math.min(len + 2, 48));
    });
  });
  return widths.map((wch) => ({ wch }));
}

// ── PDF — cabeçalho de marca + tabela por seção ─────────────────────────────

async function exportPdf(sections, filename, meta, fmtCurrency) {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;

  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
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
    doc.setTextColor(30, 25, 40);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    if (cursorY > doc.internal.pageSize.getHeight() - 80) {
      doc.addPage();
      cursorY = 48;
    }
    doc.text(section.title, 40, cursorY);
    cursorY += 8;

    let head;
    let body;
    if (section.kind === 'keyvalue') {
      head = [[section.keyLabel || 'Item', section.valueLabel || 'Valor']];
      body = section.rows.map((r) => [r.label, displayValue(r.value, r.type, fmtCurrency)]);
    } else {
      const cols = section.columns;
      head = [cols.map((c) => c.label)];
      body = section.rows.map((row) => cols.map((c) => displayValue(row[c.key], c.type, fmtCurrency)));
    }

    autoTable(doc, {
      head,
      body,
      startY: cursorY,
      margin: { left: 40, right: 40 },
      styles: { fontSize: 8, cellPadding: 4, overflow: 'linebreak' },
      headStyles: { fillColor: brand, textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [244, 242, 250] },
      theme: 'grid',
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
