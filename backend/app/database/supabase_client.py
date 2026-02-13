from supabase import create_client, Client, ClientOptions
from app.config import get_settings
import httpx
from httpx import Limits

settings = get_settings()


def get_supabase() -> Client:
    """Get Supabase client instance with Windows-compatible settings

    Note: WinError 10035 is Windows-specific and won't occur in Linux production.
    This configuration optimizes for Windows development environment.
    """
    # More conservative timeout settings for Windows
    timeout = httpx.Timeout(
        connect=15.0,   # Increased connection timeout
        read=60.0,      # Increased read timeout
        write=15.0,     # Increased write timeout
        pool=10.0       # Increased pool timeout
    )

    # Reduced connection pooling to minimize Windows socket issues
    # In production Linux, these can be increased
    limits = Limits(
        max_keepalive_connections=5,  # Reduced from 10
        max_connections=10,            # Reduced from 20
        keepalive_expiry=30.0          # Close idle connections after 30s
    )

    # Create options with longer timeouts
    options = ClientOptions(
        postgrest_client_timeout=60,  # Increased from 30
        storage_client_timeout=60,    # Increased from 30
        schema="public"
    )

    return create_client(
        settings.supabase_url,
        settings.supabase_service_key,
        options=options
    )


# Singleton instance
supabase: Client = get_supabase()
