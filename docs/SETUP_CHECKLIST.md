# Setup Checklist ✅

Use este checklist para garantir que tudo está configurado corretamente.

## 🎯 Supabase Setup

- [ ] Conta Supabase criada
- [ ] Projeto criado no Supabase
- [ ] Schema SQL executado (`database_schema.sql`)
- [ ] Tabelas criadas:
  - [ ] `tournaments`
  - [ ] `transactions`
- [ ] Indexes criados
- [ ] RLS policies habilitadas
- [ ] Usuário de teste criado
- [ ] Credenciais copiadas:
  - [ ] Project URL
  - [ ] Anon Key
  - [ ] Service Role Key
  - [ ] JWT Secret

## 🔧 Backend Setup

- [ ] Python 3.9+ instalado
- [ ] Navegou para pasta `backend`
- [ ] Ambiente virtual criado (`python -m venv venv`)
- [ ] Ambiente virtual ativado
- [ ] Dependências instaladas (`pip install -r requirements.txt`)
- [ ] Arquivo `.env` criado (copiado de `.env.example`)
- [ ] Variáveis de ambiente configuradas no `.env`:
  - [ ] `SUPABASE_URL`
  - [ ] `SUPABASE_SERVICE_KEY`
  - [ ] `SUPABASE_JWT_SECRET`
  - [ ] `FRONTEND_URL`
- [ ] Servidor iniciado (`uvicorn app.main:app --reload`)
- [ ] Backend acessível em `http://localhost:8000`
- [ ] API Docs acessível em `http://localhost:8000/docs`

## 💻 Frontend Setup

- [ ] Node.js 16+ instalado
- [ ] Navegou para pasta `frontend`
- [ ] Dependências instaladas (`npm install`)
- [ ] Arquivo `.env` criado (copiado de `.env.example`)
- [ ] Variáveis de ambiente configuradas no `.env`:
  - [ ] `REACT_APP_API_URL`
  - [ ] `REACT_APP_SUPABASE_URL`
  - [ ] `REACT_APP_SUPABASE_ANON_KEY`
- [ ] Servidor iniciado (`npm start`)
- [ ] Frontend acessível em `http://localhost:3000`

## 🔐 Autenticação

- [ ] Página de login carrega corretamente
- [ ] Consegue fazer login com usuário criado no Supabase
- [ ] Redirecionado para Dashboard após login
- [ ] Sidebar visível com menu de navegação

## ✨ Funcionalidades

### Torneios
- [ ] Consegue acessar página de Torneios
- [ ] Consegue criar novo torneio
- [ ] Torneio aparece na lista
- [ ] Consegue visualizar detalhes do torneio

### Caixa
- [ ] Consegue acessar página de Caixa
- [ ] Consegue registrar buy-in
- [ ] Consegue registrar rebuy
- [ ] Consegue registrar add-on
- [ ] Transações aparecem na tabela
- [ ] Totais calculados corretamente

### Relatórios
- [ ] Consegue acessar página de Relatórios
- [ ] Consegue filtrar por data
- [ ] Métricas gerais são exibidas
- [ ] Relatório de jogadores funciona
- [ ] Top 5 jogadores exibido
- [ ] KPIs de engajamento calculados

### Dashboard
- [ ] Estatísticas são exibidas
- [ ] Cards de estatísticas mostram dados corretos
- [ ] Ações rápidas funcionam

## 🧪 Testes

### Backend
- [ ] Consegue executar `pytest`
- [ ] Teste de health check passa
- [ ] Teste de root endpoint passa

### Frontend
- [ ] Consegue executar `npm test`
- [ ] Testes básicos passam

## 🚀 Verificação Final

- [ ] Consegue fazer o fluxo completo:
  1. Login
  2. Criar torneio
  3. Registrar buy-in
  4. Ver relatórios
  5. Visualizar dashboard atualizado
- [ ] Logout funciona
- [ ] Login novamente funciona
- [ ] Dados persistem entre sessões

## 📝 Notas

Anote problemas encontrados:

```
[Escreva aqui qualquer problema ou observação]








```

## ✅ Status Final

Data de conclusão: ___/___/______

Tudo funcionando? [ ] Sim [ ] Não

Se marcou "Não", revise os itens não concluídos acima.

---

**Parabéns! 🎉** Se todos os itens foram marcados, seu sistema está pronto para uso!

Próximos passos:
1. Explore todas as funcionalidades
2. Personalize a aplicação conforme necessário
3. Adicione dados reais
4. Configure deployment para produção (quando estiver pronto)
