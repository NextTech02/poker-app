# Complete Setup Guide - Torneios Poker V2 🎰

## ✅ What You Have Now

A complete poker tournament management system with:
- **Player Database** - Manage players with name, nickname, email, phone
- **Tournament Management** - Create tournaments with buy-ins, rebuys, add-ons
- **Cashier System** - Register transactions linked to players
- **Comprehensive Reports** - Player statistics, revenue tracking, KPIs
- **Backend API** - FastAPI with full CRUD operations
- **Frontend** - React application with modern UI

---

## 🚀 Complete Setup Instructions

### Step 1: Set Up Supabase (Database)

1. **Go to** [supabase.com](https://supabase.com) and sign in
2. **Create a new project**
   - Project name: `torneios-poker`
   - Database Password: (create a strong password)
   - Region: Choose closest to you
   - Wait for project to finish setting up (~2 minutes)

3. **Run the database migration**
   - Go to **SQL Editor** in left sidebar
   - Click **New query**
   - Open `database_migration_v2.sql` from your project
   - Copy ALL content and paste into SQL Editor
   - Click **Run** (bottom right)
   - You should see: "Migration completed successfully!"

4. **Get your credentials**
   - Go to **Settings** > **API**
   - Copy these values:
     - **Project URL**: `https://xxxxx.supabase.co`
     - **anon public** key: `eyJhbG...` (long string)
     - **service_role** key: `eyJhbG...` (different long string)
   - Go to **Settings** > **Auth** > **JWT Settings**
     - Copy **JWT Secret**

5. **Create a test user**
   - Go to **Authentication** > **Users**
   - Click **Add user** > **Create new user**
   - Email: your email (e.g., `admin@test.com`)
   - Password: create a password
   - This will be your login

### Step 2: Configure Backend

1. **Create environment file**
   ```bash
   cd backend
   ```

2. **Edit `.env` file** (you already have it open!)
   ```env
   SUPABASE_URL=https://xxxxx.supabase.co
   SUPABASE_SERVICE_KEY=eyJhbG... (service_role key)
   SUPABASE_JWT_SECRET=your-jwt-secret
   FRONTEND_URL=http://localhost:3000
   ENVIRONMENT=development
   ```

3. **Dependencies are already installed!** ✅

### Step 3: Configure Frontend

1. **Create frontend environment file**
   ```bash
   cd frontend
   cp .env.example .env
   ```

2. **Edit `frontend/.env`**
   ```env
   REACT_APP_API_URL=http://localhost:8000
   REACT_APP_SUPABASE_URL=https://xxxxx.supabase.co
   REACT_APP_SUPABASE_ANON_KEY=eyJhbG... (anon public key, NOT service_role)
   ```

3. **Install frontend dependencies**
   ```bash
   npm install
   ```

### Step 4: Start Everything

**Terminal 1 - Backend:**
```bash
cd backend
uvicorn app.main:app --reload
```

Expected output:
```
INFO:     Uvicorn running on http://127.0.0.1:8000
INFO:     Application startup complete.
```

**Terminal 2 - Frontend:**
```bash
cd frontend
npm start
```

Expected output:
```
Compiled successfully!
You can now view torneios-app-frontend in the browser.
  Local:            http://localhost:3000
```

---

## 🎉 Using the Application

### 1. Login
- Open browser to `http://localhost:3000`
- Use the email and password you created in Supabase
- Click **Entrar**

### 2. Create Your First Player
- Click **Jogadores** in sidebar (👥 icon)
- Click **➕ Novo Jogador**
- Fill in:
  - Nome: João Silva
  - Apelido: João Ace
  - Email/Phone (optional)
- Click **Cadastrar**
- Create 2-3 more players for testing

### 3. Create a Tournament
- Click **Torneios** in sidebar (🎰 icon)
- Click **➕ Novo Torneio**
- Fill in:
  - Nome: Torneio Teste
  - Buy-in: 100
  - Rebuy: 100 (optional)
  - Add-on: 50 (optional)
  - Máx. Jogadores: 20
  - Fichas Iniciais: 10000
  - Duração: 15 minutes
- Click **Criar Torneio**

### 4. Register Transactions (Caixa)
- Click **Caixa** in sidebar (💰 icon)
- Click **➕ Nova Transação**
- Select:
  - Torneio: Torneio Teste
  - Jogador: (select from dropdown)
  - Tipo: Buy-in
  - Valor: 100
  - Forma de Pagamento: Dinheiro
- Click **Registrar**

Repeat for other players!

### 5. View Reports
- Click **Relatórios** in sidebar (📈 icon)
- Select date range
- See:
  - Total revenue
  - Player statistics
  - Top 5 players
  - KPIs

---

## 🔍 Testing the API

Visit: `http://localhost:8000/docs`

You'll see interactive API documentation where you can:
- Test all endpoints
- See request/response schemas
- Try out player management, tournaments, transactions

---

## 📊 What's Different from V1?

### Old Way (V1):
1. Create tournament
2. Type player name manually (could have typos!)
3. No player history

### New Way (V2):
1. **Create players once** (in Jogadores page)
2. **Select from dropdown** (no typos!)
3. **Track everything**:
   - Which tournaments each player joined
   - Total buy-ins, rebuys, add-ons per player
   - Player performance across all tournaments
   - Detailed financial history

---

## 🆘 Troubleshooting

### Backend won't start
- Check `.env` file has correct Supabase credentials
- Make sure migration was run in Supabase
- Check port 8000 isn't already in use

### Frontend won't connect
- Check `frontend/.env` has correct values
- Make sure backend is running on port 8000
- Check browser console for errors (F12)

### Can't login
- Verify user was created in Supabase Auth
- Check email/password are correct
- Look at browser console for errors

### No players in dropdown
- Go to Jogadores page and create some players first
- Check API docs: `http://localhost:8000/docs` > GET /players
- Verify backend can connect to Supabase

### Transactions fail
- Make sure player is selected (not empty)
- Verify tournament exists
- Check backend logs for errors

---

## 📁 Project Structure

```
torneios_app/
├── backend/                # FastAPI Backend
│   ├── app/
│   │   ├── routers/       # API endpoints
│   │   ├── services/      # Business logic
│   │   ├── models/        # Data models
│   │   ├── auth/          # JWT authentication
│   │   └── main.py        # App entry point
│   └── .env               # Backend config
├── frontend/               # React Frontend
│   ├── src/
│   │   ├── pages/         # Main pages
│   │   ├── components/    # Reusable components
│   │   ├── contexts/      # Auth context
│   │   └── config/        # API & Supabase setup
│   └── .env               # Frontend config
└── database_migration_v2.sql  # Database schema

```

---

## 🎯 Next Steps

1. ✅ Add more players
2. ✅ Create multiple tournaments
3. ✅ Register transactions
4. ✅ Explore reports
5. 📱 Consider adding:
   - Tournament bracket/seating
   - Real-time updates
   - Prize calculation
   - Player rankings

---

## 🎊 You're All Set!

Your complete poker tournament management system is ready to use!

**Quick Links:**
- Frontend: http://localhost:3000
- API Docs: http://localhost:8000/docs
- Supabase Dashboard: https://supabase.com/dashboard

**Need help?** Check:
- `MIGRATION_GUIDE_V2.md` - Migration details
- `CLAUDE.md` - Development guidance
- `/backend`, `/frontend`, `/database` slash commands for specialized help

Happy tournament managing! 🎰♠️♥️♣️♦️
