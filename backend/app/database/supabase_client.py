import contextlib
import re
from contextvars import ContextVar, Token
from typing import Optional

from supabase import create_client, Client, ClientOptions
import supabase._sync.client as _supabase_sync_client
from app.config import get_settings
import httpx
from httpx import Limits
from postgrest import SyncPostgrestClient
from postgrest.utils import SyncClient

settings = get_settings()

# supabase-py 2.10.0 valida NO CLIENTE que a chave tenha formato JWT (a.b.c) e
# levanta "Invalid API key" para as chaves novas da Supabase (sb_secret_... /
# sb_publishable_...) antes mesmo de falar com o servidor. O servidor aceita o
# formato novo normalmente (verificado). Subir a lib (2.10 -> 2.31) para ganhar
# essa checagem relaxada quebraria o hardening de sessão abaixo, que depende de
# internals do postgrest — então contornamos apenas essa validação de formato.
_JWT_SHAPE_REGEX_PREFIX = "^[A-Za-z0-9-_=]+"


class _ReAllowingNewKeyFormat:
    """Proxy do módulo `re` que só neutraliza a checagem de formato da chave.

    Substitui o atributo `re` DENTRO do namespace do módulo da lib — nunca o
    módulo `re` global —, então nada mais no processo é afetado.
    """

    def __init__(self, real):
        self._real = real

    def match(self, pattern, string, *args, **kwargs):
        if isinstance(pattern, str) and pattern.startswith(_JWT_SHAPE_REGEX_PREFIX):
            return True  # deixa o servidor decidir se a chave é válida
        return self._real.match(pattern, string, *args, **kwargs)

    def __getattr__(self, name):
        return getattr(self._real, name)


@contextlib.contextmanager
def _allow_new_api_key_format():
    original = _supabase_sync_client.re
    _supabase_sync_client.re = _ReAllowingNewKeyFormat(original)
    try:
        yield
    finally:
        _supabase_sync_client.re = original


def get_supabase() -> Client:
    """Get Supabase client instance.

    The default httpx client that supabase-py/postgrest builds enables HTTP/2 and
    a small connection pool. FastAPI runs our sync `def` endpoints in a threadpool,
    so this single module-level client is hit concurrently from many threads. The
    HTTP/2 stream state machine in httpcore is not safe under that concurrency and
    corrupts (KeyError in http2.py, "WriteError: EOF occurred in violation of
    protocol"), and the tiny pool serializes everything and times out (503s).

    Fix: rebuild postgrest's underlying session over HTTP/1.1 with a larger pool.
    HTTP/1.1 uses one connection per in-flight request from the pool, which is
    robust under thread concurrency; the bigger pool stops the queueing/timeouts.
    """
    options = ClientOptions(
        postgrest_client_timeout=30,
        storage_client_timeout=30,
        schema="public",
    )

    with _allow_new_api_key_format():
        client = create_client(
            settings.supabase_url,
            settings.supabase_service_key,
            options=options,
        )

    # Rebuild the postgrest session with HTTP/1.1 + a real pool, preserving the
    # base_url/headers that supabase-py already configured (service-role apikey,
    # authorization, accept-profile, etc.).
    _harden_postgrest_session(client)
    return client


def _harden_postgrest_session(client: Client) -> None:
    old: SyncClient = client.postgrest.session

    timeout = httpx.Timeout(connect=15.0, read=60.0, write=15.0, pool=30.0)
    limits = Limits(
        max_connections=50,            # was effectively the lib default; 10 was never applied
        max_keepalive_connections=20,
        keepalive_expiry=30.0,
    )

    new_session = SyncClient(
        base_url=old.base_url,
        headers=old.headers,
        timeout=timeout,
        limits=limits,
        http2=False,                   # the actual fix for the thread-safety corruption
        follow_redirects=True,
    )

    try:
        old.close()
    except Exception:
        pass

    client.postgrest.session = new_session


# ─────────────────────────────────────────────────────────────────────────────
# Multi-tenant: executar as queries COMO O USUÁRIO, para o RLS valer
# ─────────────────────────────────────────────────────────────────────────────
# O backend sempre usou a service_role, que IGNORA RLS por definição. Num SaaS
# isso deixa o isolamento entre organizações dependendo de acertar o filtro em
# cada uma das ~385 queries — basta esquecer UMA para vazar dados de outro
# cliente.
#
# Aqui o client passa a assumir o JWT do usuário da request: o Postgres aplica
# as políticas da Fase 3 automaticamente em todas as queries, sem tocar em
# nenhuma delas. O banco vira a última linha de defesa, não o código.
#
# Performance: criar um client por request custaria ~245ms — quase todo ele
# montando o contexto SSL. Reaproveitando o contexto e o TRANSPORTE (que carrega
# o pool de conexões), cai para ~0.1ms e as conexões TCP continuam sendo
# reutilizadas entre requests.
#
# Sem token no contexto (rotas públicas, /sync, startup) => service_role, como
# antes. Para forçar service_role explicitamente, use `supabase_admin`.

