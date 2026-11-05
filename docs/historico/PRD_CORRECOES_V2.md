# PRD — Correções Pós-Dogfood & Melhorias de UI
## Royal Management · Poker Tournament App

| Campo | Valor |
|-------|-------|
| **Versão** | 2.0 |
| **Data** | 2026-03-10 |
| **Origem** | Sessão de dogfood pós-PRD (dogfood-output-2/report.md) |
| **Status** | Aprovado para implementação |

---

## 1. Contexto

Uma segunda sessão de dogfood realizada após a implementação completa do PRD v1.0 identificou **4 issues remanescentes** e mapeou oportunidades adicionais de refinamento de UI que não eram visíveis nas screenshots anteriores. Este PRD cobre:

- **Eixo A — Bugs funcionais:** issues confirmados via dogfood com evidência de vídeo/screenshot
- **Eixo B — UI/UX residual:** problemas de interface identificados na navegação real
- **Eixo C — Refatoração da página de Relatórios:** página não recebeu atualização no PRD anterior

### Status herdado do PRD v1.0 (não alterar)

Todos os 13 itens do PRD anterior foram confirmados como ✅ funcionando:
`ISSUE-001 (422 Etapas)` · `ISSUE-002 (label sidebar)` · `ISSUE-003 (redirect silencioso)` · `ISSUE-007 (ver detalhes)` · `A1 (toast)` · `A2 (EmptyState)` · `A3 (botões)` · `A5 (cards)` · `A6.4 (breadcrumbs)` · `A9 (header Caixa)` · `B1 (skeletons)` · `B2.2 (ErrorBoundary)` · `i18n sidebar/ComingSoon`

---

## 2. Objetivos

| Objetivo | Métrica de sucesso |
|----------|-------------------|
| Eliminar KPIs zerados no Dashboard | Dashboard exibe valores reais em 100% das visitas |
| Completar i18n residual | 0 strings hardcoded em PT visíveis ao trocar para EN ou ES |
| Exibir status dos torneios nos cards | 100% dos cards mostram badge de status colorido |
| Unificar formatação de moeda | `Intl.NumberFormat('pt-BR')` em todas as páginas |
| Modernizar Relatórios | Página com header padrão, skeleton, i18n e formatação consistente |

---

## 3. Eixo A — Bugs Funcionais

### A1 · Dashboard KPIs Sempre Zerados (503 em /dashboard/stats)

**Severidade:** 🔴 Alta
**Arquivo backend:** `backend/app/services/dashboard_service.py`

**Causa raiz identificada:**
O `DashboardService.get_stats()` executa **5 queries Supabase separadas** por chamada, sem tratamento de erro individual. Quando qualquer query falha (timeout, pool esgotado), o endpoint retorna 503. Além disso, a query de receita total busca **todos os registros da tabela `transactions`** sem paginação — em bases maiores, isso causa timeout.

```python
# Problema atual — 5 queries separadas, sem try/except por query
active_days   = supabase.table("tournament_days").select(...).execute()
active_players = supabase.table("tournament_players").select(...).execute()
all_transactions = supabase.table("transactions").select("amount").execute()  # ← sem limite!
today_transactions = supabase.table("transactions").select("amount").gte(...).execute()
```

**Solução — 3 camadas de correção:**

**Camada 1 — Adicionar try/except por query com fallback gracioso:**
```python
@staticmethod
def get_stats(stage_id: str = None):
    try:
        # queries existentes
        ...
    except Exception as e:
        print(f"[DashboardService] Error: {e}")
        return {
            "activeTournaments": 0,
            "totalPlayers": 0,
            "totalRevenue": 0.0,
            "todayRevenue": 0.0,
        }
```

**Camada 2 — Usar `sum()` no banco em vez de buscar todos os registros:**
```python
# Antes (busca TODOS os registros):
all_transactions = revenue_query.execute()
total_revenue = sum(float(t["amount"]) for t in all_transactions.data)

# Depois (aggregate no banco — uma linha):
# Usar RPC do Supabase ou select com count/sum:
revenue_res = supabase.rpc("sum_transactions", {"p_tournament_ids": tournament_ids}).execute()
total_revenue = revenue_res.data or 0.0
```

