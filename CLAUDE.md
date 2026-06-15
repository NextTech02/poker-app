# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Poker tournament management web application for live tournament operations with real-time player tracking, table assignments, and cashier operations.

**Stack:**
- **Frontend**: React 18 with React Router
- **Backend**: FastAPI (Python 3.x)
- **Database**: Supabase (PostgreSQL)
- **Authentication**: Supabase Auth (JWT)

**Key Feature**: Stage-based encapsulation system that automatically scopes all operations to a selected tournament stage via HTTP headers (see docs/STAGE_ENCAPSULATION.md for details).

## Architecture

### Three-Layer Architecture

**Frontend (React)**
- Pages in `frontend/src/pages/` for each major feature:
  - Core: Dashboard, Torneios, TournamentDashboard (tournament detail view), Players, Login
  - Tournament Management: BlindManagement, Etapas (Stages), EliminacaoJogadores, TournamentRankings
  - Cash Operations: Caixa, CaixaGeral
  - Table Management: ManualAllocation
  - Display: TournamentBroadcast (public view for players)
  - Reports: Relatorios
- Components in `frontend/src/components/` for reusable UI elements (Button, Card, Sidebar, PlayerSelect, SeatTicket, SelectedStageBar)
- Supabase client configured in `frontend/src/config/supabase.js`
- AuthContext in `frontend/src/contexts/` manages user sessions
- StageContext in `frontend/src/contexts/` manages stage-based scoping (auto-adds X-Stage-ID header)
- API client in `frontend/src/config/api.js` with axios interceptors for authentication and stage scoping

**Backend (FastAPI)**
- Entry point: `backend/app/main.py` with CORS configured for frontend
- Routers in `backend/app/routers/` define REST endpoints:
  - Core: tournaments, tournament_days, players, tournament_players
  - Tournament Operations: stages, blinds, tables, allocations, rankings
  - Financial: transactions, cash_register, reports, dashboard
- Services in `backend/app/services/` contain business logic (separate from HTTP layer)
- Models in `backend/app/models/` define Pydantic schemas for validation
- JWT verification in `backend/app/auth/jwt.py` using `verify_token()` and `get_current_user()` dependencies
- Stage scoping via `backend/app/dependencies.py` with `get_stage_id_optional()` dependency
- Supabase Python client in `backend/app/database/` for database operations
- Configuration via `backend/app/config.py` using pydantic-settings

**Database (Supabase)**
- Core tables: `players`, `tournaments`, `tournament_days`, `tournament_players`, `transactions`, `stages`, `rankings`
- Tournament operations: `tables`, `seat_allocations`, `blinds`
- Cash management: `stage_cash_register`, `general_cash_register`, `rake_register`, `sangria_transactions`
- Row Level Security (RLS) policies control data access
- Real-time subscriptions available for live tournament updates
- Migration files in `db/migrations/` with naming: `database_migration_*.sql`
- Postgres MCP server available for direct database queries via `mcp__postgres-torneio__query` tool
- Schema documentation: `db/schema/database_schema.sql` (v1), `db/schema/database_schema_v2.sql` (v2)

### Key Data Flow Patterns

1. **Tournament Creation**: Frontend → FastAPI router → Service layer → Supabase Python client → PostgreSQL
2. **Real-time Updates**: Frontend subscribes to Supabase table changes directly (bypasses backend)
3. **Authentication**: Frontend uses Supabase Auth → Backend validates JWT tokens from Supabase
4. **Stage Scoping**: Frontend StageContext → X-Stage-ID header → Backend dependency injection → Service layer filters data by stage_id

### Stage-Based Encapsulation

The system implements automatic stage scoping for all operations:
- Frontend: `StageContext` manages selected stage and automatically adds `X-Stage-ID` header to all API requests
- Backend: `get_stage_id_optional()` dependency extracts stage ID from header
- All GET requests automatically filter by stage
- All POST requests validate that resources belong to selected stage
- Prevents accidental cross-stage data mixing
- See `docs/STAGE_ENCAPSULATION.md` for complete documentation

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

