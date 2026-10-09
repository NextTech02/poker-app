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

- **Tiles COLADOS na borda esquerda (sem padding lateral) e relógio no centro
  da TELA.** A tela não tem padding horizontal; só o cabeçalho guarda 22 px
  para as marcas. Os tiles perdem a borda e o canto arredondado do lado da
  tela; a coluna de prêmios lateral idem, do lado direito; a barra de prêmios
  vira uma faixa de ponta a ponta (bordas só em cima e embaixo), dourada
  translúcida (`--tv-accent-soft`), com o selo "PRÊMIOS" em dourado sobre
  escuro. A grade do corpo é `440px | 1fr | 440px` (coluna da direita vazia,
  do tamanho da esquerda) — com a coluna de prêmios lateral ela é o contrapeso.
- **Idioma do telão = regra do app.** Escolha explícita da pessoa (bandeiras,
  `aceblind:idiomaEscolhido` neste aparelho) > idioma do CLUBE
  (`app_settings.language`, que agora vem em `language` nos extras públicos —
  a TV do salão não tem login) > idioma em que o app está (`i18n.language`,
  o que vale com o backend antigo sem extras) > pt-BR. A coluna
  `tournament_days.broadcast_language` nunca ganhou tela e ficava em `pt-BR`
  para todo mundo, por isso "o telão não traduzia"; ela deixa de ser lida
  (continua no banco). `utils/broadcastLabels.labelsForLanguage` mapeia
  `pt-BR`/`en-US`/`es-ES` (só a língua importa). A prévia das Configurações
  segue o idioma da tela.
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
- **Divulgação na coluna da direita** (pedido do cliente, 2026-10-08): o
  diretor pode pôr uma peça do clube na coluna que só equilibrava o relógio
  — imagem da biblioteca (mesma galeria dos fundos, sem presets), vídeo
  direto (.mp4/.webm, loop e mudo) ou YouTube (embed loop/mudo). Colunas
  `broadcast_promo_url`, `broadcast_show_promo` (default true) e
  `broadcast_promo_fit` (`contain` | `cover`), só na resposta/update do
  backend (`database_migration_broadcast_promo.sql`). No telão: `TvPromo`
  dentro de `.tv-side` (440 px, colada na borda direita); com a premiação
  na lateral, ela fica abaixo da divulgação na mesma coluna. Não aparece no
  intervalo (que tem o próprio vídeo). `promoKind()` em `tvModel.js` decide
  o elemento pela URL. Configurações: card "Divulgação (coluna da direita)"
  com interruptor, galeria (`idPrefix="promo"`) e ajuste.
- **Faixas de premiação** (pedido do cliente, 2026-10-08): no "Adicionar
  Premiação" a posição aceita uma faixa ("7-9", "20-35"); o backend
  (`POST /tournaments/{id}/prizes/range`, `PrizeRangeCreate`) cria UMA linha
  por colocação numa inserção só (o pagamento continua por jogador, posição a
  posição; qualquer posição já ocupada recusa o lote com `posicoes`). O telão
  agrupa de volta as colocações consecutivas de mesmo prêmio
  (`groupPrizeRanges` em `tvModel.js`) e mostra "7º–9º Lugar : S/ 400"
  (`placeRangeLabel` em `broadcastLabels.js`, nos 3 idiomas), na barra e na
  coluna lateral. Vaga e dinheiro de mesmo valor não se misturam.
