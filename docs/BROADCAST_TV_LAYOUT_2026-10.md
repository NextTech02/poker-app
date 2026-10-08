# Telão (transmissão) — layout novo + biblioteca de fundos (out/2026)

## O que mudou

**Layout.** A tela pública de blinds (`/tv/<código>` → `/broadcast/:dayId`) foi
redesenhada seguindo o mockup do cliente: cabeçalho com título entre filetes e
marca do clube à direita; coluna de 7 tiles (nível, jogadores, entradas,
reentradas, intervalo em, chip count, média); relógio gigante dentro de um anel
de progresso do nível; "Ante" + `100/200 (200)`; pílula com o próximo nível; e
barra de prêmios no rodapé (prize pool + `1º Lugar : S/ 15,000.00` …). Dourado
sobre marinho por padrão.

**Um componente só.** A TV (`pages/TournamentBroadcast.js`) e a prévia das
Configurações (`pages/BroadcastSettings.js`) renderizam o MESMO
`components/broadcast/TvScreen` dentro de `TvStage`. Antes a prévia era uma
cópia inline que ficava para trás a cada mudança.

**Palco escalado que cobre a tela.** `TvStage` desenha um palco de 1920×1080
*ou maior* e aplica `transform: scale(min(W/1920, H/1080))` — o mesmo CSS
serve 720p, 1080p, 4K e a prévia de 1200 px, sem media query. A dimensão que a
escala não preenche é esticada (tela 1850×926 → palco 2158×1080; 1600×1080 →
1920×1296): o conteúdo encosta nas bordas da tela de verdade. Antes o palco
era fixo e, numa janela que não é 16:9, sobravam ~100 px vazios de cada lado
com os tiles longe do canto. A prévia (`fit="width"`) continua 1920×1080.

## Ajustes do cliente (2026-10-08, 2ª rodada)

- **Tiles encostados na borda esquerda e relógio no centro da TELA.** Padding
  da tela caiu para 26 px laterais; a grade do corpo é `440px | 1fr | 440px`
  (coluna da direita vazia, do tamanho da esquerda) — com a coluna de prêmios
  lateral ela é o contrapeso. Barra de prêmios de borda a borda, com borda
  dourada translúcida (`--tv-accent-soft`) e selo "PRÊMIOS" em dourado sobre
  escuro, como no mockup.
- **Todo tile ligado aparece SEMPRE, mesmo em zero** ("Entradas 0",
  "Reentradas 0"). Era o bug relatado: o cliente ligou as reentradas e não as
  via porque ainda não havia recompra. "Nível" é o único tile de linha única
  (`tv-tile--inline`). Intervalo em / chip count / média continuam sumindo
  quando não há valor (sem intervalo na estrutura, sem fichas).
- **Reentradas nasce ligada** (`database_migration_broadcast_show_reentries_default_on.sql`:
  DEFAULT true + dias existentes com `false` viram `true`, já que o
  interruptor nunca esteve no ar em produção). Frontend lê `!== false`,
  backend `default=True`.
- **Botões +/− de fonte invisíveis.** Nada aparece no telão nem ao mexer o
  mouse (antes: 3 s a cada movimento, e saíam em toda captura). Continuam no
  DOM: cursor parado no cantinho inferior esquerdo ou foco de teclado os
  revela. O caminho normal é o slider das Configurações.
- **Fonte grande não transborda.** Onde há container queries (Chrome 105+),
  cada tile reparte a coluna com os irmãos (teto 100 px × fonte) e os textos
  são `cqh` da própria altura; o anel mede 740 px × fonte, limitado ao
  centro, e relógio/blinds/pílula são `cqh` do anel. Um dia com fonte 160%
  e sete tiles fica inteiro na tela. Título e nome do clube têm teto em px.
  Sem suporte, valem os px simples (comportamento anterior).
- Cor padrão do próximo nível na pílula passou a ser o dourado
  (`broadcast_next_value_color`), como no mockup.

**Biblioteca de fundos.** Bucket público `broadcast-backgrounds` + tabela
`broadcast_backgrounds` (por organização). O clube sobe as imagens uma vez e
escolhe uma por dia (fundo principal e fundo do intervalo). A coluna
`tournament_days.broadcast_bg_image_url` passa a guardar:

