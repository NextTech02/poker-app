from supabase import create_client, Client, ClientOptions
from app.config import get_settings
import httpx

settings = get_settings()


def get_supabase() -> Client:
    """Get Supabase client instance with custom timeout settings"""
    # Configure httpx client with better timeout settings
    timeout = httpx.Timeout(
        connect=10.0,  # 10 seconds to establish connection
        read=30.0,     # 30 seconds to read response
        write=10.0,    # 10 seconds to write request
        pool=5.0       # 5 seconds to get connection from pool
    )

    # Create client with retry and timeout configuration
    http_client = httpx.Client(
        timeout=timeout,
        limits=httpx.Limits(max_keepalive_connections=5, max_connections=10)
    )

    # Create options with proper ClientOptions object
    options = ClientOptions(
        postgrest_client_timeout=30,
        storage_client_timeout=30,
        schema="public"
    )

    return create_client(
        settings.supabase_url,
        settings.supabase_service_key,
        options=options
    )


# Singleton instance
supabase: Client = get_supabase()
