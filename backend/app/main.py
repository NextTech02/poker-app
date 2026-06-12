from fastapi import FastAPI, Request, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import httpx
from app.config import get_settings
from app.auth.permissions import forbid_permission
from app.routers import tournaments, tournament_days, transactions, reports, dashboard, players, tournament_players, stages, tables, allocations, rankings, cash_register, blinds, prize_allocations, blind_templates, sponsors, player_credits, satellite_tickets, staff, cashboxes, chip_consignments

# Defense-in-depth: block sangi-only users from financial/admin routers at the
# API level (the frontend already hides these screens). Non-sangi roles and
# super-admins are unaffected (forbid_permission only blocks users whose sole
# permission is 'sangi').
_no_sangi = [Depends(forbid_permission("sangi"))]

settings = get_settings()

app = FastAPI(
    title="Torneios Poker API",
    description="API para gerenciamento de torneios de poker",
    version="2.0.0"
)

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_url, "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(stages.router)
app.include_router(tournaments.router)
app.include_router(tournament_days.router)
app.include_router(blinds.router)
app.include_router(blind_templates.router)
app.include_router(tables.router)
app.include_router(allocations.router)
app.include_router(rankings.router)
app.include_router(players.router)
app.include_router(tournament_players.router)
app.include_router(transactions.router, dependencies=_no_sangi)
app.include_router(reports.router, dependencies=_no_sangi)
app.include_router(dashboard.router, dependencies=_no_sangi)
app.include_router(cash_register.router, dependencies=_no_sangi)
app.include_router(prize_allocations.router, dependencies=_no_sangi)
app.include_router(sponsors.router, dependencies=_no_sangi)
app.include_router(player_credits.router, dependencies=_no_sangi)
app.include_router(satellite_tickets.router, dependencies=_no_sangi)
app.include_router(staff.router)
app.include_router(cashboxes.router, dependencies=_no_sangi)
app.include_router(chip_consignments.router)


@app.exception_handler(httpx.LocalProtocolError)
@app.exception_handler(httpx.RemoteProtocolError)
@app.exception_handler(httpx.ConnectError)
@app.exception_handler(httpx.TimeoutException)
@app.exception_handler(httpx.PoolTimeout)
@app.exception_handler(httpx.WriteError)
@app.exception_handler(httpx.ReadError)
@app.exception_handler(httpx.NetworkError)
async def supabase_connection_error_handler(request: Request, exc: Exception):
    return JSONResponse(
        status_code=503,
        content={"detail": "Database connection error. Please retry in a moment."},
    )


@app.get("/")
def root():
    return {
        "message": "Torneios Poker API",
        "version": "2.0.0",
        "docs": "/docs"
    }


@app.get("/health")
def health_check():
    return {"status": "healthy"}
