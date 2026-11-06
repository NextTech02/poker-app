"""Configuração lida do ambiente.

O interruptor do multi-clube (`rls_as_user`) é o rollback de emergência: com
ele desligado o backend volta a consultar com a chave de serviço, sem deploy.
O docker-compose o passa como SUPABASE_RLS_AS_USER — e o campo só lia
RLS_AS_USER, então desligar na VPS não desligava nada.
"""
import pytest

from app.config import Settings


@pytest.fixture
def ambiente(monkeypatch):
    for nome in ("SUPABASE_RLS_AS_USER", "RLS_AS_USER"):
        monkeypatch.delenv(nome, raising=False)
    monkeypatch.setenv("SUPABASE_URL", "https://exemplo.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_KEY", "a.b.c")
    return monkeypatch


def _ler():
    # Sem o .env do disco: só o ambiente do teste conta.
    return Settings(_env_file=None)


def test_sem_nada_o_multi_clube_fica_ligado(ambiente):
    assert _ler().rls_as_user is True


@pytest.mark.parametrize("nome", ["SUPABASE_RLS_AS_USER", "RLS_AS_USER"])
def test_o_interruptor_desliga_pelo_nome_do_compose_e_pelo_antigo(ambiente, nome):
    ambiente.setenv(nome, "false")
    assert _ler().rls_as_user is False


def test_ligado_explicitamente_continua_ligado(ambiente):
    ambiente.setenv("SUPABASE_RLS_AS_USER", "true")
    assert _ler().rls_as_user is True
