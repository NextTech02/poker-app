from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import JWTError, jwt
from jose.exceptions import JWKError, ExpiredSignatureError
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


def _registrar_sessao(payload: dict, request: Request) -> dict:
    """Primeira requisição de cada sessão vira uma linha de `login` no log de
    acessos. Fica aqui, e não no frontend, porque este é o único ponto por onde
    TODA requisição autenticada passa — inclusive as de quem chama a API na mão.
    Nunca pode falhar: o log é acessório da autenticação, não o contrário."""
    try:
        # Import tardio: `services` importa o cliente do banco, que importa
        # config; manter fora do topo evita ciclo com `permissions.py`.
        from app.services.activity_log_service import ActivityLogService
        ActivityLogService.touch_session(payload, request)
    except Exception:  # noqa: BLE001
        pass
    return payload


def verify_token(request: Request, credentials: HTTPAuthorizationCredentials = Depends(security)):
    """Verify Supabase JWT token — supports both HS256 (legacy) and ES256/RS256 (new)."""
    token = credentials.credentials

    # Try legacy HS256 first (only when secret is configured)
    if settings.supabase_jwt_secret:
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
            return _registrar_sessao(payload, request)
        except JWTError:
            pass

    # Fall back to asymmetric JWKS verification (ES256 / RS256)
    try:
        # O header é lido SEM verificação — só para descobrir qual chave do JWKS
        # usar (`kid`). A assinatura é conferida no `decode` abaixo.
        header = jwt.get_unverified_header(token)
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
            # Algoritmos FIXOS, e não o `alg` que vem no header do token.
            # Aceitar o algoritmo informado pelo próprio token é a brecha
            # clássica de "confusão de algoritmo": bastaria forjar um token
            # dizendo `alg: HS256` e assiná-lo com a CHAVE PÚBLICA do JWKS
            # (que é pública, em /.well-known/jwks.json) usada como segredo
            # HMAC. Aqui só entram os assimétricos que o Supabase emite.
            algorithms=["ES256", "RS256"],
            options={"verify_aud": False}
        )
        user_id: str = payload.get("sub")
        if user_id is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid authentication credentials")
        return _registrar_sessao(payload, request)
    except (JWTError, JWKError) as e:
        # JWKError precisa entrar aqui junto com JWTError: um token EXPIRADO
        # falha no caminho HS256, cai para o JWKS e estoura JWKError ("Expected
        # 'oct', Received: EC"). Sem capturar, virava HTTP 500 — o usuário via
        # "erro interno" no lugar de "sua sessão expirou, entre de novo".
        print(f"[JWT ERROR] {e}")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Sessão expirada ou credenciais inválidas.",
        )


def get_current_user(token_data: dict = Depends(verify_token)):
    """Get current authenticated user from token"""
    return token_data
