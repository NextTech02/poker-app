from supabase import create_client, Client, ClientOptions
from app.config import get_settings
import httpx
from httpx import Limits
from postgrest.utils import SyncClient

settings = get_settings()


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
