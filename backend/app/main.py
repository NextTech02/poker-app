from fastapi import FastAPI, Request, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
import logging
import httpx
from app.config import get_settings
from app.auth.permissions import forbid_permission
from app.database.supabase_client import set_request_jwt, reset_request_jwt

logger = logging.getLogger("uvicorn.error")
from app.routers import tournaments, tournament_days, transactions, reports, dashboard, players, tournament_players, stages, tables, allocations, rankings, cash_register, blinds, prize_allocations, blind_templates, sponsors, player_credits, satellite_tickets, staff, cashboxes, chip_consignments, sync, public_tv, organizations, loyalty

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


class CatchAllExceptionMiddleware(BaseHTTPMiddleware):
    """Last-resort handler for exceptions that aren't caught by a router or a
    registered @app.exception_handler.

    Without this, an unhandled exception is caught by Starlette's
    ServerErrorMiddleware, which sits OUTSIDE the CORS middleware — so the 500
    response carries no `Access-Control-Allow-Origin` header and the browser
    reports it as a generic "Network Error" instead of the real failure.

    By catching here (inside CORS, which must remain the outermost middleware),
    the JSON 500 response travels back out through CORSMiddleware and gets the
    proper CORS headers, so the frontend sees the actual error message.
    """

    async def dispatch(self, request: Request, call_next):
        try:
            return await call_next(request)
        except Exception as exc:  # noqa: BLE001 - intentional catch-all
            logger.exception(
                "Unhandled exception on %s %s", request.method, request.url.path
            )
            return JSONResponse(
                status_code=500,
                content={
                    "detail": f"Internal server error: {type(exc).__name__}: {exc}"
                },
            )


# IMPORTANT: middleware ordering. Starlette applies middleware outermost-first
# in the order they are added LAST-added-is-outermost. CORS must stay the
# OUTERMOST middleware so that responses produced by the catch-all below still
# pass back through it and receive CORS headers. Therefore the catch-all is
# added BEFORE CORS here.
class SupabaseUserContextMiddleware(BaseHTTPMiddleware):
    """Coloca o JWT da request no contexto para as queries rodarem COMO O USUÁRIO.

    É isso que faz o RLS (Fase 3) valer também para o backend: sem este passo,
    tudo rodaria com a service_role, que ignora RLS, e o isolamento entre
    organizações dependeria de acertar o filtro em cada query.

    Não valida o token — quem valida é o `verify_token` das rotas protegidas.
    Um token inválido aqui simplesmente não enxerga nada (o Postgres rejeita).
    Rotas públicas não mandam Authorization e seguem na service_role.
    """

    async def dispatch(self, request: Request, call_next):
        token = None
        auth = request.headers.get("authorization") or ""
        if auth.lower().startswith("bearer "):
            token = auth[7:].strip() or None

        ctx = set_request_jwt(token)
        try:
            return await call_next(request)
        finally:
            reset_request_jwt(ctx)  # nunca vaza o token para a próxima request


app.add_middleware(SupabaseUserContextMiddleware)
app.add_middleware(CatchAllExceptionMiddleware)

# Configure CORS (added last → outermost)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_url, "http://localhost:3000", "http://localhost:3001"],
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
app.include_router(sync.router)
app.include_router(public_tv.router)
app.include_router(organizations.router)
app.include_router(loyalty.router)


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


# Limites de plano (SaaS): as triggers do banco levantam
# "PLANO_LIMITE_*: <mensagem>" quando uma org tenta passar do limite do plano.
# Aqui traduzimos isso num 409 amigável — cobre criar usuário/torneio/mesa/
# cliente num único ponto, sem tocar em cada service. Handlers registrados
# rodam ANTES do CatchAll (são mais internos), então o 500 genérico não engole.
from typing import Optional as _Optional
try:
    from postgrest.exceptions import APIError as _PostgrestAPIError
except Exception:  # pragma: no cover - fallback entre versões do postgrest
    try:
        from postgrest import APIError as _PostgrestAPIError
    except Exception:
        _PostgrestAPIError = None


def _plan_limit_detail(exc) -> _Optional[str]:
    # Preferimos o campo `message` (limpo). str(exc) é o repr do dict do erro e
    # inclui o próprio `message` de novo — por isso fica por último e cortamos
    # qualquer "{...}" que venha grudado.
    for cand in (getattr(exc, "message", None), getattr(exc, "details", None), str(exc)):
        c = str(cand or "")
        if "PLANO_LIMITE_" not in c:
            continue
        frag = c[c.find("PLANO_LIMITE_"):].split("\n")[0]
        # remove o repr do dict, se veio junto (fallback via str(exc))
        for stop in ("  {", " {'", ' {"', "{'", '{"'):
            i = frag.find(stop)
            if i != -1:
                frag = frag[:i]
        # "PLANO_LIMITE_X: mensagem amigável" -> "mensagem amigável"
        friendly = frag.split(":", 1)[1] if ":" in frag else frag
        return friendly.strip().strip("'\"").strip()
    return None


if _PostgrestAPIError is not None:
    @app.exception_handler(_PostgrestAPIError)
    async def plan_limit_exception_handler(request: Request, exc):
        detail = _plan_limit_detail(exc)
        if detail:
            return JSONResponse(status_code=409, content={"detail": detail})
        # Não é limite de plano: mantém o 500 padrão (com CORS via middleware).
        logger.exception("Postgrest error on %s %s", request.method, request.url.path)
        return JSONResponse(
            status_code=500,
            content={"detail": f"Internal server error: {type(exc).__name__}: {exc}"},
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
