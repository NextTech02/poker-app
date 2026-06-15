# PRD — Correções do Dogfood QA (Março 2026)

**Origem:** Relatório de dogfood `dogfood-output/report.md`
**Data:** 2026-03-31
**Total de issues:** 8 (1 critical, 2 high, 3 medium, 2 low)
**Status:** 2 já corrigidas (ISSUE-005, ISSUE-008)

---

## 1. Contexto

Um teste de dogfood exploratório foi realizado na aplicação web (localhost:3000) percorrendo as principais telas: Login, Dashboard, Funcionários, Financeiro e Sidebar. Foram identificados 8 problemas de UI, UX e funcionalidade que precisam ser resolvidos para garantir estabilidade antes do próximo deploy.

---

## 2. Escopo

Este PRD cobre exclusivamente as 8 issues encontradas no dogfood. Não inclui novas features nem refatorações fora do escopo dos bugs.

---

## 3. Issues e Requisitos

### 3.1 ISSUE-004 — Navegação para rotas protegidas redireciona para login (CRITICAL)

**Problema:** Ao clicar em "Financeiro" (ou outras rotas protegidas por permissão) no sidebar, o usuário logado é redirecionado para a tela de login ao invés de ver a página. O usuário é admin (sem registro na tabela `staff`) e deveria ter acesso total.

**Causa raiz provável:**
- Race condition entre `AuthContext` e `PermissionContext`: o token Supabase expira silenciosamente e o `user` fica `null` momentaneamente.
- Ou: o endpoint `GET /staff/me/permissions` retorna 500 (tabela não existia), e o interceptor do axios pode estar disparando logout.

**Requisitos de correção:**
1. O `PermissionContext` deve ser resiliente a falhas da API — se `GET /staff/me/permissions` falhar (500, 503, timeout), manter `isAdmin: true` e não bloquear a navegação.
2. O `PrivateRoute` não deve redirecionar para `/login` enquanto houver um token válido em `localStorage` — a ausência temporária do `user` no state do React deve mostrar "Carregando..." e não redirecionar.
3. Adicionar retry automático (1x após 3s) no `PermissionContext` caso a API falhe.
4. Verificar se o interceptor global do axios em `api.js` não está causando efeito colateral de logout em erros 500.

**Critério de aceite:**
- Usuário logado navega para `/financeiro`, `/funcionarios`, `/relatorios` etc. sem ser redirecionado para login.
- Se o endpoint `/staff/me/permissions` estiver fora do ar, o sistema trata como admin.
- Console não mostra erros de permissão para o admin principal.

---

### 3.2 ISSUE-002 — Link "Funcionários" no sidebar não navega (HIGH)

**Problema:** Clicar no link "Funcionários" no sidebar (a partir do Dashboard) não navega para `/funcionarios`. A página permanece no Dashboard. Acessar a URL diretamente funciona.

**Causa raiz provável:**
- O link pode estar sendo interceptado por evento de click no container pai (sidebar group toggle, ou `onClick` no overlay).
- Ou: o filtro de permissões do sidebar pode estar removendo e re-adicionando o item durante re-render, causando o click ser "engolido".

**Requisitos de correção:**
1. Verificar se o `<Link to="/funcionarios">` está sendo renderizado corretamente como âncora clicável.
2. Testar manualmente no browser se o click no link dispara a navegação via React Router.
3. Se o problema for de re-render por permissões, memoizar a lista `menuItems` filtrada para evitar recriação a cada render.
4. Garantir que o `event.stopPropagation()` ou handlers no sidebar não interferem com `<Link>`.

**Critério de aceite:**
- Clicar em "Funcionários" no sidebar navega para `/funcionarios` em todas as situações (desktop e mobile).
- O mesmo deve funcionar para todos os links do sidebar.

---

### 3.3 ISSUE-008 — Redirecionamento silencioso quando sem permissão (HIGH) — CORRIGIDO

**Problema:** Quando um funcionário sem permissão acessa uma rota protegida, é redirecionado silenciosamente para `/` sem nenhum feedback.

**Correção aplicada:** `PrivateRoute` agora mostra um toast `warning` com "Você não tem permissão para acessar esta página." antes de redirecionar.

**Validação pendente:**
- Testar com um usuário staff sem permissão `financial` acessando `/financeiro`.
- Confirmar que o toast aparece e o redirecionamento acontece.

---

### 3.4 ISSUE-001 — Grid de stat cards desbalanceado no Dashboard (MEDIUM)

**Problema:** O Dashboard tem 4 stat cards em um grid de 3 colunas. O 4o card ("Receita Hoje") fica sozinho na 2a linha, deixando 2 espaços vazios visíveis.

**Requisitos de correção (opções):**
- **Opção A:** Mudar o grid para 4 colunas (`grid-template-columns: repeat(4, 1fr)`) para que todos os cards fiquem em uma única linha.
- **Opção B:** Mudar o grid para 2 colunas (`repeat(2, 1fr)`) com 2 linhas de 2 cards.
- **Opção C:** Adicionar mais 2 stat cards relevantes (ex: "Jogadores Ativos Hoje", "Total de Transações") para preencher o grid 3x2.

**Critério de aceite:**
- Não há espaço vazio visível no grid de stats.
- Layout funciona em desktop (>1024px) e mobile (<768px).

