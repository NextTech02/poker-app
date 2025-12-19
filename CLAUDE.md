# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Poker tournament management web application for live tournament operations with real-time player tracking, table assignments, and cashier operations.

**Stack:**
- **Frontend**: React 18 with React Router
- **Backend**: FastAPI (Python)
- **Database**: Supabase (PostgreSQL)
- **Authentication**: Supabase Auth (JWT)

## Architecture

### Three-Layer Architecture

**Frontend (React)**
- Pages in `frontend/src/pages/` for each major feature (Dashboard, Torneios, Caixa, Players, etc.)
- Components in `frontend/src/components/` for reusable UI elements
- Supabase client configured in `frontend/src/config/supabase.js`
- AuthContext in `frontend/src/contexts/` manages user sessions
- API calls through axios service layer in `frontend/src/services/`

**Backend (FastAPI)**
- Entry point: `backend/app/main.py` with CORS configured for frontend
- Routers in `backend/app/routers/` define REST endpoints (tournaments, players, transactions, tables, allocations, stages, rankings)
- Services in `backend/app/services/` contain business logic (separate from HTTP layer)
- Models in `backend/app/models/` define Pydantic schemas for validation
- JWT verification in `backend/app/auth/jwt.py` using `verify_token()` and `get_current_user()` dependencies
- Supabase Python client in `backend/app/database/` for database operations

**Database (Supabase)**
- Core tables: `players`, `tournaments`, `tournament_players`, `transactions`, `tables`, `seat_allocations`, `stages`, `rankings`
- Cash management: `stage_cash_register`, `general_cash_register`, `rake_register`, `sangria_transactions`
- Row Level Security (RLS) policies control data access
- Real-time subscriptions available for live tournament updates
- Migration files in root directory with naming: `database_migration_*.sql`
- Postgres MCP server available for direct database queries via `mcp__postgres__query` tool

### Key Data Flow Patterns

1. **Tournament Creation**: Frontend → FastAPI router → Service layer → Supabase Python client → PostgreSQL
2. **Real-time Updates**: Frontend subscribes to Supabase table changes directly (bypasses backend)
3. **Authentication**: Frontend uses Supabase Auth → Backend validates JWT tokens from Supabase

## Development Commands

### Frontend (`frontend/`)
```bash
# Install dependencies
npm install

# Start development server (http://localhost:3000)
npm start

# Build for production
npm run build

# Run tests
npm test

# Lint code
npm run lint
```

### Backend (`backend/`)
```bash
# Create and activate virtual environment
python -m venv venv
# Windows:
venv\Scripts\activate
# Linux/Mac:
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Start development server (http://localhost:8000)
uvicorn app.main:app --reload

# With custom host/port
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

# Run all tests
pytest

# Run tests with coverage report
pytest --cov=app tests/

# Run specific test file
pytest tests/test_tournaments.py

# Run single test
pytest tests/test_tournaments.py::test_create_tournament
```

### Quick Start (Both Servers)
```bash
# Windows:
start_dev.bat

# Linux/Mac:
./start_dev.sh
```

## Domain Model

### Core Entities

**Players** (`players` table)
- Persistent player records with name, email, phone, nickname
- Referenced by `tournament_players` for participation tracking

**Tournaments** (`tournaments` table)
- Configuration: buy_in, rebuy_amount, addon_amount, max_players
- Blind structure: blind_duration, starting_chips
- Status flow: pending → active → completed/cancelled
- Links to auth.users via created_by

**Tournament Players** (`tournament_players` table)
- Junction table linking players to tournaments
- Tracks: position, rebuys, addons, total_spent, status (active/eliminated)
- One player can be in multiple tournaments

**Tables & Seating** (`tables`, `seat_allocations`)
- Dynamic table management with balancing logic
- Seat assignments tracked with table_number and seat_number
- Allocation service handles distribution algorithms

**Stages** (`stages` table)
- Tournament progression tracking (registration, playing, final_table, completed)
- Blind levels with small_blind, big_blind, ante values

**Transactions** (`transactions` table)
- Financial tracking: buy-ins, rebuys, add-ons, payouts
- Links to player_id, tournament_id, and tournament_player_id

**Rankings** (`rankings` table)
- Final standings with position and prize_amount

