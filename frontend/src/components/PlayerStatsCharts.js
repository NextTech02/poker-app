import React, { useMemo, useState } from 'react';
import './PlayerStatsCharts.css';

// Gráficos do perfil do jogador — inline SVG, sem dependências.
// Seguem a paleta AceBlind: série única em roxo (identidade), lucro/prejuízo em
// verde/vermelho (polaridade semântica). Marcas finas, grid recessivo, tooltip
// nativo por ponto/barra, texto em tokens de texto (nunca na cor da série).

const W = 760;
const PAD = { t: 16, r: 18, b: 30, l: 58 };

const yScale = (v, yMin, yMax, innerH) =>
  yMax === yMin ? PAD.t + innerH / 2 : PAD.t + (1 - (v - yMin) / (yMax - yMin)) * innerH;

const fmtDate = (iso, locale) => {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(locale, { day: '2-digit', month: 'short' });
  } catch {
    return '';
  }
};

// ── Evolução: lucro líquido acumulado ao longo do tempo ─────────────────────
function EvolutionChart({ points, formatCurrency, locale, title }) {
  const H = 224;
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const n = points.length;
  const [hover, setHover] = useState(null);

  const { xs, y, yMin, yMax, linePath, areaPath } = useMemo(() => {
    const cums = points.map((p) => p.cum);
    let hi = Math.max(0, ...cums);
    let lo = Math.min(0, ...cums);
    const pad = (hi - lo) * 0.12 || Math.abs(hi || 1) * 0.12 || 1;
    hi += pad; lo -= pad;
    const xsFn = (i) => PAD.l + (n <= 1 ? innerW / 2 : (i * innerW) / (n - 1));
    const yFn = (v) => yScale(v, lo, hi, innerH);
    const pts = points.map((p, i) => `${xsFn(i).toFixed(1)},${yFn(p.cum).toFixed(1)}`);
    const line = `M ${pts.join(' L ')}`;
    const area = `M ${xsFn(0).toFixed(1)},${yFn(0).toFixed(1)} L ${pts.join(' L ')} L ${xsFn(n - 1).toFixed(1)},${yFn(0).toFixed(1)} Z`;
    return { xs: xsFn, y: yFn, yMin: lo, yMax: hi, linePath: line, areaPath: area };
  }, [points, n, innerW, innerH]);

  const last = points[n - 1];

  return (
    <div className="psc-card">
      <h3 className="psc-title">{title}</h3>
      <svg viewBox={`0 0 ${W} ${H}`} className="psc-svg" role="img" aria-label={title}>
        <defs>
          <linearGradient id="psc-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent-color, #7233f8)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--accent-color, #7233f8)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* grade recessiva: topo, zero, base */}
        {[yMax, 0, yMin].map((v, i) => (
          <g key={i}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)}
              className={v === 0 ? 'psc-grid psc-grid-zero' : 'psc-grid'} />
            <text x={PAD.l - 8} y={y(v) + 3} className="psc-axis" textAnchor="end">
              {formatCurrency(v)}
            </text>
          </g>
        ))}

        <path d={areaPath} fill="url(#psc-area)" />
        <path d={linePath} className="psc-line" fill="none" />

        {/* pontos + tooltip nativo */}
        {points.map((p, i) => (
          <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <circle cx={xs(i)} cy={y(p.cum)} r={hover === i ? 5 : (i === n - 1 ? 4 : 2.5)}
              className={`psc-dot ${i === n - 1 ? 'psc-dot-last' : ''}`} />
            <title>{`${p.label} — ${formatCurrency(p.cum)}`}</title>
          </g>
        ))}

        {/* rótulos de data: primeiro e último */}
        <text x={PAD.l} y={H - 10} className="psc-axis" textAnchor="start">{fmtDate(points[0]?.date, locale)}</text>
        {n > 1 && (
          <text x={W - PAD.r} y={H - 10} className="psc-axis" textAnchor="end">{fmtDate(last?.date, locale)}</text>
        )}
      </svg>
    </div>
  );
}

// ── Resultado por torneio: lucro/prejuízo (barras verde/vermelho) ───────────
function NetBarsChart({ rows, formatCurrency, locale, title }) {
  const H = 200;
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const n = rows.length;
  const [hover, setHover] = useState(null);

  const { band, bw, y, yMin, yMax } = useMemo(() => {
    const nets = rows.map((r) => r.net);
    let hi = Math.max(0, ...nets);
    let lo = Math.min(0, ...nets);
    const pad = (hi - lo) * 0.12 || Math.abs(hi || 1) * 0.12 || 1;
    hi += pad; lo -= pad;
    const bandFn = innerW / Math.max(n, 1);
    const barW = Math.min(bandFn - 6, 42);
    return { band: bandFn, bw: Math.max(barW, 3), y: (v) => yScale(v, lo, hi, innerH), yMin: lo, yMax: hi };
  }, [rows, n, innerW, innerH]);

  const zeroY = y(0);

  return (
    <div className="psc-card">
      <h3 className="psc-title">{title}</h3>
      <svg viewBox={`0 0 ${W} ${H}`} className="psc-svg" role="img" aria-label={title}>
        {[yMax, 0, yMin].map((v, i) => (
          <g key={i}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)}
              className={v === 0 ? 'psc-grid psc-grid-zero' : 'psc-grid'} />
            <text x={PAD.l - 8} y={y(v) + 3} className="psc-axis" textAnchor="end">
              {formatCurrency(v)}
            </text>
          </g>
        ))}

        {rows.map((r, i) => {
          const cx = PAD.l + i * band + band / 2;
          const top = r.net >= 0 ? y(r.net) : zeroY;
          const h = Math.abs(zeroY - y(r.net));
          return (
            <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={cx - bw / 2} y={top} width={bw} height={Math.max(h, 1)} rx="3"
                className={`psc-bar ${r.net >= 0 ? 'psc-bar-pos' : 'psc-bar-neg'} ${hover === i ? 'psc-bar-hover' : ''}`} />
              <title>{`${r.label} — ${formatCurrency(r.net)}`}</title>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/**
 * Seção de gráficos do jogador. Recebe o histórico de participações e monta:
 * evolução do lucro acumulado + resultado por torneio.
 */
export default function PlayerStatsCharts({ history, formatCurrency, locale, labels }) {
  const { cum, rows } = useMemo(() => {
    const sorted = [...(history || [])]
      .filter((h) => h.registered_at)
      .sort((a, b) => new Date(a.registered_at) - new Date(b.registered_at))
      .map((h) => ({
        label: h.tournament_name || '—',
        date: h.registered_at,
        net: (Number(h.prize_won) || 0) - (Number(h.total_spent) || 0),
      }));
    let run = 0;
    const cumulative = sorted.map((r) => { run += r.net; return { ...r, cum: run }; });
    return { cum: cumulative, rows: sorted };
  }, [history]);

  if (rows.length < 2) return null; // gráfico só faz sentido com ≥2 pontos

  return (
    <div className="psc-grid-wrap">
      <EvolutionChart points={cum} formatCurrency={formatCurrency} locale={locale} title={labels.evolution} />
      <NetBarsChart rows={rows} formatCurrency={formatCurrency} locale={locale} title={labels.perTournament} />
    </div>
  );
}