Criar a função SQL no Supabase:
```sql
CREATE OR REPLACE FUNCTION sum_transactions(p_tournament_ids uuid[] DEFAULT NULL)
RETURNS numeric AS $$
  SELECT COALESCE(SUM(amount), 0)
  FROM transactions
  WHERE (p_tournament_ids IS NULL OR tournament_id = ANY(p_tournament_ids));
$$ LANGUAGE sql STABLE;
```

**Camada 3 — Adicionar retry no frontend (Dashboard.js):**
```js
// Se falhar, tentar novamente uma vez após 5s antes de mostrar 0
const loadAll = async (isRetry = false) => {
  try {
    const statsRes = await api.get('/dashboard/stats');
    setStats(statsRes.data);
  } catch (err) {
    if (!isRetry) setTimeout(() => loadAll(true), 5000);
    // manter valores anteriores em vez de zerar
  }
};
```

**Critérios de aceite:**
- [ ] Dashboard exibe KPIs reais após login
- [ ] Se `/dashboard/stats` falhar, mantém valores anteriores (não zera)
- [ ] Nenhum erro 503 no console em condições normais de uso

---

### A2 · Status Badges Não Aparecem nos Cards de Torneio

**Severidade:** 🟠 Média
**Arquivo:** `frontend/src/pages/Torneios.js`

**Causa raiz identificada:**
A função `getStatusBadge(t.status)` retorna `null` para todos os torneios porque o campo `status` retornado pela API `/tournaments` provavelmente não está mapeado. O mapa atual usa chaves lowercase (`active`, `pending`, `completed`, `cancelled`), mas a API pode retornar valores diferentes ou nulos.

Adicionalmente, o modelo `Tournament` do backend pode não incluir o campo `status` no `TournamentSummary` usado no endpoint de listagem.

**Diagnóstico necessário:**
```js
// Adicionar temporariamente para confirmar o valor retornado:
console.log('Tournament status values:', tournaments.map(t => t.status));
```

**Solução:**

**Passo 1 — Verificar e incluir `status` no `TournamentSummary` (backend):**
```python
# backend/app/models/tournament.py
class TournamentSummary(BaseModel):
    id: str
    name: str
    has_qualifying: bool
    total_entries: int = 0
    status: Optional[str] = "pending"  # ← garantir que está no schema
    stage_id: Optional[str] = None
    created_at: datetime
```

**Passo 2 — Adicionar fallback no frontend:**
```js
// frontend/src/pages/Torneios.js
const getStatusBadge = (status) => {
  // Normalizar: aceitar variações de casing e valores inesperados
  const normalized = (status || 'pending').toLowerCase();
  const map = {
    active:    { label: t('tournaments.statusActive'),    cls: 'tr-status--active'    },
    pending:   { label: t('tournaments.statusPending'),   cls: 'tr-status--pending'   },
    completed: { label: t('tournaments.statusCompleted'), cls: 'tr-status--done'      },
    cancelled: { label: t('tournaments.statusCancelled'), cls: 'tr-status--cancelled' },
  };
  const s = map[normalized] || map.pending; // fallback para pending
  return <span className={`tr-status-badge ${s.cls}`}>{s.label}</span>;
};
```

**Critérios de aceite:**
- [ ] Todos os cards de torneio exibem um badge de status colorido
- [ ] Badge muda de cor conforme status: verde (Ativo), amarelo (Pendente), cinza (Concluído), vermelho (Cancelado)
- [ ] Badge traduzido em EN e ES

---

### A3 · i18n Parcial — Strings Hardcoded em Cards e Tabelas

**Severidade:** 🟠 Média
**Arquivos:** `frontend/src/pages/Torneios.js`, `frontend/src/pages/Players.js`

**Strings hardcoded identificadas no dogfood (modo EN):**

