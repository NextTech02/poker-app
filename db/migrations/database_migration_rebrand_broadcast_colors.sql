-- Rebrand AceBlind — migra as cores de broadcast SALVAS no banco.
--
-- As cores da tela de TV (broadcast_*_color em tournament_days) são persistidas
-- por dia. O rebrand do CÓDIGO só muda o DEFAULT de novos dias; os 36 dias
-- existentes continuavam com o dourado antigo (#d4af37) e o verde (#22c55e).
--
-- Troca apenas os valores que eram os PADRÕES antigos (nenhum dia estava
-- customizado — verificado), preservando qualquer cor definida manualmente.
--   dourado #d4af37 -> índigo AceBlind #5b5be8
--   verde   #22c55e -> roxo AceBlind   #7233f8

DO $$
DECLARE col text;
BEGIN
  FOR col IN
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='tournament_days'
      AND column_name LIKE 'broadcast\_%\_color'
  LOOP
    EXECUTE format('UPDATE public.tournament_days SET %I = %L WHERE %I = %L', col, '#5b5be8', col, '#d4af37');
    EXECUTE format('UPDATE public.tournament_days SET %I = %L WHERE %I = %L', col, '#7233f8', col, '#22c55e');
  END LOOP;
END $$;
