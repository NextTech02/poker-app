import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import {
  adicionarNaFila, lerFila, novoEventoDeCartao, removerDaFila,
} from '../utils/filaDeCartoes';

// O evento `online` do navegador falha em Wi-Fi sem internet: o reenvio não
// depende só dele.
const REENVIO_MS = 15000;

/**
 * Envia os cartões usados no tablet, com a rede do salão caindo ou não.
 *
 * @param {Function} aoMudar Chamada depois que a fila anda, para reler a mesa.
 * @returns {{fila: Array, usar: Function, desfazer: Function}}
 */
export function useFilaDeCartoes(aoMudar) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [fila, setFila] = useState(lerFila);
  // id do toque → id gravado no servidor, para desfazer o que já foi enviado.
  const gravados = useRef({});
  const envio = useRef(null);
  const aoMudarRef = useRef(aoMudar);
  useEffect(() => {
    aoMudarRef.current = aoMudar;
  });

  const enviar = useCallback(() => {
    // Nunca dois envios ao mesmo tempo: quem chega espera o que está em voo.
    if (envio.current) return envio.current;
    const tarefa = (async () => {
      let mudou = false;
      // Relê a fila a cada volta: o toque feito durante o envio entra junto.
      for (let item = lerFila()[0]; item; item = lerFila()[0]) {
        try {
          // eslint-disable-next-line no-await-in-loop -- um por vez, na ordem dos toques
          const res = await api.post(`/table-clock/table/${item.table_id}/cards`, {
            tournament_player_id: item.tournament_player_id,
            client_event_id: item.client_event_id,
          });
          gravados.current[item.client_event_id] = res.data?.event_id;
          removerDaFila(item.client_event_id);
          mudou = true;
        } catch (erro) {
          // Sem resposta é rede: fica para depois. Com resposta o servidor
          // recusou, e reenviar daria a mesma recusa.
          if (!erro.response) break;
          removerDaFila(item.client_event_id);
          mudou = true;
          toast.error(erro.userMessage || t('tableClock.cardError', 'Não deu para registrar o cartão.'));
        }
      }
      setFila(lerFila());
      if (mudou) aoMudarRef.current();
    })();
    // No `finally`, e não dentro da tarefa: com a fila vazia ela termina sem
    // pausar, e limpar lá dentro viria ANTES desta atribuição, travando o envio.
    envio.current = tarefa.finally(() => { envio.current = null; });
    return envio.current;
  }, [t, toast]);

  useEffect(() => {
    enviar();
    window.addEventListener('online', enviar);
    const reenvio = setInterval(() => {
      if (lerFila().length > 0) enviar();
    }, REENVIO_MS);
    return () => {
      window.removeEventListener('online', enviar);
      clearInterval(reenvio);
    };
  }, [enviar]);

  const usar = useCallback((tableId, tournamentPlayerId) => {
    const evento = novoEventoDeCartao(tableId, tournamentPlayerId);
    adicionarNaFila(evento);
    setFila(lerFila());
    enviar();
    return evento.client_event_id;
  }, [enviar]);

  const desfazer = useCallback(async (clientEventId) => {
    await enviar();
    const eventId = gravados.current[clientEventId];
    if (!eventId) {
      removerDaFila(clientEventId);
      setFila(lerFila());
      return;
    }
    try {
      await api.post(`/table-clock/events/${eventId}/undo`);
      aoMudarRef.current();
    } catch (erro) {
      toast.error(erro.userMessage || t('tableClock.undoError', 'Não deu para desfazer. Peça ao floor para ajustar.'));
    }
  }, [enviar, t, toast]);

  return { fila, usar, desfazer };
}