| Arquivo | Linha / Elemento | String atual | Chave i18n a usar |
|---------|-----------------|--------------|-------------------|
| Torneios.js | Botão Editar (card) | `"Editar"` | `t('common.edit')` |
| Torneios.js | Botão Excluir (card) | `"Excluir"` | `t('common.delete')` |
| Torneios.js | Link Ver detalhes | `"Ver detalhes"` | `t('tournaments.viewDetails')` |
| Torneios.js | Contador `torneios` | `"torneios"` | `t('tournaments.count', {count})` |
| Torneios.js | Contador `entradas` | `"entradas"` | `t('tournaments.entriesPlural')` |
| Players.js | Botão Editar (linha) | `"Editar"` | `t('common.edit')` |
| Players.js | Botão Excluir (linha) | `"Excluir"` | `t('common.delete')` |
| Players.js | Contador `jogador` | `"jogador"` | `t('players.countSingular')` |

**Solução — Torneios.js (card footer):**
```jsx
{/* Antes */}
<button>Editar</button>
<button>Excluir</button>
<Link>Ver detalhes</Link>

{/* Depois */}
<button>{t('common.edit')}</button>
<button>{t('common.delete')}</button>
<Link>{t('tournaments.viewDetails')}</Link>
```

**Solução — Torneios.js (contador):**
```jsx
{/* Antes */}
<span><strong>{tournaments.length}</strong> torneio{tournaments.length !== 1 ? 's' : ''}</span>

{/* Depois — usando chaves de pluralização */}
<span>
  <strong>{tournaments.length}</strong>{' '}
  {tournaments.length === 1 ? t('tournaments.count') : t('tournaments.countPlural')}
</span>
```

**Novas chaves a adicionar em pt-BR.json / en-US.json / es-ES.json:**

```json
// pt-BR
{
  "tournaments": {
    "count": "torneio",
    "countPlural": "torneios"
  },
  "players": {
    "countSingular": "jogador",
    "countPlural": "jogadores"
  }
}

// en-US
{
  "tournaments": {
    "count": "tournament",
    "countPlural": "tournaments"
  },
  "players": {
    "countSingular": "player",
    "countPlural": "players"
  }
}

// es-ES
{
  "tournaments": {
    "count": "torneo",
    "countPlural": "torneos"
  },
  "players": {
    "countSingular": "jugador",
    "countPlural": "jugadores"
  }
}
```

**Critérios de aceite:**
- [ ] Trocar para EN: cards de torneio mostram "Edit", "Delete", "View details"
- [ ] Trocar para EN: contador mostra "3 tournaments", "0 entries"
- [ ] Trocar para EN: tabela de jogadores mostra "Edit", "Delete", "1 player"
- [ ] Trocar para ES: idem com traduções em espanhol

---

### A4 · Formatação de Moeda Inconsistente em Relatórios

**Severidade:** 🟡 Baixa
**Arquivo:** `frontend/src/pages/Relatorios.js`

**Causa raiz:**
`Relatorios.js` usa `toFixed(2)` diretamente, que gera separador de ponto (`R$ 0.00`). O restante do sistema usa `Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })` que gera vírgula (`R$ 0,00`).

**Solução:**
```js
// Adicionar no topo de Relatorios.js (mesmo padrão do Dashboard.js)
const fmt = (n) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n ?? 0);

// Substituir todas as ocorrências de:
// `R$ {valor.toFixed(2)}`  →  `{fmt(valor)}`
```

Ocorrências a substituir em Relatorios.js:
- Linha 94: `R$ {reports.totalRevenue.toFixed(2)}`
- Linha 118: `R$ {reports.avgBuyIn.toFixed(2)}`
- Linha 181: `R$ {parseFloat(player.total_spent).toFixed(2)}`
- Linha 204: `R$ {parseFloat(player.total_spent).toFixed(2)}`
- Linha 228: `R$ {(reports.totalRevenue / ...).toFixed(2)}`

**Critérios de aceite:**
- [ ] Relatórios exibe `R$ 1.200,00` (com vírgula e ponto de milhar) em vez de `R$ 1200.00`
- [ ] Formatação igual à das demais páginas (Dashboard, Caixa)

---

## 4. Eixo B — Refatoração da Página de Relatórios

A página `/relatorios` não foi atualizada no PRD anterior e apresenta vários problemas de design além do currency.

### B1 · Header Padrão em Relatórios

