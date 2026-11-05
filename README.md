# AceBlind

Sistema de gestão para clubes de poker: torneios, cash game e bar num só lugar,
para vários clubes ao mesmo tempo.

- **Sistema:** [app.aceblind.net](https://app.aceblind.net) · **API:** `api.aceblind.net` · **Site:** [aceblind.net](https://aceblind.net)
- Idiomas: português, espanhol e inglês. Moeda definida por clube.

## O que o sistema faz

**Torneios**
- Etapas (o circuito) com torneios de um ou vários dias, dias classificatórios e fichas de classificados.
- Caixa de vendas: buy-in, recompra (reentrada), add-on e meios de entrada com valor e fichas próprios; pagamento em dinheiro, crédito ou ticket.
- Mesas, alocação e balanceamento; eliminação no modo mesa ou em massa.
- Relógio e estrutura de blinds (com intervalos e modelos), telão público aberto por código, premiação, ranking, KO e mystery bounty, torneio por equipes.
- Tickets de satélite: emissão, transferência e venda, resgate como entrada ou reentrada.

**Cash game**: mesas e assentos, lista de espera, sessões do jogador, rake e jackpot.

**Bar**: turnos, comandas, cardápio e estoque.

**Dinheiro**
- Caixas por operador, caixa geral, sangria com rake.
- Financeiro do clube (despesas e receitas), relatórios exportáveis.
- Fiado (crédito da casa), crédito de patrocinador, consignação de fichas.

**Jogadores**: cadastro, histórico, limite de jogador, fidelidade (pontos, metas, cupons e cashback) e consentimento por link.

**Plataforma**
- Vários clubes, com planos e módulos por clube (torneio, cash, bar).
- Funcionários com grupos de permissão, convites por e-mail e verificação em duas etapas.
- Funciona offline: as vendas ficam numa fila no aparelho e sincronizam quando a rede volta.
- Registro de atividades.

## Arquitetura

```
 navegador (React, app instalável)
   │  login e tempo real ──────────────────────────────┐
   │  todo o resto ─▶ API (FastAPI) ──▶ Supabase ◀─────┘
   │                                    (Postgres + Auth + Storage + Realtime,
   │                                     região São Paulo)
   └─ telão público ─▶ API (rotas públicas, sem login)
```

- **Frontend** (`frontend/`): React 18, Create React App, i18next.
  - Usa o Supabase JS para login, Realtime, Storage e algumas leituras diretas (moeda, meios de pagamento, fundos do telão), sempre protegidas pelo RLS.
- **Backend** (`backend/`): FastAPI em Python 3.11, servido por gunicorn com workers uvicorn.
  - Lê e grava no Supabase **como o usuário logado**: o RLS do banco isola os clubes. A chave de serviço fica para as operações administrativas.
  - Toda operação é recortada pela etapa selecionada (cabeçalho `X-Stage-ID`, ver [docs/STAGE_ENCAPSULATION.md](docs/STAGE_ENCAPSULATION.md)).
- **Banco**: Supabase (Postgres 17) em São Paulo. Gatilhos mantêm os caixas e o prize pool.
- **Landing** (`landing/`): HTML estático do site, com build e container próprios.
- **Produção**: uma VPS em São Paulo com `docker compose`.
  - Containers: `backend` (porta 8000), `frontend` (3002), `landing` (3003) e `cloudflared`.
  - O `cloudflared` publica os três domínios pelo Cloudflare Tunnel, sem porta aberta na VPS.

## Estrutura do repositório

```
backend/          API FastAPI
  app/routers/    rotas, uma por assunto (torneios, caixa, cash_game, bar, ...)
  app/services/   regras de negócio
  app/models/     esquemas Pydantic
  app/database/   cliente Supabase (por usuário), paginação, memória por requisição
  scripts/        rotinas de manutenção e medição (ex.: resumo_perf_log.py)
  tests/          pytest, com um Supabase falso (tests/conftest.py)
frontend/         React
  src/pages/      uma tela por arquivo
  src/components/ componentes compartilhados
  src/contexts/   autenticação, etapa, permissões, módulo, idioma...
  src/offline/    fila de vendas offline (IndexedDB) e sincronização
  src/locales/    pt-BR, es-ES, en-US
landing/          site aceblind.net
db/migrations/    migrações SQL, aplicadas em ordem no Supabase
db/tests/         testes de gatilhos num Postgres descartável
docs/             documentação (índice em docs/README.md)
scripts/          deploy.sh, deploy-landing.sh, start_dev, sonar-scan.sh
docker-compose.yml
```

## Rodando localmente

Pré-requisitos: Python 3.11+, Node 18+ e acesso a um projeto Supabase de desenvolvimento.

**Backend**
```bash
cd backend
python -m venv venv
venv\Scripts\activate          # Linux/Mac: source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env           # e preencha
uvicorn app.main:app --reload  # http://localhost:8000/docs
```

**Frontend**
```bash
cd frontend
npm install
cp .env.example .env           # e preencha
npm start                      # http://localhost:3000
```

Os dois juntos: `scripts/start_dev.bat` (Windows) ou `scripts/start_dev.sh`.

Os `.env.example` explicam cada variável. Nos dois lados, as opcionais podem
ficar vazias em desenvolvimento:
- sem `RESEND_API_KEY`, o link dos e-mails vai para o log;
- sem `HCAPTCHA_SECRET`, o backend pula a verificação do captcha no "esqueci minha senha".

## Testes

```bash
cd backend && pytest     # ~3.000 testes; o banco é falso, nada vai à rede
cd frontend && npm test  # ~3.700 testes (Jest + Testing Library)
```

## Banco de dados

- Toda mudança de esquema é uma migração em `db/migrations/database_migration_<assunto>.sql`.
- A migração é aplicada no Supabase (SQL Editor ou MCP) e fica registrada em `supabase_migrations`.
- Gatilhos que mexem em dinheiro têm teste em `db/tests/`.
- `db/schema/` guarda o esquema das versões 1 e 2. É histórico: o banco de hoje é o resultado das migrações.

## Deploy

Na VPS, dentro do repositório:

```bash
bash scripts/deploy.sh          # git pull + rebuild de backend e frontend + sobe
bash scripts/deploy-landing.sh  # só o site, sem tocar no sistema
```

- **Configuração:** fica em `.env` na raiz da VPS (modelo: [.env.example](.env.example)), mais `backend/.env` e `frontend/.env`. Nada disso é versionado, e o `deploy.sh` faz backup antes do `git pull`.
- **Depois do deploy:** as telas abertas continuam na versão anterior até apertarem F5. Só o telão recarrega sozinho, em até 5 minutos.
- **Medir desempenho:** com `PERF_LOG=true`, o backend registra o tempo e as idas ao banco de cada requisição. `backend/scripts/resumo_perf_log.py` resume por rota.

## Documentação

- [docs/README.md](docs/README.md): índice do que vale hoje e do histórico.
- [CLAUDE.md](CLAUDE.md): orientação para desenvolver com o Claude Code.

## Licença

Software proprietário da NextHUB CO. Todos os direitos reservados.