---

### 3.5 ISSUE-006 — Erro de API no console ao carregar Dashboard (MEDIUM)

**Problema:** O console mostra `[API Error] Object` ao carregar o Dashboard. Indica que uma requisição ao backend está falhando silenciosamente.

**Requisitos de correção:**
1. Identificar qual endpoint está falhando — provavelmente `GET /dashboard/stats`, `GET /tournaments`, `GET /transactions` ou `GET /staff/me/permissions`.
2. Se for o endpoint de permissões, garantir que o erro é tratado silenciosamente sem poluir o console (o catch no `PermissionContext` já trata, mas o interceptor global do axios loga no console).
3. Se for um endpoint do dashboard, corrigir o backend (tabela faltante, query com erro) ou melhorar o tratamento de erro no frontend.
4. Para erros esperados (ex: tabela ainda não migrada), silenciar o log ou reduzir para `console.warn`.

**Critério de aceite:**
- Console não mostra `[API Error]` em condições normais de operação.
- Erros de endpoints opcionais (como permissões quando a tabela não existe) são silenciados.

---

### 3.6 ISSUE-007 — Badge "HOJE" desalinhada no stat card (MEDIUM)

**Problema:** O badge verde "HOJE" no card "Receita Hoje" no Dashboard aparece levemente desalinhado em relação ao valor monetário.

**Requisitos de correção:**
1. Alinhar verticalmente o badge com o valor usando `align-items: center` no container `.db-stat-value-row`.
2. Ajustar `vertical-align`, `line-height` ou `margin` do badge `.db-stat-badge` para ficar na mesma linha base do valor.
3. Verificar em diferentes resoluções (desktop, tablet, mobile).

**Critério de aceite:**
- O badge "HOJE" fica visualmente alinhado ao centro vertical do valor "R$ X,XX".
- Consistente em todas as resoluções.

---

### 3.7 ISSUE-005 — Título "Funcionários" repetido 3 vezes na página (LOW) — CORRIGIDO

**Problema:** A página Funcionários mostrava o texto "Funcionários" 3 vezes: header h1, tab ativa, e título do Card.

**Correção aplicada:** Removidos os títulos dos Cards (`<Card>` sem prop `title`), mantendo apenas o h1 do page-header e as tabs.

**Validação pendente:**
- Confirmar visualmente que a hierarquia h1 → tabs → conteúdo está clara.

---

### 3.8 ISSUE-003 — Sidebar não destaca rota ativa para Funcionários (LOW)

**Problema:** Ao estar na página `/funcionarios`, o link correspondente no sidebar não aparece highlighted. O "Início" permanece como ativo.

**Causa raiz provável:**
- A função `isPathActive` compara `location.pathname === path || location.pathname.startsWith(path + '/')`, que deveria funcionar para `/funcionarios`.
- O problema pode ser que o sidebar está re-renderizando e o item está sendo recriado (key instável), ou o `location.pathname` não está atualizado no momento do render.

**Requisitos de correção:**
1. Verificar se `isPathActive('/funcionarios')` retorna `true` quando `location.pathname === '/funcionarios'`.
2. Se o sidebar está usando `index` como key nos map items, trocar para `item.path` para estabilidade.
3. Testar com outros links do sidebar para ver se o problema é isolado ou global.

**Critério de aceite:**
- Ao navegar para `/funcionarios`, o item correspondente no sidebar fica highlighted (classe `active`).
- O mesmo funciona para todas as rotas do sidebar.

---

## 4. Priorização

| Prioridade | Issue | Severidade | Status |
|------------|-------|------------|--------|
| P0 | ISSUE-004 | Critical | Corrigido |
| P1 | ISSUE-002 | High | Corrigido |
| P1 | ISSUE-008 | High | Corrigido |
| P2 | ISSUE-006 | Medium | Corrigido |
| P2 | ISSUE-001 | Medium | Corrigido |
| P2 | ISSUE-007 | Medium | Corrigido |
| P3 | ISSUE-005 | Low | Corrigido |
| P3 | ISSUE-003 | Low | Corrigido |

---

## 5. Arquivos Impactados

| Arquivo | Issues |
|---------|--------|
| `frontend/src/App.js` | 004, 008 |
| `frontend/src/contexts/PermissionContext.js` | 004, 006 |
| `frontend/src/contexts/AuthContext.js` | 004 |
| `frontend/src/components/Sidebar.js` | 002, 003 |
| `frontend/src/pages/Dashboard.js` | 001 |
| `frontend/src/pages/Dashboard.css` | 001, 007 |
| `frontend/src/pages/Funcionarios.js` | 005 |
| `frontend/src/config/api.js` | 006 |

---

## 6. Validação

Após as correções:
1. Login com conta admin → navegar para todas as rotas do sidebar → nenhuma deve redirecionar para login.
2. Login com conta staff (sem permissão `financial`) → acessar `/financeiro` → deve mostrar toast e redirecionar para Dashboard.
3. Dashboard: grid de stat cards sem espaços vazios, badge "HOJE" alinhada, console limpo.
4. Sidebar: todos os links navegam corretamente, rota ativa é destacada.
5. Funcionários: sem título duplicado.
