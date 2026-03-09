from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import httpx
from app.config import get_settings
from app.routers import tournaments, tournament_days, transactions, reports, dashboard, players, tournament_players, stages, tables, allocations, rankings, cash_register, blinds, prize_allocations, blind_templates

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
app.include_router(transactions.router)
app.include_router(reports.router)
app.include_router(dashboard.router)
app.include_router(cash_register.router)
app.include_router(prize_allocations.router)


@app.exception_handler(httpx.RemoteProtocolError)
@app.exception_handler(httpx.ConnectError)
@app.exception_handler(httpx.TimeoutException)
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
