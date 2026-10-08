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

**Palco fixo escalado.** `TvStage` desenha 1920×1080 e aplica
`transform: scale(min(W/1920, H/1080))` — o mesmo CSS serve 720p, 1080p, 4K e a
prévia de 1200 px, sem media query. O fundo cobre o viewport inteiro.

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
junto com o poll de 30 s do dia.

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

## Ordem de deploy (IMPORTANTE)

1. `database_migration_broadcast_backgrounds.sql` (bucket, policies, tabela,
   coluna `broadcast_bg_overlay`) — pode rodar a qualquer hora.
2. Backend (modelos com cor `Optional`, rota pública de extras).
3. `database_migration_broadcast_gold_defaults.sql` — **só depois do backend
   novo no ar**: com o backend antigo, uma cor NULL derruba
   `GET /tournament-days/{id}` (campo `str` obrigatório).
4. Frontend.

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
