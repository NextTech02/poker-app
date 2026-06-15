# Quick Start Guide - Torneios Poker

Este guia vai te ajudar a configurar e executar a aplicação rapidamente.

## Pré-requisitos

- Node.js 16+ e npm
- Python 3.9+
- Conta Supabase (gratuita)

## Passo 1: Configurar Supabase

### 1.1 Criar Projeto
1. Acesse [supabase.com](https://supabase.com)
2. Crie uma conta (se ainda não tiver)
3. Clique em "New Project"
4. Preencha:
   - Nome do projeto: `torneios-poker`
   - Database Password: (crie uma senha forte)
   - Region: escolha a mais próxima de você

### 1.2 Executar Schema SQL
1. No painel do Supabase, vá em **SQL Editor**
2. Clique em "New query"
3. Copie todo o conteúdo do arquivo `database_schema.sql`
4. Cole no editor e clique em "Run"

### 1.3 Obter Credenciais
No painel do Supabase, vá em **Settings > API**

Você precisará de:
- **Project URL**: `https://xxx.supabase.co`
- **anon/public key**: `eyJhbG...` (chave pública)
- **service_role key**: `eyJhbG...` (chave privada - use apenas no backend)

Vá em **Settings > Auth > JWT Settings** para obter:
- **JWT Secret**: será usado no backend para validar tokens

### 1.4 Criar Usuário de Teste
1. Vá em **Authentication > Users**
2. Clique em "Add user" > "Create new user"
3. Preencha email e senha
4. Este será seu usuário de login

## Passo 2: Configurar Backend

```bash
# Navegar para o backend
cd backend

# Criar ambiente virtual Python
python -m venv venv

# Ativar ambiente virtual
# Windows:
venv\Scripts\activate
# Linux/Mac:
source venv/bin/activate

# Instalar dependências
pip install -r requirements.txt

# Copiar arquivo de ambiente
cp .env.example .env
```

Edite o arquivo `.env` com suas credenciais:

```env
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=eyJhbG... (service_role key)
SUPABASE_JWT_SECRET=xxx (JWT Secret)
FRONTEND_URL=http://localhost:3000
ENVIRONMENT=development
```

```bash
# Iniciar servidor
uvicorn app.main:app --reload
```

✅ Backend rodando em: `http://localhost:8000`
📚 Documentação API: `http://localhost:8000/docs`

## Passo 3: Configurar Frontend

Abra um novo terminal:

```bash
# Navegar para o frontend
cd frontend

# Instalar dependências
npm install

# Copiar arquivo de ambiente
cp .env.example .env
```

Edite o arquivo `.env`:

```env
REACT_APP_API_URL=http://localhost:8000
REACT_APP_SUPABASE_URL=https://xxx.supabase.co
REACT_APP_SUPABASE_ANON_KEY=eyJhbG... (anon/public key)
```

```bash
# Iniciar aplicação
npm start
```

✅ Frontend rodando em: `http://localhost:3000`

## Passo 4: Fazer Login

1. Abra o navegador em `http://localhost:3000`
2. Use o email e senha do usuário criado no Supabase
3. Você será redirecionado para o Dashboard

## Estrutura da Aplicação

### 🏠 Dashboard
- Visão geral com estatísticas
- Torneios ativos, jogadores, receita

### 🎰 Torneios
- Criar novo torneio
- Configurar buy-in, estrutura
- Gerenciar status

### 💰 Caixa
- Registrar buy-ins
- Registrar rebuys
- Registrar add-ons
- Ver histórico de transações

### 📈 Relatórios
- Filtrar por período
- Ver estatísticas gerais
- Relatório por jogador
- Top 5 jogadores
- KPIs de engajamento

## Atalhos Úteis

### Iniciar Tudo de Uma Vez

**Windows:**
```bash
start_dev.bat
```

**Linux/Mac:**
```bash
chmod +x start_dev.sh
./start_dev.sh
```

### Parar Servidores
Pressione `Ctrl+C` no terminal

### Ver Logs
- Backend: No terminal onde executou `uvicorn`
- Frontend: No terminal onde executou `npm start`

## Troubleshooting

### Backend não inicia
- Verifique se o ambiente virtual está ativado
- Confirme que todas as dependências foram instaladas
- Verifique o arquivo `.env`

### Frontend não conecta ao backend
- Confirme que o backend está rodando em `http://localhost:8000`
- Verifique CORS no backend (deve permitir `http://localhost:3000`)
- Verifique a variável `REACT_APP_API_URL` no `.env` do frontend

### Erro de autenticação
- Verifique se o JWT Secret está correto no backend
- Confirme que as chaves do Supabase estão corretas
- Tente criar um novo usuário no Supabase

### Erro ao criar torneio
- Verifique se você está autenticado
- Confirme que o schema SQL foi executado corretamente
- Verifique as policies RLS no Supabase

## Próximos Passos

1. **Explorar a aplicação**: Crie alguns torneios de teste
2. **Adicionar transações**: Registre buy-ins e rebuys
3. **Ver relatórios**: Analise as estatísticas
4. **Personalizar**: Modifique cores, adicione funcionalidades

## Recursos Adicionais

- **API Docs**: `http://localhost:8000/docs` (Swagger UI interativo)
- **Supabase Dashboard**: Gerencie dados, usuários, políticas
- **README.md**: Documentação completa do projeto

## Suporte

Se encontrar problemas:
1. Verifique os logs no terminal
2. Consulte a documentação do Supabase
3. Revise o arquivo `CLAUDE.md` para orientações
4. Use os agentes especializados (`/frontend`, `/backend`, etc.)

Boa sorte com seu sistema de torneios de poker! 🎰♠️♥️♣️♦️
