import React from 'react';
import { useTranslation } from 'react-i18next';
import './PrizeVoucher.css';

const LANGS = {
  pt: {
    header: 'COMPROVANTE DE PREMIAÇÃO',
    label_tournament: 'Torneio',
    label_day: 'Dia',
    label_position: 'Posição',
    label_player: 'Jogador',
    label_prize: 'Valor do Prêmio',
    label_document: 'Documento',
    label_datetime: 'Data e Hora',
    label_paid_by: 'Atendente',
    label_signature: 'Assinatura do Ganhador',
    footer: 'Parabéns! Guarde este comprovante.',
    btn_print: 'Imprimir Comprovante',
    position: (p) => {
      const labels = { 1: '1° Lugar — Campeão', 2: '2° Lugar — Vice-Campeão', 3: '3° Lugar' };
      return labels[p] || `${p}° Lugar`;
    },
  },
  es: {
    header: 'COMPROBANTE DE PREMIACIÓN',
    label_tournament: 'Torneo',
    label_day: 'Día',
    label_position: 'Posición',
    label_player: 'Jugador',
    label_prize: 'Valor del Premio',
    label_document: 'Documento',
    label_datetime: 'Fecha y Hora',
    label_paid_by: 'Atendido por',
    label_signature: 'Firma del Ganador',
    footer: '¡Felicitaciones! Conserve este comprobante.',
    btn_print: 'Imprimir Comprobante',
    position: (p) => {
      const labels = { 1: '1er Lugar — Campeón', 2: '2do Lugar — Sub-Campeón', 3: '3er Lugar' };
      return labels[p] || `${p}° Lugar`;
    },
  },
  en: {
    header: 'PRIZE PAYOUT RECEIPT',
    label_tournament: 'Tournament',
    label_day: 'Day',
    label_position: 'Position',
    label_player: 'Player',
    label_prize: 'Prize Amount',
    label_document: 'Document',
    label_datetime: 'Date & Time',
    label_paid_by: 'Processed by',
    label_signature: 'Winner Signature',
    footer: 'Congratulations! Keep this receipt.',
    btn_print: 'Print Receipt',
    position: (p) => {
      const labels = { 1: '1st Place — Champion', 2: '2nd Place — Runner-Up', 3: '3rd Place' };
      return labels[p] || `${p}th Place`;
    },
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
  const visible = clean.slice(-4);
  return '*'.repeat(clean.length - 4) + visible;
};

const PrizeVoucher = ({ payout }) => {
  const { i18n } = useTranslation();
  const langCode = i18n.language?.startsWith('en') ? 'en' : i18n.language?.startsWith('es') ? 'es' : 'pt';
  const t = LANGS[langCode] || LANGS.pt;

  const formatCurrency = (value) => {
    const num = parseFloat(value) || 0;
    return num.toLocaleString(
      langCode === 'en' ? 'en-US' : langCode === 'es' ? 'es-CO' : 'pt-BR',
      { minimumFractionDigits: 2, maximumFractionDigits: 2 }
    );
  };

  const formatDate = (dateString) => {
    const date = new Date(dateString);
    const locale = langCode === 'en' ? 'en-US' : langCode === 'es' ? 'es-ES' : 'pt-BR';
    return date.toLocaleDateString(locale, {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  };

  const docLabel = payout.document_type
    ? (DOC_LABELS[payout.document_type]?.[langCode] || payout.document_type)
    : '';

  const handlePrint = () => {
    const printWindow = window.open('', '_blank');

    const tournamentRow = payout.tournament_name
      ? `<div class="row"><div class="lbl">${t.label_tournament}</div><div class="val">${payout.tournament_name}</div></div>`
      : '';

    const dayRow = payout.day_name
      ? `<div class="row"><div class="lbl">${t.label_day}</div><div class="val">${payout.day_name}</div></div>`
      : '';

    const paidByRow = payout.paid_by
      ? `<div class="row"><div class="lbl">${t.label_paid_by}</div><div class="val">${payout.paid_by}</div></div>`
      : '';

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>${t.header} - ${payout.player_name}</title>
          <style>
            @media print {
              @page { size: 80mm auto; margin: 0; }
              body { margin: 0; padding: 0; }
            }
            body {
              font-family: 'Courier New', monospace;
              width: 80mm;
              margin: 0 auto;
              padding: 10mm;
              background: white;
            }
            .ticket { border: 2px dashed #333; padding: 8mm; text-align: center; }
            .header { font-size: 16px; font-weight: bold; margin-bottom: 12px; border-bottom: 2px solid #333; padding-bottom: 8px; }
            .row { margin: 10px 0; text-align: left; }
            .lbl { font-size: 10px; color: #666; text-transform: uppercase; }
            .val { font-size: 14px; font-weight: bold; margin-top: 2px; }
            .highlight { background: #f9f9f9; border: 2px solid #333; border-radius: 4px; padding: 8px; margin: 12px 0; }
            .position-text { font-size: 13px; color: #555; font-weight: bold; }
            .prize-amount { font-size: 28px; font-weight: bold; margin: 6px 0; }
            .signature-area { margin-top: 20px; padding-top: 10px; border-top: 1px solid #333; }
            .signature-line { border-bottom: 1px solid #333; margin: 20px 0 4px; }
            .signature-lbl { font-size: 10px; color: #666; text-transform: uppercase; }
            .footer { margin-top: 16px; padding-top: 8px; border-top: 2px solid #333; font-size: 10px; color: #666; }
          </style>
        </head>
        <body>
          <div class="ticket">
            <div class="header">${t.header}</div>
            ${tournamentRow}
            ${dayRow}
            <div class="highlight">
              <div class="position-text">${t.position(payout.position)}</div>
              <div class="prize-amount">R$ ${formatCurrency(payout.prize_amount)}</div>
            </div>
            <div class="row"><div class="lbl">${t.label_player}</div><div class="val">${payout.player_name}</div></div>
            <div class="row">
              <div class="lbl">${t.label_document}</div>
              <div class="val">${docLabel ? docLabel + ': ' : ''}${maskDocument(payout.document_number)}</div>
            </div>
            <div class="row"><div class="lbl">${t.label_datetime}</div><div class="val">${formatDate(payout.paid_at || new Date().toISOString())}</div></div>
            ${paidByRow}
            <div class="signature-area">
              <div class="signature-line"></div>
              <div class="signature-lbl">${t.label_signature}</div>
            </div>
            <div class="footer">${t.footer}</div>
          </div>
          <script>
            window.onload = function() { window.print(); setTimeout(function() { window.close(); }, 100); }
          </script>
        </body>
      </html>
    `;

    printWindow.document.write(html);
    printWindow.document.close();
  };

  return (
    <div className="prize-voucher">
      <div className="voucher-preview">
        <div className="voucher-header">
          <h4>{t.header}</h4>
        </div>
        <div className="voucher-body">
          {payout.tournament_name && (
            <div className="voucher-row">
              <span className="label">{t.label_tournament}</span>
              <span className="value">{payout.tournament_name}</span>
            </div>
          )}
          {payout.day_name && (
            <div className="voucher-row">
              <span className="label">{t.label_day}</span>
              <span className="value">{payout.day_name}</span>
            </div>
          )}
          <div className="voucher-highlight">
            <div className="position-label">{t.position(payout.position)}</div>
            <div className="prize-amount">R$ {formatCurrency(payout.prize_amount)}</div>
          </div>
          <div className="voucher-row">
            <span className="label">{t.label_player}</span>
            <span className="value">{payout.player_name}</span>
          </div>
          <div className="voucher-row">
            <span className="label">{t.label_document}</span>
            <span className="value">
              {docLabel ? `${docLabel}: ` : ''}{maskDocument(payout.document_number)}
            </span>
          </div>
          <div className="voucher-row">
            <span className="label">{t.label_datetime}</span>
            <span className="value">{formatDate(payout.paid_at || new Date().toISOString())}</span>
          </div>
          {payout.paid_by && (
            <div className="voucher-row">
              <span className="label">{t.label_paid_by}</span>
              <span className="value">{payout.paid_by}</span>
            </div>
          )}
        </div>
      </div>

      <button className="btn-print-voucher" onClick={handlePrint}>
        {t.btn_print}
      </button>
    </div>
  );
};

export default PrizeVoucher;
