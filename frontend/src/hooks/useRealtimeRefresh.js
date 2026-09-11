import { useCallback, useEffect, useRef } from 'react';
import { supabase } from '../config/supabase';

/**
 * Recarrega a tela quando o BANCO avisa que mudou, em vez de perguntar de
 * tempos em tempos.
 *
 * O que isto substitui: `usePolling(load, 5000)`. Uma tela operacional refazia
 * todas as suas consultas doze vezes por minuto, por operador logado, e na
 * imensa maioria das vezes o dado voltava idêntico — era trabalho para
 * descobrir que nada tinha mudado. Cada uma dessas consultas atravessa a
 * internet até o Supabase (~50ms de ida e volta, medido), e cada resposta
 * dispara um re-render da lista inteira.
 *
 * O POLL NÃO SOME, só desacelera (30s por padrão). WebSocket cai: troca de
 * rede, tablet que suspende, proxy que derruba conexão ociosa. Realtime é o
 * caminho rápido, não o único — se ele falhar, a tela fica no máximo 30
 * segundos desatualizada em vez de parar de atualizar para sempre.
 *
 * Precondição: a tabela precisa estar publicada em `supabase_realtime` (ver
 * db/migrations/database_migration_realtime_operacao.sql). Sem isso não chega
 * evento nenhum e a tela cai no poll lento — degrada, não quebra.
 *
 * @param {object}   opts
 * @param {string}   opts.canal     Nome único do canal. Inclua o id do escopo
 *                                  (dia, mesa) para não misturar telas.
 * @param {Array}    opts.tabelas   `[{ table, filter?, event? }]`. `filter` é a
 *                                  sintaxe do Realtime: `coluna=eq.valor`.
 * @param {Function} opts.aoMudar   Chamado (com debounce) quando algo muda.
 * @param {number}   [opts.intervaloDeSeguranca=30000]  Poll de fallback. 0 desliga.
 * @param {boolean}  [opts.ativo=true]  Falso desliga tudo (ex.: id ainda nulo).
 */
export function useRealtimeRefresh({
  canal,
  tabelas,
  aoMudar,
  intervaloDeSeguranca = 30000,
  ativo = true,
}) {
  // Em ref para o efeito de assinatura não depender da identidade da função:
  // a tela redefine `aoMudar` a cada render, e depender dela faria o canal ser
  // derrubado e reassinado sem parar.
  const callbackRef = useRef(aoMudar);
  useEffect(() => {
    callbackRef.current = aoMudar;
  });

  const debounceRef = useRef(null);
  const emVooRef = useRef(false);

  // Uma rajada de eventos (sentar jogador = escreve em cash_seats E em
  // cash_player_sessions E em cash_transactions) vira UM refetch.
  const recarregar = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      // Nunca dois refetches ao mesmo tempo: numa noite movimentada os eventos
      // chegam mais rápido do que a resposta, e sem isto eles se empilham.
      if (emVooRef.current) {
        recarregar();
        return;
      }
      emVooRef.current = true;
      try {
        await callbackRef.current();
      } finally {
        emVooRef.current = false;
      }
    }, 150);
  }, []);

  // `tabelas` costuma ser um literal no corpo do componente — identidade nova a
  // cada render. Compara pelo CONTEÚDO para não reassinar o canal à toa.
  const assinatura = JSON.stringify(tabelas || []);

  useEffect(() => {
    if (!ativo || !canal || !assinatura || assinatura === '[]') return undefined;

    const lista = JSON.parse(assinatura);

    // Se o Realtime não existir neste ambiente, a tela NÃO pode quebrar: ela
    // simplesmente fica no poll de segurança. Já aconteceu neste projeto de uma
    // variável de ambiente não chegar à imagem Docker, e o modo de falha certo
    // para isso é ficar mais lento, não parar de funcionar.
    let channel;
    try {
      channel = supabase.channel(canal);
      lista.forEach(({ table, filter, event }) => {
        channel = channel.on(
          'postgres_changes',
          {
            event: event || '*',
            schema: 'public',
            table,
            ...(filter ? { filter } : {}),
          },
          recarregar,
        );
      });
      channel.subscribe();
    } catch (e) {
      channel = null;
    }

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (channel) {
        try {
          supabase.removeChannel(channel);
        } catch (e) {
          /* canal já derrubado com a conexão */
        }
      }
    };
  }, [canal, assinatura, ativo, recarregar]);

  // ── Rede de segurança ────────────────────────────────────────────────────
  // Pausa com a aba oculta, pelo mesmo motivo do usePolling: operador deixa
  // tela aberta, e sem isso ela martela a API em segundo plano. Ao voltar a
  // ficar visível recarrega na hora — é o momento em que o Realtime pode ter
  // perdido evento, porque a conexão cai quando o aparelho suspende.
  useEffect(() => {
    if (!ativo || !intervaloDeSeguranca) return undefined;

    let id = null;
    const tick = () => {
      if (!document.hidden) recarregar();
    };
    const start = () => {
      if (id == null) id = setInterval(tick, intervaloDeSeguranca);
    };
    const stop = () => {
      if (id != null) {
        clearInterval(id);
        id = null;
      }
    };
    const aoTrocarVisibilidade = () => {
      if (document.hidden) {
        stop();
      } else {
        recarregar();
        start();
      }
    };

    start();
    document.addEventListener('visibilitychange', aoTrocarVisibilidade);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', aoTrocarVisibilidade);
    };
  }, [ativo, intervaloDeSeguranca, recarregar]);
}

export default useRealtimeRefresh;
