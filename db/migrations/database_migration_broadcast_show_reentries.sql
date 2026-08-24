-- ============================================================================
-- Telão: interruptor para exibir (ou não) as reentradas
-- ============================================================================
-- POR QUE: recompra e add-on NÃO criam jogador novo — quem recompra três vezes
-- continua sendo uma pessoa na mesa. A contagem do torneio somava as duas
-- coisas num número só, o que inflava "jogadores"; agora elas são exibidas
-- separadas.
--
-- No telão, porém, nem todo clube quer mostrar quantas reentradas houve: é uma
-- informação que diz quanto o campo recomprou, e alguns diretores preferem não
-- expor isso para a mesa. Por isso é um interruptor, e não um número fixo.
--
-- Segue exatamente o padrão dos outros ajustes de exibição do telão
-- (broadcast_show_chipcount, broadcast_show_average, ...): BOOLEAN com DEFAULT,
-- lido no frontend como `!== false` para que um dia antigo, sem a coluna
-- preenchida, se comporte como o padrão.
--
-- DEFAULT false de propósito, diferente dos demais: o número não existia até
-- agora, então ligá-lo sozinho mudaria o telão de todos os clubes sem ninguém
-- ter pedido. Quem quiser, liga.
--
-- ADITIVA e IDEMPOTENTE.
-- ============================================================================

ALTER TABLE public.tournament_days
  ADD COLUMN IF NOT EXISTS broadcast_show_reentries BOOLEAN DEFAULT false;

COMMENT ON COLUMN public.tournament_days.broadcast_show_reentries IS
  'Telão exibe a contagem de reentradas (recompras + add-ons). Padrão false: '
  'o número é novo e ligá-lo sozinho mudaria o telão de quem não pediu.';
