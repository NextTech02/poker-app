from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    supabase_url: str
    supabase_service_key: str
    supabase_jwt_secret: str = ""   # opcional — se vazio usa JWKS (ES256/RS256)
    frontend_url: str = "http://localhost:3000"
    environment: str = "development"
    # Allowlist of auth.users IDs (comma-separated) that are super-admins despite
    # having no `staff` record. Previously ANY user without a staff record was
    # treated as super-admin — a privilege-escalation default. This pins admin to
    # known owner accounts only. Seed it in .env with the real owner IDs.
    super_admin_user_ids: str = ""

    @property
    def super_admin_ids(self) -> set[str]:
        return {x.strip() for x in self.super_admin_user_ids.split(",") if x.strip()}

    class Config:
        env_file = ".env"
        case_sensitive = False


@lru_cache()
def get_settings():
    return Settings()
