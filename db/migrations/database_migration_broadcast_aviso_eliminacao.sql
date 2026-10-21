-- ============================================================================
-- Telão: faixa animada de "Jogador eliminado"
-- ============================================================================
-- POR QUE: o NSOP quer que, quando o floor elimina um jogador, o telão mostre
-- na parte de baixo um texto animado ("JUGADOR ELIMINADO · Carlos Montea").
-- O telão já relê a lista de inscritos do dia a cada 10 s e descobre sozinho
-- quem caiu; só falta o interruptor nas Configurações do broadcast.
--
--   broadcast_show_eliminations  default FALSE: é um elemento novo, o diretor
--                                liga se quiser (dia a dia, como os outros).
--
-- Só na resposta/update do backend, nunca na criação do dia.
-- ADITIVA e IDEMPOTENTE: coluna com default constante (sem reescrever a
-- tabela); o backend atual ignora a coluna. Aplicar ANTES do deploy (a tela
-- de Configurações nova grava o campo).
-- ============================================================================

alter table public.tournament_days
  add column if not exists broadcast_show_eliminations boolean default false;

comment on column public.tournament_days.broadcast_show_eliminations is
  'Telão mostra a faixa animada "Jogador eliminado" quando alguém cai. Padrão false.';
