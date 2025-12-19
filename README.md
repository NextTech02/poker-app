# Torneios Poker - Sistema de Gerenciamento

Sistema completo para gerenciamento de torneios de poker com funcionalidades de caixa, relatórios e estatísticas.

## Tecnologias

### Frontend
- **React 18** - Framework UI
- **React Router** - Navegação
- **Supabase Client** - Autenticação e real-time
- **Axios** - Cliente HTTP

### Backend
- **FastAPI** - Framework Python
- **Supabase** - Database (PostgreSQL) e Auth
- **Pydantic** - Validação de dados
- **Python-Jose** - JWT tokens

### Database
- **Supabase (PostgreSQL)** - Database principal
- **Row Level Security (RLS)** - Segurança de dados

## Estrutura do Projeto

```
torneios_app/
├── frontend/           # Aplicação React
│   ├── public/
│   └── src/
│       ├── components/ # Componentes reutilizáveis
│       ├── pages/      # Páginas da aplicação
│       ├── contexts/   # React contexts (Auth)
│       ├── services/   # API calls
│       ├── config/     # Configurações
│       └── styles/     # CSS
├── backend/            # API FastAPI
│   └── app/
│       ├── routers/    # Endpoints da API
│       ├── models/     # Modelos Pydantic
│       ├── services/   # Lógica de negócio
│       ├── database/   # Cliente Supabase
│       └── auth/       # Autenticação JWT
└── database_schema.sql # Schema do banco de dados
```

## Configuração

### 1. Configurar Supabase

1. Crie uma conta em [supabase.com](https://supabase.com)
2. Crie um novo projeto
3. Execute o script `database_schema.sql` no SQL Editor do Supabase
4. Copie as credenciais:
   - Project URL
   - Anon/Public Key
   - Service Role Key (backend apenas)
   - JWT Secret

### 2. Frontend Setup

```bash
cd frontend

# Copiar arquivo de ambiente
cp .env.example .env

# Editar .env com suas credenciais Supabase
# REACT_APP_API_URL=http://localhost:8000
# REACT_APP_SUPABASE_URL=sua_url_supabase
# REACT_APP_SUPABASE_ANON_KEY=sua_chave_anonima

# Instalar dependências
npm install

# Iniciar servidor de desenvolvimento
npm start
```

A aplicação estará disponível em `http://localhost:3000`

### 3. Backend Setup

```bash
cd backend

# Criar ambiente virtual
python -m venv venv

# Ativar ambiente virtual
# Windows:
venv\Scripts\activate
# Linux/Mac:
source venv/bin/activate

# Copiar arquivo de ambiente
cp .env.example .env

# Editar .env com suas credenciais Supabase
# SUPABASE_URL=sua_url_supabase
# SUPABASE_SERVICE_KEY=sua_chave_service
# SUPABASE_JWT_SECRET=seu_jwt_secret
# FRONTEND_URL=http://localhost:3000

# Instalar dependências
pip install -r requirements.txt

# Iniciar servidor
uvicorn app.main:app --reload
```

A API estará disponível em `http://localhost:8000`
Documentação interativa: `http://localhost:8000/docs`

## Funcionalidades

### 📊 Dashboard
- Visão geral de torneios ativos
- Estatísticas de jogadores
- Receita total e diária
- Ações rápidas

### 🎰 Torneios
- Criar e gerenciar torneios
- Configurar buy-in, estrutura de blinds
- Acompanhar status (pendente, ativo, concluído)
- Visualizar jogadores registrados

### 💰 Caixa
- Registrar buy-ins, rebuys e add-ons
- Associar transações a torneios
- Visualizar histórico de transações
- Totalizadores por tipo de transação

### 📈 Relatórios
- Filtrar por período (data inicial/final)
- Métricas gerais (receita, torneios, jogadores)
- Relatório por jogador
- Top 5 jogadores por gastos
- KPIs de engajamento
- Taxa de rebuy/add-on

## Autenticação

O sistema usa Supabase Auth para gerenciamento de usuários:

1. Criar conta no Supabase (via Supabase Dashboard)
2. Login via interface
3. Token JWT automaticamente gerenciado
4. Rotas protegidas no backend

## API Endpoints

### Tournaments
- `POST /tournaments` - Criar torneio
- `GET /tournaments` - Listar torneios
- `GET /tournaments/{id}` - Obter torneio
- `PATCH /tournaments/{id}` - Atualizar torneio
- `DELETE /tournaments/{id}` - Deletar torneio

### Transactions
- `POST /transactions` - Criar transação
- `GET /transactions` - Listar transações
- `GET /transactions/tournament/{id}` - Transações por torneio

### Reports
- `GET /reports?start=YYYY-MM-DD&end=YYYY-MM-DD` - Relatórios

### Dashboard
- `GET /dashboard/stats` - Estatísticas do dashboard

## Testes

### Frontend
```bash
cd frontend
npm test
```

### Backend
```bash
cd backend
pytest
```

## Agentes Especializados

Use os comandos slash para ativar modos especializados:

- `/frontend` - Desenvolvimento React
- `/backend` - Desenvolvimento FastAPI
- `/database` - Gerenciamento de schema
- `/testing` - Testes e cobertura
- `/devops` - Deployment e CI/CD
- `/architect` - Arquitetura e design

## Deployment

### Frontend (Vercel/Netlify)
1. Conectar repositório Git
2. Configurar variáveis de ambiente
3. Deploy automático

### Backend (Railway/Heroku)
1. Conectar repositório Git
2. Configurar variáveis de ambiente
3. Comando: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`

## Licença

MIT

## Suporte

Para reportar problemas ou sugerir melhorias, abra uma issue no repositório.