_SSL_CONTEXT = httpx.create_ssl_context()
_SHARED_TRANSPORT = httpx.HTTPTransport(
    verify=_SSL_CONTEXT,
    limits=Limits(max_connections=50, max_keepalive_connections=20, keepalive_expiry=30.0),
    http2=False,   # mesma razão do _harden_postgrest_session
    retries=0,
)
_REST_TIMEOUT = httpx.Timeout(connect=15.0, read=60.0, write=15.0, pool=30.0)

# JWT da request atual. ContextVar (não thread-local) porque o FastAPI executa
# endpoints sync num threadpool e o anyio propaga o contexto para a thread.
_request_jwt: ContextVar[Optional[str]] = ContextVar("supabase_request_jwt", default=None)

# Cliente PostgREST JÁ MONTADO desta request.
#
# Antes, `_active()` montava um cliente NOVO a cada `.table()`. Um endpoint com
# seis consultas construía seis SyncClient + seis SyncPostgrestClient e
# descartava todos — por requisição, em todo o sistema. O pool TCP nunca foi o
# problema (o transporte sempre foi compartilhado); o desperdício era CPU e
# alocação, multiplicados pelo número de consultas.
_request_pg: ContextVar[Optional[SyncPostgrestClient]] = ContextVar(
    "supabase_request_pg", default=None
)

# Contador de idas ao banco desta request, para a medição abaixo.
#
# Guarda uma LISTA (objeto mutável), e não um número: o endpoint sync roda numa
# thread do pool, que recebe uma CÓPIA do contexto. Reatribuir um int lá dentro
# não voltaria para quem mede; mutar a lista que os dois apontam, sim.
_request_queries: ContextVar[Optional[list]] = ContextVar(
    "supabase_request_queries", default=None
)


def start_query_counter() -> list:
    """Zera e devolve o contador de consultas da request atual."""
    contador = []
    _request_queries.set(contador)
    return contador


def _conta(alvo: str) -> None:
    contador = _request_queries.get()
    if contador is not None:
        contador.append(alvo)


def set_request_jwt(token: Optional[str]) -> Token:
    """Define o JWT da request atual. Devolve o Token para reset()."""
    # O cliente montado pertence a UM token. Trocar de request sem limpar aqui
    # faria a próxima requisição herdar o PostgREST da anterior — ou seja,
    # consultar como outro usuário. É a limpeza que torna o cache seguro.
    _request_pg.set(None)
    return _request_jwt.set(token)


def reset_request_jwt(token: Token) -> None:
    _request_jwt.reset(token)


def _build_user_postgrest(jwt: str) -> SyncPostgrestClient:
    """PostgREST autenticado como o usuário (RLS aplicado)."""
    session = SyncClient(
        base_url=f"{settings.supabase_url}/rest/v1",
        headers={
            # A apikey identifica o projeto; o Authorization define QUEM é o
            # usuário. É o Authorization que faz o RLS enxergar os claims.
            "apikey": settings.supabase_anon_key or settings.supabase_service_key,
            "Authorization": f"Bearer {jwt}",
        },
        timeout=_REST_TIMEOUT,
        transport=_SHARED_TRANSPORT,   # pool compartilhado: mantém keep-alive
        follow_redirects=True,
    )
    client = SyncPostgrestClient(
        f"{settings.supabase_url}/rest/v1",
        headers=dict(session.headers),
        schema="public",
        timeout=_REST_TIMEOUT,
    )
    client.session = session
    return client


class _SupabaseProxy:
    """Encaminha `.table()` / `.rpc()` para o client certo da request.

    Com JWT no contexto  -> PostgREST como o usuário (RLS aplica).
    Sem JWT              -> service_role (rotas públicas, sync, startup).
    """

    def __init__(self, admin_client: Client):
        self._admin = admin_client

    def _active(self):
        if not settings.rls_as_user:
            return self._admin.postgrest
        jwt = _request_jwt.get()
        if not jwt:
            return self._admin.postgrest

        # Uma vez por REQUISIÇÃO, não uma por consulta.
        pronto = _request_pg.get()
        if pronto is not None:
            return pronto
        pronto = _build_user_postgrest(jwt)
        _request_pg.set(pronto)
        return pronto

    def table(self, name: str):
        _conta(name)
        return self._active().table(name)

    from_ = table

    def rpc(self, fn: str, params: dict | None = None):
        _conta("rpc:" + fn)
        return self._active().rpc(fn, params or {})

    def __getattr__(self, item):
        # auth/storage/realtime e afins continuam vindo do client completo.
        return getattr(self._admin, item)


# Client service_role puro. Use quando a operação PRECISA ignorar RLS:
# ledger de sync, provisionamento de organização, rotas públicas.
supabase_admin: Client = get_supabase()

# Client padrão usado por todos os services (31 imports).
supabase = _SupabaseProxy(supabase_admin)
