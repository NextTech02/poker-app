-- ============================================================================
-- Telão novo: NULL passa a significar "cor padrão do app"
-- ----------------------------------------------------------------------------
-- As cores do telão (`broadcast_*_color` em tournament_days) nunca ficaram
-- vazias: a coluna tinha DEFAULT e o backend gravava o próprio default na
-- criação do dia. Resultado: TODO dia tem uma cor salva — 22 com o dourado
-- antigo (#d4af37, dias criados depois do rebrand, porque o default do
-- backend nunca foi atualizado) e 36 com o índigo (#5b5be8, reescritos pela
-- migração de rebrand). Nenhum clube ESCOLHEU essas cores; eram só o padrão
-- da época. Com o layout novo (dourado), manter esses valores deixaria o
-- padrão novo invisível para todo mundo.
--
-- O que muda:
--   (a) as colunas de cor perdem o DEFAULT (o app decide o padrão);
--   (b) valores iguais a QUALQUER padrão histórico voltam a NULL;
--   (c) a cor de fundo padrão antiga (#0a0e13) também vira NULL — o telão
--       novo usa um gradiente marinho quando não há cor escolhida.
-- Cor escolhida de verdade (fora dos padrões históricos) é PRESERVADA —
-- mesma regra da migração de rebrand.
--
-- ⚠️ ORDEM DE DEPLOY: rodar SÓ DEPOIS do backend que aceita NULL nas cores
-- (`Optional[str]` em TournamentDayBase). Antes disso, qualquer linha com cor
-- NULL derruba `GET /tournament-days/{id}` (validação do modelo de resposta).
-- ============================================================================

DO $$
DECLARE col text;
BEGIN
  FOR col IN
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tournament_days'
      AND column_name LIKE 'broadcast\_%\_color'
  LOOP
    EXECUTE format('ALTER TABLE public.tournament_days ALTER COLUMN %I DROP DEFAULT', col);
    -- padrões de destaque de todas as épocas: dourado antigo, índigo, roxo, verde
    EXECUTE format(
      'UPDATE public.tournament_days SET %I = NULL WHERE %I IN (%L, %L, %L, %L)',
      col, col, '#d4af37', '#5b5be8', '#7233f8', '#22c55e'
    );
  END LOOP;

  -- Neutros (branco / cinza) só nas colunas em que ERAM o padrão: em outra
  -- coluna, branco pode ter sido uma escolha.
  UPDATE public.tournament_days SET broadcast_blinds_value_color    = NULL WHERE broadcast_blinds_value_color    = '#ffffff';
  UPDATE public.tournament_days SET broadcast_prizepool_label_color = NULL WHERE broadcast_prizepool_label_color = '#ffffff';
  UPDATE public.tournament_days SET broadcast_prizepool_value_color = NULL WHERE broadcast_prizepool_value_color = '#ffffff';
  UPDATE public.tournament_days SET broadcast_break_title_color     = NULL WHERE broadcast_break_title_color     = '#ffffff';
  UPDATE public.tournament_days SET broadcast_next_value_color      = NULL WHERE broadcast_next_value_color      = '#9ca3af';
  UPDATE public.tournament_days SET broadcast_sidebar_label_color   = NULL WHERE broadcast_sidebar_label_color   = '#9ca3af';
  UPDATE public.tournament_days SET broadcast_break_label_color     = NULL WHERE broadcast_break_label_color     = '#9ca3af';

  -- Fundo: a cor padrão antiga deixa de ser gravada; NULL = gradiente do app.
  ALTER TABLE public.tournament_days ALTER COLUMN broadcast_bg_color DROP DEFAULT;
  ALTER TABLE public.tournament_days ALTER COLUMN broadcast_break_bg_color DROP DEFAULT;
  UPDATE public.tournament_days SET broadcast_bg_color       = NULL WHERE broadcast_bg_color       = '#0a0e13';
  UPDATE public.tournament_days SET broadcast_break_bg_color = NULL WHERE broadcast_break_bg_color = '#0a0e13';
END $$;

-- Conferência ----------------------------------------------------------------
-- select broadcast_timer_color, count(*) from public.tournament_days group by 1;
--   -> NULL para quase todos; só cores escolhidas à mão sobrevivem.
-- select column_default from information_schema.columns
--   where table_name = 'tournament_days' and column_name = 'broadcast_timer_color';  -- NULL
