from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    supabase_url: str
    supabase_service_key: str
    supabase_jwt_secret: str = ""   # opcional — se vazio usa JWKS (ES256/RS256)
    frontend_url: str = "http://localhost:3000"
    # A landing mora em OUTRA origem (aceblind.net) e o app em app.aceblind.net.
    # Sem ela no CORS, o formulário público seria barrado pelo navegador — e o
    # erro aparece só no console de quem tentou virar cliente.
    landing_url: str = ""
    environment: str = "development"
    # Allowlist of auth.users IDs (comma-separated) that are super-admins despite
    # having no `staff` record. Previously ANY user without a staff record was
    # treated as super-admin — a privilege-escalation default. This pins admin to
    # known owner accounts only. Seed it in .env with the real owner IDs.
    super_admin_user_ids: str = ""
    # Chave pública (anon/publishable). Usada como `apikey` quando o backend
    # executa queries COMO O USUÁRIO — nesse modo quem define a identidade é o
    # Authorization: Bearer <jwt>, e o RLS aplica. Sem ela, cai na service_key.
    supabase_anon_key: str = ""
    # Interruptor do modo multi-tenant no backend. Ligado: as queries rodam com
    # o JWT do usuário e o RLS isola as organizações. Desligado: volta ao
    # comportamento antigo (service_role, ignora RLS) — rollback de emergência
    # sem precisar de deploy, basta SUPABASE_RLS_AS_USER=false e reiniciar.
    rls_as_user: bool = True
    # Aviso de lead da landing page. Sem eles o formulário continua funcionando
    # — o lead é gravado no banco de qualquer jeito; o e-mail é só a notificação.
    resend_api_key: str = ""
    leads_email_from: str = "AceBlind <noreply@aceblind.net>"
    # Secret do hCaptcha (a mesma site key que o frontend usa e que está
    # configurada em Supabase → Auth → Attack protection). O "esqueci minha
    # senha" passou a ser verificado pelo backend, não mais pelo Supabase.
    # Vazio: a verificação é PULADA com aviso no log — serve para o ambiente
    # de desenvolvimento; em produção é obrigatório.
    hcaptcha_secret: str = ""
    # Diagnóstico: uma linha de log por requisição, com o tempo e o número de
    # idas ao banco. Desligado em produção — ver PerfLogMiddleware em main.py.
    perf_log: bool = False
    leads_email_to: str = ""   # um ou mais destinos, separados por vírgula

    @property
    def super_admin_ids(self) -> set[str]:
        return {x.strip() for x in self.super_admin_user_ids.split(",") if x.strip()}

    class Config:
        env_file = ".env"
        case_sensitive = False
        extra = "ignore"


@lru_cache()
def get_settings():
    return Settings()
