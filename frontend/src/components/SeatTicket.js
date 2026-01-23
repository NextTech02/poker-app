import React from 'react';
import './SeatTicket.css';

const SeatTicket = ({ allocation, onPrint }) => {
  const formatDate = (dateString) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const handlePrint = () => {
    const printWindow = window.open('', '_blank');
    const ticketHTML = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Bilhete - ${allocation.player_name}</title>
          <style>
            @media print {
              @page {
                size: 80mm auto;
                margin: 0;
              }
              body {
                margin: 0;
                padding: 0;
              }
            }
            body {
              font-family: 'Courier New', monospace;
              width: 80mm;
              margin: 0 auto;
              padding: 10mm;
              background: white;
            }
            .ticket {
              border: 2px dashed #333;
              padding: 8mm;
              text-align: center;
            }
            .ticket-header {
              font-size: 18px;
              font-weight: bold;
              margin-bottom: 15px;
              border-bottom: 2px solid #333;
              padding-bottom: 10px;
            }
            .ticket-section {
              margin: 15px 0;
              text-align: left;
            }
            .ticket-label {
              font-size: 11px;
              color: #666;
              text-transform: uppercase;
            }
            .ticket-value {
              font-size: 16px;
              font-weight: bold;
              margin-top: 3px;
            }
            .ticket-highlight {
              background: #f0f0f0;
              padding: 10px;
              margin: 15px 0;
              border-radius: 5px;
            }
            .ticket-table-seat {
              font-size: 24px;
              font-weight: bold;
              margin: 15px 0;
            }
            .ticket-footer {
              margin-top: 20px;
              padding-top: 10px;
              border-top: 2px solid #333;
              font-size: 10px;
              color: #666;
            }
            .qr-placeholder {
              width: 60mm;
              height: 60mm;
              margin: 10px auto;
              border: 1px dashed #ccc;
              display: flex;
              align-items: center;
              justify-content: center;
              font-size: 12px;
              color: #999;
            }
          </style>
        </head>
        <body>
          <div class="ticket">
            <div class="ticket-header">
              BILHETE DE ENTRADA
            </div>

            <div class="ticket-section">
              <div class="ticket-label">Torneio</div>
              <div class="ticket-value">${allocation.tournament_name}</div>
            </div>

            <div class="ticket-section">
              <div class="ticket-label">Jogador</div>
              <div class="ticket-value">${allocation.player_name}</div>
            </div>

            <div class="ticket-highlight">
              <div class="ticket-label">Sua Mesa e Assento</div>
              <div class="ticket-table-seat">
                MESA ${allocation.table_number} - ASSENTO ${allocation.seat_number}
              </div>
            </div>

            <div class="ticket-section">
              <div class="ticket-label">Data e Hora</div>
              <div class="ticket-value">${formatDate(allocation.created_at)}</div>
            </div>

            <div class="ticket-section">
              <div class="ticket-label">ID da Alocação</div>
              <div class="ticket-value" style="font-size: 10px;">${allocation.id}</div>
            </div>

            <div class="ticket-footer">
              Boa sorte!<br>
              Mantenha este bilhete para identificação
            </div>
          </div>
          <script>
            window.onload = function() {
              window.print();
              setTimeout(function() {
                window.close();
              }, 100);
            }
          </script>
        </body>
      </html>
    `;

    printWindow.document.write(ticketHTML);
    printWindow.document.close();
  };

  return (
    <div className="seat-ticket">
      <div className="ticket-preview">
        <div className="ticket-preview-header">
          <h4>Bilhete de Entrada</h4>
        </div>
        <div className="ticket-preview-body">
          <div className="ticket-preview-row">
            <span className="label">Torneio:</span>
            <span className="value">{allocation.tournament_name}</span>
          </div>
          <div className="ticket-preview-row">
            <span className="label">Jogador:</span>
            <span className="value">{allocation.player_name}</span>
          </div>
          <div className="ticket-preview-highlight">
            <div className="table-seat-display">
              Mesa {allocation.table_number} - Assento {allocation.seat_number}
            </div>
          </div>
          <div className="ticket-preview-row">
            <span className="label">Alocado em:</span>
            <span className="value">{formatDate(allocation.created_at)}</span>
          </div>
        </div>
      </div>
      <button className="btn-print-ticket" onClick={handlePrint}>
        Imprimir Bilhete
      </button>
    </div>
  );
};

export default SeatTicket;
