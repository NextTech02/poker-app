import React from 'react';
import { useTranslation } from 'react-i18next';
import { usePermissions } from '../contexts/PermissionContext';
import { useBrandingDoBilhete } from '../hooks/useBrandingDoBilhete';
import { htmlDoBilhete } from '../utils/bilhete';
import './SeatTicket.css';

const LANGS = {
  pt: {
    header_chips: 'BILHETE DE FICHAS',
    preview_header_chips: 'Bilhete de Fichas',
    label_purchase: 'Compra',
    label_total: 'TOTAL',
    label_chips_to_deliver: 'Fichas a entregar',
    chips_unit: 'fichas',
    footer_chips: 'Entregue este bilhete ao floor<br>para receber as fichas.',
    header_entry: 'BILHETE DE ENTRADA',
    header_alternate: 'BILHETE DE ALTERNATE',
    label_tournament: 'Torneio',
    label_day: 'Dia',
    label_player: 'Jogador',
    label_seat: 'Sua Mesa e Assento',
    label_status: 'Status',
    label_datetime: 'Data e Hora',
    label_id: 'ID',
    seat_display: (t, s) => `MESA ${t} - ASSENTO ${s}`,
    alternate_text: 'ALTERNATE',
    alternate_sub: 'Aguardando alocação de mesa',
    footer_entry: 'Boa sorte!<br>Mantenha este bilhete para identificação',
    footer_alternate: 'Você está na lista de alternates.<br>Aguarde ser chamado pelo staff.',
    btn_print: 'Imprimir Bilhete',
    preview_header_entry: 'Bilhete de Entrada',
    preview_header_alternate: 'Ticket de Alternate',
    preview_tournament: 'Torneio:',
    preview_day: 'Dia:',
    preview_player: 'Jogador:',
    preview_hour: 'Hora:',
    preview_seat: (t, s) => `Mesa ${t} - Assento ${s}`,
    alternate_waiting: 'Aguardando alocação de mesa',
  },
  es: {
    header_chips: 'BOLETO DE FICHAS',
    preview_header_chips: 'Boleto de Fichas',
    label_purchase: 'Compra',
    label_total: 'TOTAL',
    label_chips_to_deliver: 'Fichas a entregar',
    chips_unit: 'fichas',
    footer_chips: 'Entregue este boleto al floor<br>para recibir sus fichas.',
    header_entry: 'BOLETO DE ENTRADA',
    header_alternate: 'BOLETO DE ALTERNATE',
    label_tournament: 'Torneo',
    label_day: 'Día',
    label_player: 'Jugador',
    label_seat: 'Su Mesa y Asiento',
    label_status: 'Estado',
    label_datetime: 'Fecha y Hora',
    label_id: 'ID',
    seat_display: (t, s) => `MESA ${t} - ASIENTO ${s}`,
    alternate_text: 'ALTERNATE',
    alternate_sub: 'Esperando asignación de mesa',
    footer_entry: '¡Buena suerte!<br>Conserve este boleto para identificación',
    footer_alternate: 'Usted está en la lista de alternates.<br>Espere a ser llamado por el staff.',
    btn_print: 'Imprimir Boleto',
    preview_header_entry: 'Boleto de Entrada',
    preview_header_alternate: 'Ticket de Alternate',
    preview_tournament: 'Torneo:',
    preview_day: 'Día:',
    preview_player: 'Jugador:',
    preview_hour: 'Hora:',
    preview_seat: (t, s) => `Mesa ${t} - Asiento ${s}`,
    alternate_waiting: 'Esperando asignación de mesa',
  },
  en: {
    header_chips: 'CHIPS TICKET',
    preview_header_chips: 'Chips Ticket',
    label_purchase: 'Purchase',
    label_total: 'TOTAL',
    label_chips_to_deliver: 'Chips to deliver',
    chips_unit: 'chips',
    footer_chips: 'Hand this ticket to the floor<br>to receive your chips.',
    header_entry: 'ENTRY TICKET',
    header_alternate: 'ALTERNATE TICKET',
    label_tournament: 'Tournament',
    label_day: 'Day',
    label_player: 'Player',
    label_seat: 'Your Table & Seat',
    label_status: 'Status',
    label_datetime: 'Date & Time',
    label_id: 'ID',
    seat_display: (t, s) => `TABLE ${t} - SEAT ${s}`,
    alternate_text: 'ALTERNATE',
    alternate_sub: 'Waiting for table assignment',
    footer_entry: 'Good luck!<br>Keep this ticket for identification',
    footer_alternate: 'You are on the alternates list.<br>Wait to be called by staff.',
    btn_print: 'Print Ticket',
    preview_header_entry: 'Entry Ticket',
    preview_header_alternate: 'Alternate Ticket',
    preview_tournament: 'Tournament:',
    preview_day: 'Day:',
    preview_player: 'Player:',
    preview_hour: 'Time:',
    preview_seat: (t, s) => `Table ${t} - Seat ${s}`,
    alternate_waiting: 'Waiting for table assignment',
  },
};

