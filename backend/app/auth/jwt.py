from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import JWTError, jwt
from jose.exceptions import JWKError
import httpx
from functools import lru_cache
from app.config import get_settings

settings = get_settings()
security = HTTPBearer()


@lru_cache(maxsize=1)
def get_jwks():
    """Fetch Supabase JWKS (cached). Used for asymmetric key verification."""
    url = f"{settings.supabase_url}/auth/v1/.well-known/jwks.json"
    try:
        response = httpx.get(url, timeout=10)
        response.raise_for_status()
        return tuple(response.json().get("keys", []))
    except Exception:
        return ()


def verify_token(credentials: HTTPAuthorizationCredentials = Depends(security)):
    """Verify Supabase JWT token — supports both HS256 (legacy) and ES256/RS256 (new)."""
    token = credentials.credentials

    # Try legacy HS256 first
    try:
        payload = jwt.decode(
            token,
            settings.supabase_jwt_secret,
            algorithms=["HS256"],
            options={"verify_aud": False}
        )
        user_id: str = payload.get("sub")
        if user_id is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid authentication credentials")
        return payload
    except JWTError:
        pass

    # Fall back to asymmetric JWKS verification (ES256 / RS256)
    try:
        header = jwt.get_unverified_header(token)
        alg = header.get("alg", "RS256")
        kid = header.get("kid")

        jwks = get_jwks()
        key = next((k for k in jwks if k.get("kid") == kid), None)
        if key is None and jwks:
            key = jwks[0]  # fallback to first key if kid not found

        if key is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="No matching signing key found")

        payload = jwt.decode(
            token,
            key,
            algorithms=[alg],
            options={"verify_aud": False}
        )
        user_id: str = payload.get("sub")
        if user_id is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid authentication credentials")
        return payload
    except JWTError as e:
        print(f"[JWT ERROR] {e}")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid authentication credentials")


def get_current_user(token_data: dict = Depends(verify_token)):
    """Get current authenticated user from token"""
    return token_data