# Alternative start methods
python -m uvicorn app.main:app --reload

# Run all tests
pytest

# Run tests with coverage report
pytest --cov=app tests/

# Run specific test file
pytest tests/test_tournaments.py

# Run single test
pytest tests/test_tournaments.py::test_create_tournament

# Run tests with verbose output
pytest -v

# Run async tests
pytest -v tests/ --asyncio-mode=auto
```

### Quick Start (Both Servers)
```bash
# Windows:
scripts/start_dev.bat

# Linux/Mac:
./scripts/start_dev.sh
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
- Links to stages via stage_id for tournament grouping

**Tournament Days** (`tournament_days` table)
- Multi-day tournament tracking
- Links to tournaments and stages
- Tracks day-specific information

**Tournament Players** (`tournament_players` table)
- Junction table linking players to tournaments
- Tracks: position, rebuys, addons, total_spent, status (active/eliminated)
- One player can be in multiple tournaments

**Tables & Seating** (`tables`, `seat_allocations`)
- Dynamic table management with balancing logic
- Seat assignments tracked with table_number and seat_number
- Allocation service handles distribution algorithms

**Stages** (`stages` table)
- High-level tournament grouping (e.g., "Medellin Week 1", "Rio Circuit")
- Not to be confused with blind levels
- Acts as organizational container for multiple tournaments
- Enables stage-based scoping across the entire application

**Blinds** (`blinds` table)
- Individual blind levels within tournaments
- Tracks small_blind, big_blind, ante values
- Ordered by level number for progression

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

All business logic is in `backend/app/services/`:

- **allocation_service.py** - Table balancing algorithms and seating distribution
- **table_service.py** - Table CRUD operations
- **tournament_service.py** - Tournament lifecycle and state management
- **tournament_day_service.py** - Multi-day tournament operations
- **player_service.py** - Player CRUD operations
- **tournament_player_service.py** - Player registration, rebuys, addons
- **transaction_service.py** - Financial transaction processing
- **cash_register_service.py** - Sangria operations, rake tracking, cash flow
- **ranking_service.py** - Final rankings and payout calculations
- **stage_service.py** - Stage/circuit management (organizational grouping)
- **dashboard_service.py** - Aggregated statistics and metrics
- **report_service.py** - Financial and tournament reports

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

## Frontend Routes

Implemented routes in `frontend/src/App.js`:

**Active Routes:**
- `/` - Dashboard (main overview)
- `/login` - Authentication
- `/etapas` - Stage management
- `/torneios` - Tournament list
- `/torneios/:id` - Tournament detail dashboard
- `/jogadores` - Player management
- `/caixa` - Stage cash register
- `/caixa-geral` - General cash register
- `/relatorios` - Reports and analytics
- `/eliminacao` - Player elimination tracking
- `/alocacao/:tournamentId` - Manual seat allocation
- `/ranking/:tournamentId` - Tournament rankings
- `/blinds/:tournamentId` - Blind structure management
- `/broadcast/:id` - Public tournament broadcast (no auth)

**Placeholder Routes** (redirect to Dashboard, pending implementation):
- `/periodos`, `/premiacao`, `/sit-and-go`, `/vagas`, `/rankings`, `/financeiro`, `/imprensa`, `/templates`, `/funcionarios`

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
1. Write migration SQL in `db/migrations/`: `database_migration_<description>.sql`
2. Test migration locally first if possible
3. Execute in Supabase SQL Editor
4. Update RLS policies if needed
5. Update backend models in `backend/app/models/` (Pydantic schemas)
6. Update backend services in `backend/app/services/` (business logic)
7. Update backend routers in `backend/app/routers/` (API endpoints)
8. Update frontend services and components
9. Document significant changes in appropriate markdown files

### Adding New Feature
1. Design database schema changes (if needed) and create migration file
2. Define Pydantic models in `backend/app/models/` for request/response schemas
3. Implement service layer logic in `backend/app/services/`
4. Add router endpoints in `backend/app/routers/` with proper dependencies (auth, stage scoping)
5. Create/update frontend components in `frontend/src/components/`
6. Create/update pages in `frontend/src/pages/`
7. Add API calls in `frontend/src/config/api.js` or component files
8. Consider stage scoping: should this feature respect X-Stage-ID header?
9. Add tests for both frontend and backend
10. Update relevant documentation