- **Meios de entrada abaixo dos blinds** (pedido do cliente, 2026-10-08):
  interruptor "Meios de entrada: quantidade por meio"
  (`broadcast_show_buy_types`, nasce DESLIGADO) mostra uma linha entre o
  corpo e a barra de prêmios com os `buy_types` ATIVOS do torneio e
  **quantas vendas houve por cada um neste dia** ("BUY-IN: 120 · REBUY: 40
  · DOBLE: 10 · ADDON: 55") — não o valor. Vem em `buy_types` nos extras
  públicos (`name`, `count`, `amount`, `category`); a contagem é das
  `transactions` ativas (canceladas fora) dos jogadores do dia, por
  `buy_type_id`, em lotes de 150 jogadores; venda antiga sem meio cai no
  primeiro meio ativo da mesma categoria. É a mesma conta dos tiles
  "Entradas"/"Reentradas", aberta por meio: ligar os meios desmarca os dois
  (e religar um deles desmarca os meios — `alternarVisibilidade` nas
  Configurações), e o telão não desenha os dois tiles enquanto os meios
  estão ligados. Linha própria da grade (`tv-screen--with-buytypes`); o anel
  encolhe pelo container query. Só ao vivo. O tile "Entradas" ganhou
  interruptor próprio (`broadcast_show_entries`, nasce ligado). Migração
  `database_migration_broadcast_buy_types.sql`.
- **Aviso sonoro = contagem dos últimos 10 s** (pedido do cliente,
  2026-10-08): um bipe por segundo de 10 s a 2 s (mais agudo nos 3 últimos) e
  um tom final mais longo em 1 s. Os bipes suaves em 60 s e 30 s saíram
  (ninguém os ouvia no salão; só o do último segundo era percebido). O
  interruptor `broadcast_blind_alerts_enabled` e o silêncio no intervalo
  continuam. `playBeep` tenta `resume()` num AudioContext suspenso.
- **Duplo clique pausa/retoma o relógio** (pedido do cliente, 2026-10-08):
  em qualquer ponto do telão, só LOGADO (o diretor abriu o telão pelo
  "Ver", na mesma sessão) e com dia — a TV anônima do salão ignora. Mesmo
  comando do Controle: `broadcastCommand` + `applyOptimistic` (vira na hora
  em todas as telas) e `POST /tournament-days/{id}/timer/pause|start`, com
  `refetch` para reconciliar. `user-select: none` no palco para o duplo
  clique não selecionar texto.
- **Navegador de TV antigo (regra de CSS).** O telão roda no navegador da
  própria TV (Hisense/VIDAA e afins, Chromium velho, sem `min()`). Na foto
  do cliente (2026-10-08) o título saiu minúsculo e o resto grande. Causa
  exata: `font-size: min(calc(58px * var(--tv-font)), 76px)`. Uma
  declaração com `var()` é SEMPRE válida na leitura e vence a reserva
  anterior; na hora de calcular, o navegador sem `min()` invalida o valor e
  a propriedade vira `unset` (herda 16 px). Por isso "declarar a reserva
  antes" NÃO resolve quando há `var()` na declaração moderna. Regras em
  `TvScreen.css`: (1) nunca `min()`/`max()`/`clamp()` junto com `var()` fora
  de `@supports`; (2) sem `var()` (ex.: `clamp(20px, 2vw, 40px)`), a reserva
  antes funciona; (3) container queries só dentro de
  `@supports (container-type: size)`; (4) `inset` com `top/right/bottom/left`
  antes. O teto do título saiu; no lugar entrou o **tamanho do título em
  separado** (`broadcast_title_size`, 50–300 %, slider "Tamanho do título"
  nas Configurações, `--tv-title`), multiplicado pela fonte geral.
  Migração `database_migration_broadcast_title_size.sql`.
- **Telão se recarrega sozinho depois de um deploy**
  (`hooks/useReloadOnNewBuild.js`): a TV fica dias aberta e só busca dados;
  o código era o de quando a página abriu (o cliente viu o título
  minúsculo horas depois da correção publicada). A cada 5 min (e ao voltar
  a ficar visível) lê `/asset-manifest.json` (sem cache) e compara o
  `main.*.js` com o carregado; mudou → `registration.update()` do service
  worker e `location.reload()`. Só em produção.
- **Formato dos blinds** (pedido do cliente, 2026-10-09): "50,000-100,000
  (100,000)". Separador de milhar no idioma do telão (`numberLocale` em
  `broadcastLabels.js`: pt-BR ponto; en e es vírgula — o `es` segue a
  América Latina, não a Espanha), hífen entre small e big (era "/"), ante
  em span próprio e menor (`.tv-ante` 0.6em, `.tv-next-ante` 0.78em). Vale
  para a linha principal, a pílula "Próximo", o próximo nível no intervalo
  e as fichas (chip count / média). Só no telão; o Controle segue com "/".
- **Sem a palavra "ANTE"/"BLINDS" em cima dos números** (pedido do cliente,
  2026-10-09): o `.tv-blinds-label` saiu do ao vivo; as cores
  `broadcast_blinds_label_color`/`broadcast_ante_label_color` ficam sem
  uso no telão (as Configurações continuam aceitando).
- **Sem nome do clube no canto direito.** O texto automático
  (`organization_name` dos extras) saiu; à esquerda fica só o logo AceBlind
  (`broadcast_show_logo`, o diretor liga/desliga). À direita aparece apenas
  o logo que o diretor enviou (`broadcast_club_logo_url` +
  `broadcast_show_club_logo`); sem ele, a coluna fica vazia mas reservada,
  para o título continuar no centro da tela.

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
- `db/migrations/database_migration_broadcast_promo.sql`
- `db/migrations/database_migration_broadcast_buy_types.sql`

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
