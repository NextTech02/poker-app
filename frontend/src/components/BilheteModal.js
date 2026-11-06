import React from 'react';
import { useTranslation } from 'react-i18next';
import Button from './Button';
import SeatTicket from './SeatTicket';
import { useEscapeKey } from '../hooks/useEscapeKey';
import './BilheteModal.css';

// Título do bilhete: reimpressão, etapa sem mesa cadastrada, alternado de
// verdade ou alocado. Um caso por linha — encadeados em ternário, o operador
// lia "alternado" onde na verdade faltava cadastrar mesa.
const tituloDoBilhete = (dados, t) => {
  if (dados.is_reprint) return t('cashRegister.reprintTitle');
  if (dados.motivo_alternate === 'sem-mesas') {
    return t('cashRegister.registeredNoTables', 'Registrado — nenhuma mesa cadastrada');
  }
  if (dados.is_alternate) return t('cashRegister.registeredAsAlternate');
  // Sem assento a mostrar: só add-on (o jogador já está sentado) ou alocação
  // feita pelo staff. Dizer "alocado" aqui mandaria procurar uma mesa no papel.
  if (dados.so_fichas) return t('cashRegister.chipsSoldTitle', 'Fichas vendidas');
  if (dados.sem_assento && dados.via_ticket) {
    return t('satelliteTickets.redeemedNoSeat', 'Ticket resgatado — o staff define o assento');
  }
  if (dados.sem_assento) return t('cashRegister.registeredNoSeat', 'Venda registrada — o staff define o assento');
  return t('cashRegister.registeredAndAllocated');
};

/**
 * O bilhete que sai depois de uma entrada: a venda do Caixa ou o resgate de um
 * ticket. Imprimir fica no botão do bilhete: `window.open` precisa do clique do
 * operador, e abrir sozinho depois da resposta do servidor seria bloqueado.
 */
const BilheteModal = ({ dados, formatarValor, onFechar }) => {
  const { t } = useTranslation();
  useEscapeKey(true, onFechar);

  return (
    <div
      className="modal-overlay"
      role="presentation"
      onClick={(evento) => { if (evento.target === evento.currentTarget) onFechar(); }}
    >
      <div className="modal">
        <div className="modal-header">
          <h2>
            {tituloDoBilhete(dados, t)}
          </h2>
          <button type="button" className="close-btn" onClick={onFechar} aria-label={t('common.close')}>
            <span className="close-icon"></span>
          </button>
        </div>
        <div className="modal-body">
          {/* Por que este bilhete saiu sem assento. "Mesas cheias" é fila
              de alternados de verdade; "nenhuma mesa cadastrada" é a
              etapa por configurar e o bilhete NÃO significa fila. */}
          {dados.motivo_alternate === 'sem-mesas' && (
            <p className="bilhete-aviso" role="alert">
              {t(
                'cashRegister.ticketNoTablesHint',
                'Não há mesa cadastrada neste dia: o jogador não entrou em fila de alternados. Cadastre as mesas em Mesas e aloque o jogador.'
              )}
            </p>
          )}
          {dados.motivo_alternate === 'sem-conexao' && (
            <output className="bilhete-aviso">
              {t(
                'cashRegister.ticketOfflineHint',
                'Venda guardada sem internet: o assento é definido na sincronização.'
              )}
            </output>
          )}
          <SeatTicket
            allocation={{
              id: dados.id,
              // O bilhete usa a imagem/sede do torneio (ou a do clube).
              tournament_id: dados.tournament_id,
              player_name: dados.player_name,
              tournament_name: dados.tournament_name,
              day_name: dados.day_name,
              table_number: dados.table_number,
              seat_number: dados.seat_number,
              created_at: dados.created_at,
              is_alternate: dados.is_alternate,
              sem_assento: dados.sem_assento,
              so_fichas: dados.so_fichas,
              // O que o jogador comprou NESTA venda e o total de fichas:
              // é por esse número que o floor entrega a pilha.
              itens: dados.itens,
              total_amount: dados.total_amount,
              total_chips: dados.total_chips,
            }}
            formatarValor={formatarValor}
            onPrint={onFechar}
          />
        </div>
        <div className="modal-actions">
          <Button onClick={onFechar}>
            {t('common.close')}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default BilheteModal;