**Problema:** A página usa o antigo padrão `.page-header` sem ícone, sem subtítulo e sem o layout visual das demais páginas.

**Solução:**
```jsx
{/* Substituir o header atual por: */}
<div className="rl-header">
  <div className="rl-header-left">
    <div className="rl-header-icon">
      <svg>/* ícone de gráfico/relatório */</svg>
    </div>
    <div>
      <h1 className="rl-title">{t('reports.title')}</h1>
      <p className="rl-subtitle">{t('reports.subtitle')}</p>
    </div>
  </div>
</div>
```

### B2 · Skeleton Loading em Relatórios

**Problema:** A página exibe `"Carregando relatórios..."` como texto simples durante o carregamento.

**Solução:** Usar `<SkeletonStatCard />` para os 4 KPI cards durante o estado `loading`, igual ao Dashboard e Caixa.

```jsx
{loading ? (
  <>
    <div className="stats-grid">
      <SkeletonStatCard />
      <SkeletonStatCard />
      <SkeletonStatCard />
      <SkeletonStatCard />
    </div>
  </>
) : (
  /* conteúdo atual */
)}
```

### B3 · i18n em Relatórios

**Problema:** Todos os textos da página são hardcoded em português.

**Strings a traduzir:**

| String atual | Chave i18n |
|-------------|------------|
| `"Relatórios"` | `t('reports.title')` |
| `"Análise de desempenho e estatísticas"` | `t('reports.subtitle')` |
| `"Período"` | `t('reports.period')` |
| `"Data Inicial"` | `t('reports.from')` |
| `"Data Final"` | `t('reports.to')` |
| `"Métricas Gerais"` | `t('reports.generalMetrics')` |
| `"Receita Total"` | `t('reports.totalRevenue')` |
| `"Total de Torneios"` | `t('reports.totalTournaments')` |
| `"Total de Entradas"` | `t('reports.totalEntries')` |
| `"Ticket Médio"` | `t('reports.avgTicket')` |
| `"Detalhamento de Transações"` | `t('reports.transactionBreakdown')` |
| `"Total Buy-ins"` | `t('cashRegister.totalBuyIns')` |
| `"Total Rebuys"` | `t('cashRegister.totalRebuys')` |
| `"Total Add-ons"` | `t('cashRegister.totalAddons')` |
| `"Taxa de Rebuy/Add-on"` | `t('reports.rebuyRate')` |
| `"Relatório de Jogadores"` | `t('reports.playerReport')` |
| `"Top 5 Jogadores por Gastos"` | `t('reports.top5Players')` |
| `"Métricas de Engajamento"` | `t('reports.engagementMetrics')` |
| `"Média de Entradas por Jogador"` | `t('reports.avgEntriesPerPlayer')` |
| `"Jogadores Únicos"` | `t('reports.uniquePlayers')` |
| `"Receita por Torneio"` | `t('reports.revenuePerTournament')` |
| `"Jogadores por Torneio"` | `t('reports.playersPerTournament')` |

**Novas chaves a adicionar nos 3 locales:**

```json
// pt-BR additions
"reports": {
  ...
  "generalMetrics": "Métricas Gerais",
  "totalTournaments": "Total de Torneios",
  "totalEntries": "Total de Entradas",
  "avgTicket": "Ticket Médio",
  "transactionBreakdown": "Detalhamento de Transações",
  "rebuyRate": "Taxa de Rebuy/Add-on",
  "top5Players": "Top 5 Jogadores por Gastos",
  "engagementMetrics": "Métricas de Engajamento",
  "avgEntriesPerPlayer": "Média de Entradas por Jogador",
  "uniquePlayers": "Jogadores Únicos",
  "revenuePerTournament": "Receita por Torneio",
  "playersPerTournament": "Jogadores por Torneio",
  "noPlayerData": "Nenhum dado de jogador disponível para o período selecionado",
  "noDataAvailable": "Sem dados disponíveis",
  "loadingError": "Erro ao carregar relatórios. Verifique a conexão e tente novamente."
}
```

### B4 · Empty State em Relatórios

