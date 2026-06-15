"""Shared config + auth for the load/stress suite.

Reads Supabase URL / anon key / API base from the project's frontend/.env
(the anon key is publishable, not a secret) and lets every value be overridden
by an environment variable. Login uses Supabase's password grant to obtain a
real JWT that the FastAPI backend will accept.
"""
from __future__ import annotations
import os
from pathlib import Path

import httpx


def _parse_env_file(path: Path) -> dict:
    out = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


_REPO_ROOT = Path(__file__).resolve().parents[2]   # .../poker-app
_FRONTEND_ENV = _parse_env_file(_REPO_ROOT / "frontend" / ".env")
_LOADTEST_ENV = _parse_env_file(Path(__file__).resolve().parent / ".env")


def cfg(name: str, *fallbacks: str, default: str | None = None) -> str | None:
    """Resolve a config value: OS env → loadtest/.env → frontend/.env keys."""
    if os.getenv(name):
        return os.getenv(name)
    if name in _LOADTEST_ENV:
        return _LOADTEST_ENV[name]
    for fb in fallbacks:
        if fb in _LOADTEST_ENV:
            return _LOADTEST_ENV[fb]
        if fb in _FRONTEND_ENV:
            return _FRONTEND_ENV[fb]
    return default


API_BASE = (cfg("API_BASE_URL", "REACT_APP_API_URL", default="http://localhost:8000") or "").rstrip("/")
SUPABASE_URL = (cfg("SUPABASE_URL", "REACT_APP_SUPABASE_URL", default="") or "").rstrip("/")
SUPABASE_ANON_KEY = cfg("SUPABASE_ANON_KEY", "REACT_APP_SUPABASE_ANON_KEY", default="")
STRESS_EMAIL = cfg("STRESS_EMAIL", default="")
STRESS_PASSWORD = cfg("STRESS_PASSWORD", default="")
STAGE_ID = cfg("STAGE_ID", default="")
ENABLE_WRITES = (cfg("STRESS_WRITES", default="0") or "0") in ("1", "true", "True", "yes")


class ConfigError(RuntimeError):
    pass


def login(timeout: float = 15.0) -> str:
    """Obtain a Supabase access token (JWT) via the password grant."""
    if not (SUPABASE_URL and SUPABASE_ANON_KEY):
        raise ConfigError(
            "SUPABASE_URL / SUPABASE_ANON_KEY ausentes. Defina-os ou rode a partir do "
            "repo (lê de frontend/.env)."
        )
    if not (STRESS_EMAIL and STRESS_PASSWORD):
        raise ConfigError(
            "STRESS_EMAIL e STRESS_PASSWORD são obrigatórios (use uma conta de teste). "
            "Defina via variável de ambiente ou backend/loadtest/.env."
        )
    url = f"{SUPABASE_URL}/auth/v1/token?grant_type=password"
    headers = {"apikey": SUPABASE_ANON_KEY, "Content-Type": "application/json"}
    resp = httpx.post(url, json={"email": STRESS_EMAIL, "password": STRESS_PASSWORD},
                      headers=headers, timeout=timeout)
    if resp.status_code >= 400:
        raise ConfigError(f"Falha no login Supabase ({resp.status_code}): {resp.text[:200]}")
    token = resp.json().get("access_token")
    if not token:
        raise ConfigError("Login sem access_token na resposta.")
    return token


def auth_headers(token: str, stage_id: str | None = None) -> dict:
    h = {"Authorization": f"Bearer {token}"}
    if stage_id:
        h["X-Stage-ID"] = stage_id
    return h


def discover_ids(token: str, timeout: float = 15.0) -> dict:
    """Fetch real IDs (stage, tournaments, players, staff) so tasks hit live data."""
    h = auth_headers(token, STAGE_ID or None)
    ids = {"stage_id": STAGE_ID or None, "tournament_ids": [], "player_ids": [], "staff_ids": []}
    with httpx.Client(base_url=API_BASE, headers=h, timeout=timeout) as c:
        try:
            stages = c.get("/stages").json()
            if not ids["stage_id"] and isinstance(stages, list) and stages:
                ids["stage_id"] = stages[0]["id"]
        except Exception:
            pass
        h2 = auth_headers(token, ids["stage_id"])
        try:
            tours = c.get("/tournaments", headers=h2).json()
            ids["tournament_ids"] = [t["id"] for t in tours][:25] if isinstance(tours, list) else []
        except Exception:
            pass
        try:
            players = c.get("/players", headers=h2).json()
            ids["player_ids"] = [p["id"] for p in players][:50] if isinstance(players, list) else []
        except Exception:
            pass
        try:
            staff = c.get("/staff", headers=h2).json()
            ids["staff_ids"] = [s["id"] for s in staff if s.get("active")][:25] if isinstance(staff, list) else []
        except Exception:
            pass
    return ids