const valorPadrao = (v) => Number(v || 0).toFixed(2);

/**
 * `allocation.itens` (opcional): o que o jogador comprou NESTA ida ao caixa —
 * `[{ name, amount, chips }]`, com `total_amount` e `total_chips`. Com itens, o
 * bilhete lista cada um e traz o TOTAL DE FICHAS em destaque: é o número que o
 * floor confere para entregar a pilha, sem somar de cabeça. Cada item sai
 * como "NOME: valor / fichas" (o formato que o clube pediu para o add-on); a
 * linha TOTAL só aparece com dois ou mais itens.
 *
 * `allocation.sem_assento`: venda sem assento a mostrar (alocação manual ou só
 * add-on). O bloco de mesa sai do papel em vez de imprimir "MESA undefined".
 * `allocation.so_fichas`: venda só de add-ons — o título vira "bilhete de fichas".
 */
const SeatTicket = ({ allocation, onPrint, formatarValor = valorPadrao }) => {
  const isAlternate = !!allocation.is_alternate;
  const semAssento = !isAlternate && !!allocation.sem_assento;
  const soFichas = !!allocation.so_fichas;
  const itens = Array.isArray(allocation.itens) ? allocation.itens : [];
  const temItens = itens.length > 0;
  const { i18n } = useTranslation();
  // Layout do clube (imagem, cidade, sede, enfeites) e quem está vendendo.
  const branding = useBrandingDoBilhete(allocation.tournament_id);
  const { staffName } = usePermissions() || {};
  // Map i18next locale ('pt-BR', 'en-US', 'es-ES') to LANGS key
  const langCode = i18n.language?.startsWith('en') ? 'en' : i18n.language?.startsWith('es') ? 'es' : 'pt';
  const t = LANGS[langCode] || LANGS.pt;
  const locale = langCode === 'en' ? 'en-US' : langCode === 'es' ? 'es-ES' : 'pt-BR';
  const formatarFichas = (n) => Number(n || 0).toLocaleString(locale);
  const totalFichas = allocation.total_chips
    ?? itens.reduce((soma, item) => soma + (Number(item.chips) || 0), 0);
  const totalValor = allocation.total_amount
    ?? itens.reduce((soma, item) => soma + (Number(item.amount) || 0), 0);

  let cabecalhoPrevia = t.preview_header_entry;
  if (isAlternate) cabecalhoPrevia = t.preview_header_alternate;
  else if (soFichas) cabecalhoPrevia = t.preview_header_chips;

  const formatDate = (dateString) => {
    const date = new Date(dateString);
    return date.toLocaleDateString(locale, {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const handlePrint = () => {
    const printWindow = window.open('', '_blank');
    if (!printWindow) return;
    // Bilhete no layout do clube (utils/bilhete.js): imagem, cidade, sede e
    // enfeites configurados pelo diretor; o torneio pode trocar a imagem.
    printWindow.document.write(htmlDoBilhete({
      allocation,
      branding: branding || {},
      idioma: langCode,
      formatarValor,
      caixa: allocation.cashier_name || staffName || '',
    }));
    printWindow.document.close();
  };

  return (
    <div className="seat-ticket">
      <div className={`ticket-preview ${isAlternate ? 'alternate-preview' : ''}`}>
        {branding?.logoUrl && (
          <div className="ticket-preview-logo">
            <img src={branding.logoUrl} alt="" />
          </div>
        )}
        <div className="ticket-preview-header">
          <h4>{cabecalhoPrevia}</h4>
        </div>
        <div className="ticket-preview-body">
          {allocation.tournament_name && (
            <div className="ticket-preview-row">
              <span className="label">{t.preview_tournament}</span>
              <span className="value">{allocation.tournament_name}</span>
            </div>
          )}
          {allocation.day_name && (
            <div className="ticket-preview-row">
              <span className="label">{t.preview_day}</span>
              <span className="value">{allocation.day_name}</span>
            </div>
          )}
          {!allocation.tournament_name && !allocation.day_name && (
            <div className="ticket-preview-row">
              <span className="label">{t.preview_tournament}</span>
              <span className="value">—</span>
            </div>
          )}
          <div className="ticket-preview-row">
            <span className="label">{t.preview_player}</span>
            <span className="value">{allocation.player_name}</span>
          </div>

          {isAlternate && (
            <div className="ticket-preview-highlight alternate-highlight">
              <div className="alternate-badge">{t.alternate_text}</div>
              <div className="alternate-waiting">{t.alternate_waiting}</div>
            </div>
          )}
          {!isAlternate && !semAssento && (
            <div className="ticket-preview-highlight">
              <div className="table-seat-display">
                {t.preview_seat(allocation.table_number, allocation.seat_number)}
              </div>
            </div>
          )}

          {temItens && (
            <div className="ticket-preview-purchase" data-testid="bilhete-compra">
              <div className="ticket-preview-purchase-title">{t.label_purchase}</div>
              <ul className="ticket-preview-items">
                {itens.map((item, indice) => (
                  // Índice na chave: o nome pode repetir entre meios diferentes.
                  <li key={`${item.name}-${indice}`} className="ticket-preview-item">
                    <span className="item-name">{item.name}</span>
                    <span className="item-sep">: </span>
                    <span className="item-amount">{formatarValor(item.amount)}</span>
                    <span className="item-sep"> / </span>
                    <span className="item-chips">{formatarFichas(item.chips)} {t.chips_unit}</span>
                  </li>
                ))}
                {itens.length > 1 && (
                  <li className="ticket-preview-item ticket-preview-item--total">
                    <span className="item-name">{t.label_total}</span>
                    <span className="item-sep">: </span>
                    <span className="item-amount">{formatarValor(totalValor)}</span>
                    <span className="item-sep"> / </span>
                    <span className="item-chips">{formatarFichas(totalFichas)} {t.chips_unit}</span>
                  </li>
                )}
              </ul>
              <div className="ticket-preview-highlight ticket-preview-chips">
                <div className="ticket-preview-chips-label">{t.label_chips_to_deliver}</div>
                <div className="table-seat-display" data-testid="bilhete-total-fichas">
                  {formatarFichas(totalFichas)} {t.chips_unit}
                </div>
              </div>
            </div>
          )}

          <div className="ticket-preview-row">
            <span className="label">{t.preview_hour}</span>
            <span className="value">{formatDate(allocation.created_at)}</span>
          </div>
        </div>
      </div>

      <button type="button" className="btn-print-ticket" onClick={handlePrint}>
        {t.btn_print}
      </button>
    </div>
  );
};

export default SeatTicket;
