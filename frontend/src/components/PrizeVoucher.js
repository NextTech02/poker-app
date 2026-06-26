import React from 'react';
import { useTranslation } from 'react-i18next';
import { useCurrency } from '../contexts/CurrencyContext';
import './PrizeVoucher.css';

const LANGS = {
  pt: {
    header: 'COMPROVANTE DE PREMIAÇÃO',
    shop: 'POKER CLUB',
    label_tournament: 'Torneio',
    label_day: 'Dia',
    label_position: 'Posição',
    label_player: 'Jogador',
    label_prize: 'PRÊMIO',
    label_document: 'Documento',
    label_date: 'Data',
    label_time: 'Hora',
    label_paid_by: 'Atendente',
    label_signature: 'Assinatura do Ganhador',
    footer: 'Parabéns! Guarde este comprovante.',
    btn_print: 'Imprimir Comprovante',
    position: (p) => `${p}° Lugar`,
  },
  es: {
    header: 'COMPROBANTE DE PREMIACIÓN',
    shop: 'POKER CLUB',
    label_tournament: 'Torneo',
    label_day: 'Día',
    label_position: 'Posición',
    label_player: 'Jugador',
    label_prize: 'PREMIO',
    label_document: 'Documento',
    label_date: 'Fecha',
    label_time: 'Hora',
    label_paid_by: 'Atendido por',
    label_signature: 'Firma del Ganador',
    footer: '¡Felicitaciones! Conserve este comprobante.',
    btn_print: 'Imprimir Comprobante',
    position: (p) => `${p}° Lugar`,
  },
  en: {
    header: 'PRIZE PAYOUT RECEIPT',
    shop: 'POKER CLUB',
    label_tournament: 'Tournament',
    label_day: 'Day',
    label_position: 'Position',
    label_player: 'Player',
    label_prize: 'PRIZE',
    label_document: 'Document',
    label_date: 'Date',
    label_time: 'Time',
    label_paid_by: 'Processed by',
    label_signature: 'Winner Signature',
    footer: 'Congratulations! Keep this receipt.',
    btn_print: 'Print Receipt',
    position: (p) => `${p}${p === 1 ? 'st' : p === 2 ? 'nd' : p === 3 ? 'rd' : 'th'} Place`,
  },
};

const DOC_LABELS = {
  passport: { pt: 'Passaporte', es: 'Pasaporte', en: 'Passport' },
  national_id: { pt: 'Identidade', es: 'Cédula', en: 'National ID' },
  driver_license: { pt: 'CNH', es: 'Licencia', en: "Driver's License" },
};

const maskDocument = (docNumber) => {
  if (!docNumber) return '—';
  const clean = docNumber.replace(/[.\-/\s]/g, '');
  if (clean.length <= 4) return '*'.repeat(clean.length);
  return '*'.repeat(clean.length - 4) + clean.slice(-4);
};

// Pad a label-value pair for monospace receipt layout
const padRow = (label, value, width = 26) => {
  const labelStr = String(label);
  const valueStr = String(value);
  const dots = Math.max(1, width - labelStr.length - valueStr.length);
  return `${labelStr}${' '.repeat(dots)}${valueStr}`;
};

const DIVIDER_HEAVY = '================================';
const DIVIDER_LIGHT = '--------------------------------';