| valor | significado |
|---|---|
| `preset:navy` / `graphite` / `felt` / `aceblind` | gradiente pronto (`tvBackgrounds.js`) |
| `https://…/storage/v1/object/public/broadcast-backgrounds/{org}/{uuid}.webp` | imagem da biblioteca |
| `https://…` qualquer | URL colada |
| `data:…` | imagem antiga em base64 (continua valendo) |
| vazio | cor sólida escolhida, ou o gradiente marinho se a cor ainda for a padrão |

Nova coluna `tournament_days.broadcast_bg_overlay` (0–90, default 45): camada
escura sobre a IMAGEM para o texto continuar legível (não afeta preset/cor).
A imagem é reduzida no navegador para 1920 px (WebP, `utils/imageDownscale.js`)
antes de subir.

**Rota pública de extras.** `GET /public/tv/days/{day_id}/extras` (sem login,
`supabase_admin`) devolve `organization_name`, `currency`, `prize_pool` e a
lista de prêmios VISÍVEIS. Era um buraco: os endpoints de premiação exigem
login e a TV do salão não tem — os prêmios nunca apareciam; e a moeda era lida
de `app_settings` sem filtro (linha de uma org qualquer). A TV faz esse request
junto com o poll de 30 s do dia. A rota `GET /public/broadcast/{tournament_id}/prizes`
(por torneio, só prize pool + faixas) entrou em paralelo pelo PR #13 e continua
existindo; o telão novo usa a de extras.

**Numeração de nível.** O intervalo não conta como nível no número mostrado
(`utils/nivelExibido.js`, PR #14): `tvModel` usa `display_level` do servidor
e, sem ele, conta na estrutura em cache.

**Cores: NULL = padrão do app.** Os campos `broadcast_*_color` viraram
`Optional` no backend, as colunas perderam o DEFAULT e os valores iguais aos
padrões históricos (`#d4af37`, `#5b5be8`, …) voltaram a NULL. Cor escolhida à
mão é preservada. Padrões em `components/broadcast/tvDefaults.js`.

Também corrigido: `broadcast_show_reentries` faltava nos modelos do backend
(o PATCH descartava e o GET nunca devolvia).

## Arquivos

- `frontend/src/components/broadcast/` — `TvStage`, `TvScreen` (+ CSS),
  `tvModel` (modelo + settings), `tvDefaults`, `tvBackgrounds`,
  `tvSampleData`, `BackgroundGallery` (+ CSS).
- `frontend/src/hooks/useBroadcastBackgrounds.js`, `utils/imageDownscale.js`,
  `utils/orgFromToken.js`.
- `backend/app/routers/public_tv.py`, `services/public_tv_service.py`,
  `models/public_tv.py`, `models/tournament_day.py`,
  `routers/organizations.py` (limpeza do Storage ao excluir a organização).
- `db/migrations/database_migration_broadcast_backgrounds.sql`
- `db/migrations/database_migration_broadcast_gold_defaults.sql`
- `db/migrations/database_migration_broadcast_show_reentries_default_on.sql`

## Ordem de deploy (IMPORTANTE)

1. `database_migration_broadcast_backgrounds.sql` (bucket, policies, tabela,
   coluna `broadcast_bg_overlay`) — pode rodar a qualquer hora.
2. Backend (modelos com cor `Optional`, rota pública de extras).
3. `database_migration_broadcast_gold_defaults.sql` — **só depois do backend
   novo no ar**: com o backend antigo, uma cor NULL derruba
   `GET /tournament-days/{id}` (campo `str` obrigatório).
4. Frontend.
5. `database_migration_broadcast_show_reentries_default_on.sql` — a qualquer
   hora (só muda um boolean); sem ela, os dias antigos seguem sem o tile de
   reentradas até alguém ligar nas Configurações.

Depois do passo 3 todos os dias existentes passam a usar o dourado (eles só
tinham o padrão da época gravado, não uma escolha). Quem personalizou cores
continua com as suas.

## Conferir em produção

- Abrir `/tv/<código>` numa aba anônima: prêmios e moeda certos
  (`S/`, `R$`…), nome do clube à direita, sem 401 em `/prizes` no Network.
- Configurações da transmissão → "Imagem de fundo": presets, enviar uma foto
  (vira `.webp` de ~300 KB no bucket), escurecimento; "Imagem de fundo do
  intervalo" idem.
- `select id, public from storage.buckets where id = 'broadcast-backgrounds'`
  → `public = true`; `select policyname, permissive from pg_policies where
  tablename = 'broadcast_backgrounds'` → `org_isolation` permissiva +
  `exige_mfa` restritiva.
