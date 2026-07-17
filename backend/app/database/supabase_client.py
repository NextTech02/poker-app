import contextlib
import re

from supabase import create_client, Client, ClientOptions
import supabase._sync.client as _supabase_sync_client
from app.config import get_settings
import httpx
from httpx import Limits
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


# Singleton instance
supabase: Client = get_supabase()