### Testing Backend Services
- Tests in `backend/tests/` directory
- Test files use pattern: `test_*.py` (e.g., `test_tournaments.py`)
- Mock Supabase client for isolation
- Use `pytest` fixtures for common setup
- Test both success and error cases
- Coverage tracking available via `pytest-cov` package
- Run specific test: `pytest tests/test_tournaments.py::test_specific_function`
- Async tests supported via `pytest-asyncio`

### Database Queries
- Use Postgres MCP tool (`mcp__postgres-torneio__query`) for read-only SQL queries
- Useful for inspecting database state during development
- Example: `SELECT * FROM tournaments WHERE status = 'active'`

### API Documentation & Debugging
- Interactive API docs available at `http://localhost:8000/docs` (Swagger UI)
- Alternative docs at `http://localhost:8000/redoc` (ReDoc)
- Health check endpoint: `http://localhost:8000/health`
- Test stage scoping by adding `X-Stage-ID` header in requests
- Use browser DevTools Network tab to inspect API calls and headers
- Backend logs show stage_id extraction from headers in real-time

## Important Notes

### Database & Architecture
- Backend uses service role key (full database access), frontend uses anon key (RLS-protected)
- Tournament dates stored with timezone (`TIMESTAMP WITH TIME ZONE`)
- Decimal amounts use `DECIMAL(10, 2)` for currency precision
- UUIDs generated with `uuid_generate_v4()` or `gen_random_uuid()` extension
- Real-time features use Supabase subscriptions, not polling

### Application Features
- **Stage Scoping**: All operations automatically scoped to selected stage via X-Stage-ID header
- **Manual Allocation**: Direct seat assignment available in `ManualAllocation.js`
- **Broadcast View**: Public display for players in `TournamentBroadcast.js` (no auth required)
- **Cash Management**: Automatic rake calculation (default 20%)
- **Database Triggers**: Automatically maintain cash register balances
- **Sangria Operations**: Transfer money from stage cash to general cash with rake deduction

### Terminology
- **Stage**: Organizational grouping for tournaments (e.g., "Rio Circuit Week 1"), NOT blind levels
- **Blind**: Individual blind level within a tournament
- **Tournament Day**: Multi-day tournament tracking
- **Sangria**: Cash extraction operation from stage register to general register

## Additional Documentation

Reference these files for specific features:

- **docs/STAGE_ENCAPSULATION.md** - Complete guide to stage-based scoping system
- **docs/SISTEMA_ALOCACAO_README.md** - Table allocation and seating algorithms
- **docs/IMPLEMENTACAO_CAIXA_SANGRIA.md** - Cash register and sangria operations
- **docs/CORRECAO_CAIXA_GERAL.md** - General cash register corrections
- **docs/PLAYER_REGISTRATION_GUIDE.md** - Player registration workflow
- **docs/INTERVAL_FEATURE_GUIDE.md** - Tournament interval/break management
- **docs/BROADCAST_SETUP_INSTRUCTIONS.md** - Public broadcast display setup
- **docs/QUICKSTART.md** - Quick setup guide for new developers
- **docs/TROUBLESHOOTING.md** - Common issues and solutions
- **docs/MIGRATION_GUIDE_V2.md** - Database v1 to v2 migration

## MCP Server Permissions

Pre-authorized tools (no user approval required):
- `mcp__postgres-torneio__query` - Direct database queries (read-only)
- `Bash(curl:*)` - HTTP requests via curl
- `Bash(uvicorn:*)` - Starting the backend server
- `Bash(python -m json.tool:*)` - JSON formatting
- `Bash(python -c:*)` - Python one-liners
- `Bash(python -m uvicorn:*)` - Alternative uvicorn start
- `Bash(npm start:*)` - Starting the frontend server

These permissions are configured in `.claude/settings.local.json`