const PrizeVoucher = ({ payout }) => {
  const { i18n } = useTranslation();
  const { formatCurrency } = useCurrency();
  const langCode = i18n.language?.startsWith('en') ? 'en' : i18n.language?.startsWith('es') ? 'es' : 'pt';
  const t = LANGS[langCode] || LANGS.pt;

  const now = new Date(payout.paid_at || new Date().toISOString());
  const locale = langCode === 'en' ? 'en-US' : langCode === 'es' ? 'es-ES' : 'pt-BR';
  const dateStr = now.toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' });
  const timeStr = now.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });

  const docLabel = payout.document_type
    ? (DOC_LABELS[payout.document_type]?.[langCode] || payout.document_type)
    : '';

  const docDisplay = docLabel
    ? `${docLabel}: ${maskDocument(payout.document_number)}`
    : maskDocument(payout.document_number);

  const prizeFormatted = formatCurrency(payout.prize_amount);

  // ── Print ──────────────────────────────────────────────────────────────────
  const handlePrint = () => {
    const printWindow = window.open('', '_blank');

    const tournamentRow = payout.tournament_name
      ? `<tr><td class="lbl">#${t.label_tournament}</td><td class="val">${payout.tournament_name}</td></tr>`
      : '';

    const dayRow = payout.day_name
      ? `<tr><td class="lbl">#${t.label_day}</td><td class="val">${payout.day_name}</td></tr>`
      : '';

    const paidByRow = payout.paid_by
      ? `<tr><td class="lbl">${t.label_paid_by}</td><td class="val">${payout.paid_by}</td></tr>`
      : '';

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>${t.header}</title>
          <style>
            @media print {
              @page { size: 80mm auto; margin: 0; }
              body { margin: 0; padding: 0; }
              .no-print { display: none; }
            }
            * { box-sizing: border-box; }
            body {
              font-family: 'Courier New', Courier, monospace;
              font-size: 12px;
              width: 80mm;
              margin: 0 auto;
              padding: 8mm 6mm;
              background: #fff;
              color: #111;
            }
            .center { text-align: center; }
            .bold { font-weight: bold; }
            .divider-heavy { border: none; border-top: 2px solid #111; margin: 8px 0; }
            .divider-light { border: none; border-top: 1px dashed #555; margin: 6px 0; }
            .stars { letter-spacing: 3px; font-size: 11px; color: #444; }
            .shop-name { font-size: 16px; font-weight: bold; letter-spacing: 2px; margin: 4px 0; }
            .header-title { font-size: 11px; font-weight: bold; letter-spacing: 1px; margin: 2px 0; }
            table { width: 100%; border-collapse: collapse; }
            td { padding: 2px 0; vertical-align: top; }
            td.lbl { color: #444; width: 50%; }
            td.val { font-weight: bold; text-align: right; }
            .meta-lbl { color: #444; }
            .meta-val { font-weight: bold; }
            .section-title { font-weight: bold; font-size: 11px; letter-spacing: 1px; margin: 6px 0 2px; }
            .player-name { font-size: 14px; font-weight: bold; margin: 2px 0; }
            .doc-line { color: #444; margin: 2px 0; }
            .prize-box { text-align: center; margin: 10px 0; }
            .prize-label { font-size: 11px; letter-spacing: 3px; color: #444; }
            .prize-amount { font-size: 24px; font-weight: bold; letter-spacing: 1px; margin: 4px 0; }
            .sig-line { border-bottom: 1px solid #111; margin: 18px 0 4px; }
            .sig-label { font-size: 10px; color: #555; letter-spacing: 0.5px; }
            .footer { font-size: 10px; color: #444; margin-top: 4px; }
          </style>
        </head>
        <body>
          <hr class="divider-heavy">

          <div class="center">
            <div class="header-title">${t.header}</div>
          </div>

          <hr class="divider-heavy">

          <table>
            <tr>
              <td class="meta-lbl">${t.label_date}:</td>
              <td class="meta-val" style="text-align:right">${dateStr}</td>
            </tr>
            <tr>
              <td class="meta-lbl">${t.label_time}:</td>
              <td class="meta-val" style="text-align:right">${timeStr}</td>
            </tr>
            ${paidByRow}
          </table>

          <hr class="divider-heavy">

          <table>
            ${tournamentRow}
            ${dayRow}
            <tr><td class="lbl">#${t.label_position}</td><td class="val">${t.position(payout.position)}</td></tr>
          </table>

          <hr class="divider-light">

          <div class="section-title">${t.label_player.toUpperCase()}:</div>
          <div class="player-name">${payout.player_name}</div>

          <hr class="divider-light">

          <div class="section-title">${t.label_document.toUpperCase()}:</div>
          <div class="doc-line">${docDisplay}</div>

          <hr class="divider-heavy">

          <div class="prize-box">
            <div class="prize-amount">${prizeFormatted}</div>
          </div>

          <hr class="divider-heavy">

          <div class="sig-line"></div>
          <div class="center sig-label">${t.label_signature}</div>

          <hr class="divider-heavy">

          <div class="center footer">${t.footer}</div>

          <script>
            window.onload = function() {
              window.print();
              setTimeout(function() { window.close(); }, 300);
            };
          </script>
        </body>
      </html>
    `;

    printWindow.document.write(html);
    printWindow.document.close();
  };

  // ── Preview ────────────────────────────────────────────────────────────────
  return (
    <div className="pv-wrap">
      <div className="pv-receipt">

        {/* Header */}
        <div className="pv-divider-heavy" />

        <div className="pv-center pv-title">{t.header}</div>

        <div className="pv-divider-heavy" />

        {/* Meta */}
        <div className="pv-row">
          <span className="pv-lbl">{t.label_date}:</span>
          <span className="pv-val">{dateStr}</span>
        </div>
        <div className="pv-row">
          <span className="pv-lbl">{t.label_time}:</span>
          <span className="pv-val">{timeStr}</span>
        </div>
        {payout.paid_by && (
          <div className="pv-row">
            <span className="pv-lbl">{t.label_paid_by}:</span>
            <span className="pv-val">{payout.paid_by}</span>
          </div>
        )}

        <div className="pv-divider-heavy" />

        {/* Items */}
        {payout.tournament_name && (
          <div className="pv-row">
            <span className="pv-lbl pv-item-lbl">#{t.label_tournament}</span>
            <span className="pv-val pv-item-val">{payout.tournament_name}</span>
          </div>
        )}
        {payout.day_name && (
          <div className="pv-row">
            <span className="pv-lbl pv-item-lbl">#{t.label_day}</span>
            <span className="pv-val pv-item-val">{payout.day_name}</span>
          </div>
        )}
        <div className="pv-row">
          <span className="pv-lbl pv-item-lbl">#{t.label_position}</span>
          <span className="pv-val pv-item-val">{t.position(payout.position)}</span>
        </div>

        <div className="pv-divider-light" />

        {/* Player */}
        <div className="pv-section-title">{t.label_player.toUpperCase()}:</div>
        <div className="pv-player-name">{payout.player_name}</div>

        <div className="pv-divider-light" />

        {/* Document */}
        <div className="pv-section-title">{t.label_document.toUpperCase()}:</div>
        <div className="pv-doc">{docDisplay}</div>

        <div className="pv-divider-heavy" />

        {/* Prize */}
        <div className="pv-prize-box">
          <div className="pv-prize-amount">{prizeFormatted}</div>
        </div>

        <div className="pv-divider-heavy" />

        {/* Signature */}
        <div className="pv-sig-line" />
        <div className="pv-center pv-sig-label">{t.label_signature}</div>

        <div className="pv-divider-heavy" />

        {/* Footer */}
        <div className="pv-center pv-footer">{t.footer}</div>

      </div>

      <button className="pv-btn-print" onClick={handlePrint}>
        {t.btn_print}
      </button>
    </div>
  );
};

export default PrizeVoucher;