**Problema:** Relatórios usa `<div className="empty-state">` customizado em vez do componente `<EmptyState>` padronizado no PRD anterior.

**Solução:**
```jsx
{/* Antes */}
<div className="empty-state">
  <p>Nenhum dado de jogador disponível para o período selecionado</p>
</div>

{/* Depois */}
<EmptyState
  icon="📊"
  title={t('reports.noPlayerData')}
  subtitle={t('reports.selectDifferentPeriod', 'Tente selecionar um período diferente.')}
/>
```

### B5 · Tratamento de Erro em Relatórios

**Problema:** O `catch` do `loadReports` apenas faz `console.error` — sem feedback visual ao usuário.

**Solução:**
```js
const loadReports = async () => {
  try {
    const response = await api.get('/reports', { params: dateRange });
    setReports(response.data);
  } catch (error) {
    const msg = error.userMessage || 'Erro ao carregar relatórios';
    toast.error(msg);
  } finally {
    setLoading(false);
  }
};
```

---

## 5. Priorização e Roadmap

### Sprint 1 — Bugs Críticos (meta: dashboard funcional + badges visíveis)

| Item | Esforço | Impacto |
|------|---------|---------|
| A1 · Fix backend `dashboard_service.py` (try/except + RPC sum) | M | 🔴 Alta |
| A1 · Fix frontend retry logic em Dashboard.js | S | 🔴 Alta |
| A2 · Incluir `status` no `TournamentSummary` (backend model) | S | 🟠 Média |
| A2 · Normalizar `getStatusBadge` com fallback (frontend) | S | 🟠 Média |

### Sprint 2 — i18n + Formatação (meta: 100% traduzível)

| Item | Esforço | Impacto |
|------|---------|---------|
| A3 · Traduzir strings hardcoded em Torneios.js | S | 🟠 Média |
| A3 · Traduzir strings hardcoded em Players.js | S | 🟠 Média |
| A3 · Adicionar chaves de pluralização nos 3 locales | S | 🟠 Média |
| A4 · Substituir `toFixed(2)` por `fmt()` em Relatorios.js | XS | 🟡 Baixa |

### Sprint 3 — Refatoração de Relatórios (meta: consistência visual total)

| Item | Esforço | Impacto |
|------|---------|---------|
| B1 · Header padrão em Relatórios | S | 🟡 Baixa |
| B2 · Skeleton loading em Relatórios | S | 🟡 Baixa |
| B3 · i18n completo em Relatórios + novos locales | M | 🟠 Média |
| B4 · EmptyState padronizado em Relatórios | XS | 🟡 Baixa |
| B5 · Tratamento de erro com toast em Relatórios | XS | 🟡 Baixa |

---

## 6. Critérios de Aceite Globais

### Dashboard (A1)
- [ ] KPIs exibem valores reais em condições normais de operação
- [ ] Em caso de falha, UI mantém últimos valores conhecidos (não zera)
- [ ] Nenhum erro 503 recorrente no console

### Torneios (A2 + A3)
- [ ] Badge de status visível em 100% dos cards
- [ ] Badge usa cores semânticas (verde/amarelo/cinza/vermelho)
- [ ] Todos os textos traduzidos em EN e ES

### Jogadores (A3)
- [ ] Botões "Edit"/"Delete" em EN, "Editar"/"Excluir" em PT
- [ ] Contador "1 player" em EN, "1 jogador" em PT

### Relatórios (A4 + B1–B5)
- [ ] Valores monetários com formato `R$ 1.200,00` (não `R$ 1200.00`)
- [ ] Header com ícone + título + subtítulo igual às demais páginas
- [ ] Skeleton durante carregamento
- [ ] Erro de API exibido como toast
- [ ] Todos os textos traduzíveis em EN e ES
- [ ] EmptyState padronizado quando sem dados

---

## 7. Referências

- Relatório de Dogfood: `dogfood-output-2/report.md`
- Screenshots: `dogfood-output-2/screenshots/`
- Vídeos de repro: `dogfood-output-2/videos/`
- PRD anterior: `PRD_UI_PERFORMANCE.md`
- Arquitetura: `CLAUDE.md`
