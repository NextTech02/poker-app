"""Exclusão de organização: os ARQUIVOS do Storage vão junto.

O cascade do SQL apaga as linhas de `broadcast_backgrounds` e
`expense_attachments`, mas o Storage não participa dele: sem este passo os
fundos do telão ficariam acessíveis por link público para sempre, e os
comprovantes ocupando espaço. É best-effort — a organização já saiu do banco,
então falha aqui vira aviso, nunca 500 para o painel.
"""
import pytest

from app.routers import organizations as mod

from tests.conftest import FakeSupabase


ORG = "33333333-3333-3333-3333-333333333333"


class _StorageFake:
    """Pastas são itens sem `id` (como o Storage devolve); arquivos têm `id`."""

    def __init__(self, arvore):
        self.arvore = arvore          # bucket -> { pasta -> [itens] }
        self.removidos = []           # (bucket, [paths])

    def from_(self, bucket):
        fake = self

        class _Bucket:
            def list(self, pasta, *a, **k):
                return fake.arvore.get(bucket, {}).get(pasta, [])

            def remove(self, paths):
                fake.removidos.append((bucket, list(paths)))
        return _Bucket()


@pytest.fixture
def admin(client):
    client.usuario["platform_admin"] = True
    return client


@pytest.fixture
def banco(monkeypatch):
    fake = FakeSupabase({"organizations": [{"id": ORG, "name": "Clube A", "status": "suspended"}]})
    fake.rpcs["delete_organization"] = {"deleted": True}
    fake.storage = _StorageFake({
        "broadcast-backgrounds": {
            ORG: [{"name": "a.webp", "id": "1"}, {"name": "b.webp", "id": "2"}],
        },
        "comprovantes": {
            ORG: [{"name": "despesa-1", "id": None}],             # subpasta
            f"{ORG}/despesa-1": [{"name": "nota.pdf", "id": "3"}],
        },
    })
    monkeypatch.setattr(mod, "supabase_admin", fake)
    return fake


class TestLimpezaDoStorage:

    def test_apaga_fundos_e_comprovantes_da_org_recursivamente(self, admin, banco):
        assert admin.delete(f"/organizations/{ORG}").status_code == 200
        assert banco.storage.removidos == [
            ("broadcast-backgrounds", [f"{ORG}/a.webp", f"{ORG}/b.webp"]),
            ("comprovantes", [f"{ORG}/despesa-1/nota.pdf"]),
        ]

    def test_so_limpa_depois_de_o_banco_confirmar(self, admin, banco):
        """RPC recusou (org ativa): nada pode ter sido apagado do Storage."""
        def _estoura(_):
            raise Exception("Suspenda a organização antes de excluí-la")
        banco.rpcs["delete_organization"] = _estoura
        assert admin.delete(f"/organizations/{ORG}").status_code == 409
        assert banco.storage.removidos == []

    def test_falha_no_storage_nao_derruba_a_exclusao(self, admin, banco, monkeypatch):
        class _Explode:
            def from_(self, bucket):
                raise RuntimeError("storage fora")
        banco.storage = _Explode()
        assert admin.delete(f"/organizations/{ORG}").status_code == 200

    def test_lotes_de_cem(self, admin, banco):
        banco.storage.arvore["broadcast-backgrounds"][ORG] = [
            {"name": f"{i}.webp", "id": str(i)} for i in range(250)
        ]
        admin.delete(f"/organizations/{ORG}")
        lotes = [len(p) for b, p in banco.storage.removidos if b == "broadcast-backgrounds"]
        assert lotes == [100, 100, 50]