**Cash Management** (multiple tables)
- `stage_cash_register`: Daily cash per stage (before sangria)
- `general_cash_register`: Accumulated cash from all sangrias (after rake deduction)
- `rake_register`: Total house profit/rake accumulated
- `sangria_transactions`: Historical record of all sangria operations with rake calculations
- Triggers automatically update cash registers when transactions are created
- Default rake percentage: 20%

### Business Logic Locations

- **Table Balancing**: `backend/app/services/allocation_service.py` - handles seating algorithms
- **Tournament State Management**: `backend/app/services/tournament_service.py`
- **Player Registration**: `backend/app/services/tournament_player_service.py` - includes rebuy/addon logic
- **Cashier Operations**: `backend/app/services/transaction_service.py`
- **Cash Management**: `backend/app/services/cash_register_service.py` - sangria operations, rake tracking
- **Rankings/Payouts**: `backend/app/services/ranking_service.py`
- **Stage Management**: `backend/app/services/stage_service.py` - blind levels, stage progression

## Environment Configuration

**Frontend** (`frontend/.env`):
```
REACT_APP_API_URL=http://localhost:8000
REACT_APP_SUPABASE_URL=your_supabase_url
REACT_APP_SUPABASE_ANON_KEY=your_supabase_anon_key
```

**Backend** (`backend/.env`):
```
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_KEY=your_supabase_service_role_key
SUPABASE_JWT_SECRET=your_jwt_secret
FRONTEND_URL=http://localhost:3000
```

## Key Integration Points

### Authentication Flow
1. User logs in via frontend using Supabase Auth (`supabase.auth.signInWithPassword()`)
2. Frontend stores session with JWT token
3. Frontend includes JWT in Authorization header for backend requests
4. Backend validates JWT using `verify_token()` dependency from `backend/app/auth/jwt.py`
5. Protected endpoints use `Depends(get_current_user)` to require authentication

### Database Access Patterns
- Frontend: Direct Supabase client for reads and real-time subscriptions (respects RLS)
- Backend: Supabase Python client with service role key (bypasses RLS) in service layer

### CORS Configuration
- Backend allows origins: configured `frontend_url` from settings + `http://localhost:3000`
- Configured in `backend/app/main.py` via `CORSMiddleware`

## Specialized Development Agents

Use these slash commands to activate specialized modes:

- **/architect** - System design, planning, architectural decisions
- **/devops** - Deployment, CI/CD, environment configuration, monitoring
- **/database** - Schema design, migrations, RLS policies, Supabase operations
- **/backend** - FastAPI development (endpoints, services, business logic)
- **/frontend** - React development (UI components, pages, Supabase client integration)
- **/testing** - Unit tests, integration tests, test coverage

Each command loads specialized context and best practices for that domain.

## Development Workflow

### Database Changes
1. Write migration SQL in root directory: `database_migration_<description>.sql`
2. Execute in Supabase SQL Editor
3. Update RLS policies if needed
4. Update backend models/services
5. Update frontend services/components

### Adding New Feature
1. Design database schema changes (if needed)
2. Implement backend service layer logic
3. Add router endpoints with Pydantic models
4. Create/update frontend components and pages
5. Wire up API calls in frontend services
6. Add tests for both frontend and backend

### Testing Backend Services
- Tests in `backend/tests/`
- Mock Supabase client for isolation
- Use `pytest` fixtures for common setup
- Test both success and error cases

### Database Queries
- Use Postgres MCP tool (`mcp__postgres__query`) for read-only SQL queries
- Useful for inspecting database state during development
- Example: `SELECT * FROM tournaments WHERE status = 'active'`

## Important Notes

- Backend uses service role key (full database access), frontend uses anon key (RLS-protected)
- Tournament dates stored with timezone (`TIMESTAMP WITH TIME ZONE`)
- Decimal amounts use `DECIMAL(10, 2)` for currency precision
- UUIDs generated with `uuid_generate_v4()` or `gen_random_uuid()` extension
- Real-time features use Supabase subscriptions, not polling
- Manual seat allocation available in `ManualAllocation.js` page
- Broadcast view for displaying tournament to players in `TournamentBroadcast.js`
- Cash management system includes automatic rake calculation (default 20%)
- Database triggers automatically maintain cash register balances
- Sangria operations transfer money from stage cash to general cash with rake deduction
