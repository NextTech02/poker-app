from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.config import get_settings
from app.routers import tournaments, transactions, reports, dashboard, players, tournament_players, stages, tables, allocations, rankings, cash_register, blinds

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
app.include_router(blinds.router)
app.include_router(tables.router)
app.include_router(allocations.router)
app.include_router(rankings.router)
app.include_router(players.router)
app.include_router(tournament_players.router)
app.include_router(transactions.router)
app.include_router(reports.router)
app.include_router(dashboard.router)
app.include_router(cash_register.router)


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
