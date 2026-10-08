-- Telão novo (marinho, branco e dourado) — limpa as cores de broadcast SALVAS
-- que eram apenas os PADRÕES das versões anteriores.
--
-- A página Configurações da Transmissão grava TODAS as cores no dia ao salvar,
-- mesmo as que ninguém mexeu. Por isso os dias existentes têm, gravados como se
-- fossem escolha do clube, os padrões antigos:
--   1ª paleta: dourado #d4af37, verde #22c55e, cinza #9ca3af, branco #ffffff
--   2ª paleta: índigo #5b5be8, roxo #7233f8, cinza #9ca3af, branco #ffffff
--
-- Com o layout novo, esses valores fariam o telão sair do padrão (relógio
-- dourado-velho ou índigo em vez de branco) sem o clube ter pedido. Zerar a
-- coluna faz a tela usar o padrão do CÓDIGO (TV_PALETA em TournamentBroadcast.js).
-- Qualquer cor fora dessas listas é escolha deliberada e fica como está.
--
-- Vale para tournament_days (configuração por dia) e tournaments (fallback).

DO $$
DECLARE
  tabela text;
  col text;
BEGIN
  FOREACH tabela IN ARRAY ARRAY['tournament_days', 'tournaments'] LOOP
    FOR col IN
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = tabela
        AND column_name LIKE 'broadcast\_%\_color'
        -- As cores da tela de INTERVALO e do prizepool têm paleta própria e
        -- não entram neste layout.
        AND column_name NOT LIKE 'broadcast\_break\_%'
        AND column_name NOT LIKE 'broadcast\_prizepool\_%'
        AND column_name <> 'broadcast_bg_color'
    LOOP
      EXECUTE format(
        'UPDATE public.%I SET %I = NULL WHERE lower(%I) IN (%L, %L, %L, %L, %L, %L)',
        tabela, col, col,
        '#d4af37', '#22c55e', '#5b5be8', '#7233f8', '#9ca3af', '#ffffff'
      );
    END LOOP;
  END LOOP;
END $$;
