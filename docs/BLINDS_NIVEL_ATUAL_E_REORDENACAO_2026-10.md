# Estrutura de blinds: nível atual sinalizado + reordenar arrastando (out/2026)

Pedido do cliente: na tela de estrutura de blinds do dia
(`/blinds/:dayId`, `pages/BlindManagement.js`), (1) mostrar em que nível o
torneio está, para o diretor se achar; (2) arrastar níveis e intervalos para
cima/baixo sem dar erro.

## Por que arrastar dava erro

A tela gravava a nova ordem **nível a nível** (um `PATCH` por linha que mudou
de posição). O banco tem o índice único `idx_blinds_day_level_unique
(tournament_day_id, level)` e o `PATCH` recusa um nível já usado no dia —
então a primeira linha que pulava para a posição de outra falhava, a tela
avisava e voltava para a ordem do servidor. Intervalo ou nível, tanto faz.

## O que mudou

**Banco.** `db/migrations/database_migration_reorder_day_blinds.sql` cria a
função `reorder_day_blinds(p_day_id uuid, p_ids uuid[])`: recebe a ORDEM
inteira (ids na posição final), valida que a lista é exatamente a do dia e
renumera em duas fases numa transação só (desloca todos os níveis em
+100000 para sair do caminho do índice, depois grava a posição final).
`SECURITY INVOKER`: a RLS de `blinds` vale para quem chama.

**Backend.** `PUT /tournament-days/{id}/blinds/order` com `{ "ids": [...] }`
(`routers/blinds.py`). Valida a lista (400 `ordem_incompleta`), não faz nada
se a ordem é a mesma, e **com o dia em andamento trava os níveis até o
atual** (409 `reordenar_nivel_em_andamento`, com `nivel_atual`): o relógio
deriva o nível atual da soma das durações na ordem, então mexer no que já
passou (ou no atual) mudaria o passado do cronômetro. "Em andamento" =
`timer_started_at` preenchido ou `elapsed_time > 0`; o nível atual é
calculado como no relógio enriquecido (`_calculate_current_level`), não
lido da coluna `current_level` (que pode estar atrasada). Devolve a lista
renumerada.

**Tela.** O arrasto manda a ordem inteira numa chamada; a lista renumera na
hora e, na resposta, vira a verdade do servidor (falhou → recarrega). O
nível atual vem de `useTimerSync(dayId, blinds)` — o mesmo relógio do
controle e do telão (poll + Realtime):

- linha do nível atual: `.current-row` (verde, `aria-current="true"`) com o
  selo "Agora · MM:SS" (tempo que falta, contando);
- linhas que já passaram: `.past-row` (apagadas);
- resumo abaixo da tabela: "Nível atual: Nível N · MM:SS" (ou "Intervalo");
- com o dia em andamento, as linhas até a atual não arrastam
  (`draggable=false`, alça `.drag-handle--locked`) e soltar em cima delas
  avisa (`blinds.reorderLockedWhileRunning`), sem chamar o servidor.
- Nada é sinalizado antes de o relógio ser acionado, nem em dia encerrado.

Chaves novas (pt/en/es): `blinds.currentBadge`, `blinds.currentLevelStat`,
`blinds.reorderLockedWhileRunning`.

## Deploy (ordem)

1. `database_migration_reorder_day_blinds.sql` no SQL Editor (só cria a
   função; o backend antigo não a chama).
2. Backend (rota nova).
3. Frontend. Sem o passo 1, arrastar volta a dar erro (500 do RPC).

## Testes

- `backend/tests/test_router_blinds.py::TestReordenacao` — grava via RPC,
  intervalo se move, mesma ordem não toca no banco, lista incompleta/repetida
  → 400, dia em andamento (pausado com tempo corrido ou rodando) → 409 até o
  nível atual e 200 depois dele, 404/422/500.
- `frontend/src/pages/BlindManagement.test.js` — "reordenar arrastando" e
  "nível atual".
