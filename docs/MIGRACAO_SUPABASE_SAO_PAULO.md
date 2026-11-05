# Migração do Supabase: Oregon → São Paulo

Plano de 2026-11-05. Scripts em `backend/scripts/migracao-supabase/`.

## Por quê

A VPS está em **São Paulo** e o banco (projeto `App Poker`, `kymaaegfoladwojfwxrp`)
em **Oregon (us-west-2)**. Cada consulta atravessa o continente. Medido na VPS:

| | 1ª consulta (abre a conexão) | as seguintes |
|---|---|---|
| VPS (São Paulo) → Oregon | 862 ms | 201–638 ms (mediana ~580) |
| Goiânia → Oregon | 692 ms | 230–310 ms |

Com isso, uma venda (8 consultas) espera de 1,6 s a 3,6 s só de rede, e a TV
pública leva 6 s para montar os extras. Com o banco em São Paulo, a mesma consulta
deve custar poucos milissegundos (conferir no ensaio com `medir_latencia.py`).

Os outros três projetos da organização (NextHub, App Financeiro,
RelatoriosEtapas) já estão em São Paulo. A organização é do plano Pro.

**O Supabase não muda a região de um projeto existente.** O caminho oficial
([Migrating within Supabase](https://supabase.com/docs/guides/platform/migrating-within-supabase))
é criar um projeto novo e copiar tudo. O atalho "Restore to a new project" não
serve, porque mantém a mesma região.

## O que existe hoje (inventário de 2026-11-05)

| Item | No projeto atual | Como vai para o novo |
|---|---|---|
| Banco | 30 MB, 86 tabelas, 137 migrações registradas | dump + restore (`2_dump.sh`, `3_restaurar.sh`) |
| Usuários | 25 (e-mail e senha), 1 com 2FA | vão no dump, **com as senhas** (hash) e o 2FA |
| Hook de login | `public.custom_access_token_hook` (põe a organização no token) | a função vai no dump; **ligar o hook** com `1_config.sh aplicar` |
| Extensões | pg_cron, pgcrypto, uuid-ossp, pg_stat_statements, supabase_vault | **habilitar pg_cron** no painel antes do restore |
| Jobs (pg_cron) | activity-logs-purge, loyalty-birthday-grants, suspend-expired-free-trials | `pos_restore.sql` (gerado do antigo) |
| Realtime | 23 tabelas na publicação | `pos_restore.sql` |
| Storage | `broadcast-backgrounds` (público, 17 arquivos, ~4 MB) e `comprovantes` (privado, vazio) | buckets no dump; regras (6) no `pos_restore.sql`; arquivos com `4_copiar_storage.sh` |
| Links com o endereço antigo | 31 valores em 4 colunas de `tournament_days` (imagens do telão) | reescritos por `3_restaurar.sh` |
| Configuração de Auth/API | URLs, MFA, limites, captcha, `max_rows=1000` | `1_config.sh exportar` / `aplicar`; **secret do hCaptcha à mão** |
| Não usado | Edge Functions, webhooks, segredos do Vault, roles próprios, triggers em `auth.users` | — |

O que muda para quem usa: **todo mundo entra de novo uma vez** (as chaves do
projeto são outras), com a mesma senha de sempre.

## Pré-requisitos (uma vez, na VPS)

1. **Supabase CLI** (o `supabase db dump` roda o pg_dump num container, e o Docker já está na VPS):
   ```bash
   curl -fsSL https://github.com/supabase/cli/releases/latest/download/supabase_linux_amd64.tar.gz \
     | tar -xz -C /usr/local/bin supabase
   supabase --version
   ```
2. **jq**: `apt install -y jq`
3. **Senha do banco do projeto antigo.** Se ninguém souber, redefina em
   Database > Settings. O sistema não usa essa senha, só as chaves da API, então
   redefinir não derruba nada.
4. **Token pessoal** em supabase.com/dashboard/account/tokens. É usado só para
   copiar as configurações; revogue no fim.
5. **Pasta de trabalho FORA do repositório.** O dump tem todos os dados e os
   hashes de senha:
   ```bash
   mkdir -p ~/migracao-supabase && cd ~/migracao-supabase
   SCRIPTS=~/var/www/poker-app/poker-app/backend/scripts/migracao-supabase
   cp $SCRIPTS/variaveis.env.exemplo variaveis.env   # e preencha
   ```
   Todos os comandos abaixo rodam dessa pasta (`bash $SCRIPTS/…`).

## Fase A — Ensaio (sem impacto em produção, 1–2 h)

O sistema continua funcionando normalmente: o projeto antigo só é **lido**.

1. **Criar o projeto de ensaio** `App Poker ENSAIO`.
   - Região South America (São Paulo), Postgres 17, mesmo tamanho de compute do atual.
   - Em Database > Extensions, **habilitar `pg_cron`**.
   - Preencher `NEW_*` no `variaveis.env` com os dados dele.
2. `bash $SCRIPTS/2_dump.sh` copia o antigo para `dump/`.
3. `bash $SCRIPTS/3_restaurar.sh` carrega o dump no ensaio e regrava os links.
4. `bash $SCRIPTS/1_config.sh exportar` e depois `bash $SCRIPTS/1_config.sh aplicar`.
   Em seguida, preencha o secret do hCaptcha no painel (o script avisa onde).
5. `bash $SCRIPTS/4_copiar_storage.sh` copia os arquivos.
6. `bash $SCRIPTS/5_conferir.sh`. No ensaio o sistema continua vendendo, então
   vendas feitas depois do dump aparecem como diferença; tudo o resto tem de bater.
7. **Medir** o ganho de verdade, da VPS:
   ```bash
   set -a; . ./variaveis.env; set +a
   docker compose -f ~/var/www/poker-app/poker-app/docker-compose.yml run --rm -T --no-deps \
     backend python scripts/migracao-supabase/medir_latencia.py "$NEW_URL" "$NEW_SERVICE_KEY"
   ```
8. **Testar o sistema inteiro contra o ensaio**, no computador de
   desenvolvimento, com `frontend/.env` e `backend/.env` apontando para ele:
   - entrar com um admin e com o usuário que tem 2FA, e ver se o clube carrega
     (é o hook funcionando);
   - abrir caixa, vender, cancelar uma venda e conferir o caixa;
   - relógio, telão (`/tv`), mesas e Realtime (duas telas abertas);
   - enviar a logo do clube e um fundo do telão (Storage e regras do bucket);
   - cash e bar, se o clube usar.

   Gravar no ensaio não tem problema: é uma cópia.
9. Anotar o tempo de cada passo e qualquer erro (ver "Problemas conhecidos").
   **Apagar o projeto de ensaio** no fim, porque ele tem os dados reais.

## Fase B — Virada (janela de ~40 min, fora de evento)

**No dia anterior:**
- Combinar o horário com os clubes e avisar que todos vão entrar de novo.
- Criar o projeto definitivo `App Poker` em São Paulo, **vazio**, com `pg_cron`
  habilitado, e trocar os `NEW_*` do `variaveis.env` para ele.
- Na VPS, preparar o `.env.novo`: cópia do `.env` com as variáveis abaixo
  trocadas pelas do projeto novo.
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_KEY` (secret)
  - `REACT_APP_SUPABASE_ANON_KEY` (publishable)
  - `SUPABASE_JWT_SECRET` (Settings > JWT Keys > legacy secret)

  O backend aceita os dois formatos de chave e de token (HS256 e JWKS, ver
  `app/auth/jwt.py` e `app/database/supabase_client.py`).
- Conferir que nenhum aparelho tem **venda offline pendente de sincronizar**.

**Na janela:**

| min | passo |
|---|---|
| 0 | `docker compose stop backend`. Parou: nenhuma venda nova entra no antigo |
| 1 | `bash $SCRIPTS/2_dump.sh` |
| 4 | `bash $SCRIPTS/3_restaurar.sh` |
| 7 | `bash $SCRIPTS/1_config.sh exportar && bash $SCRIPTS/1_config.sh aplicar`, e depois o secret do hCaptcha no painel |
| 11 | `bash $SCRIPTS/4_copiar_storage.sh`. Roda num container avulso da imagem do backend, sem subir a API: o sistema continua parado |
| 13 | `bash $SCRIPTS/5_conferir.sh`, que **tem de dar IGUAIS** |
| 15 | `cp .env .env.oregon && cp .env.novo .env && docker compose build --no-cache frontend backend && docker compose up -d` |
| 25 | Teste rápido: entrar (admin e 2FA), abrir caixa, venda de teste na org Teste, relógio, TV, enviar uma imagem e ver o Realtime. No PERF_LOG, as consultas devem cair para poucos ms |
| 35 | Reabrir e avisar os clubes |

## Volta-atrás

- **Antes de reabrir** (ninguém operou no novo): `cp .env.oregon .env && docker
  compose build --no-cache frontend backend && docker compose up -d`. O projeto
  antigo não foi alterado em nada (só lido).
- **Depois de reabrir**, o que for gravado no novo não existe no antigo, e
  voltar exigiria copiar de volta. Decida em até ~1 h depois da virada.

## Depois da virada

- Manter o projeto de Oregon **7 dias** como garantia; depois pausar e apagar.
  Enquanto os dois existirem, são cerca de US$10/mês a mais.
- Apagar `~/migracao-supabase/dump`, `config-antigo` e `variaveis.env`, e
  **revogar o token pessoal**.
- Trocar o projeto onde ele é citado:
  - `frontend/.env` e `backend/.env` de desenvolvimento;
  - a conexão do MCP `postgres-torneio` em `.claude/`;
  - o id do projeto na memória do Claude Code.
- `SUPER_ADMIN_USER_IDS` não muda: os ids de usuário vêm no dump.

## Problemas conhecidos (do guia oficial)

- `permission denied to grant role "postgres"` no restore: comente em
  `dump/roles.sql` a linha `GRANT "postgres" TO "cli_login_postgres" …` e rode
  de novo. O restore é uma transação só, então a tentativa que falhou não
  deixou nada gravado.
- Erros de permissão com `supabase_admin`: comente em `dump/schema.sql` as
  linhas `ALTER … OWNER TO "supabase_admin"`.
- Sem IPv6 na VPS: use as conexões **Session pooler** (as de exemplo no
  `variaveis.env.exemplo`), não as diretas.
- `1_config.sh aplicar` recusou um campo: a resposta diz qual. Tire-o de
  `config-antigo/auth_para_o_novo.json` e rode de novo. O ensaio existe para
  achar isso antes da virada.
