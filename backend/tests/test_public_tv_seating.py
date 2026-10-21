"""Telão de MESAS E ASSENTOS (pedido do NSOP para o dia final).

A TV do salão abre `/tv/<código>/mesas` sem login e mostra quem senta onde,
em ordem alfabética, para cada jogador achar a sua cadeira. É a única rota
pública que leva nome de jogador — então o que se testa é tanto o que SAI
(nome, mesa, assento, fichas de classificação) quanto o que NÃO sai
(documento, ids, quem não tem assento, dia de outro código).
"""
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models.public_tv import PublicSeating
from app.services import public_tv_service as mod
from app.services.module_service import ModuleService
from app.services.public_tv_service import PublicTvService
from app.utils.erros import ErroDeNegocio

from tests.conftest import FakeSupabase


DIA = "77777777-7777-7777-7777-777777777777"
OUTRO_DIA = "88888888-8888-8888-8888-888888888888"
TOUR = "22222222-2222-2222-2222-222222222222"
ORG = "33333333-3333-3333-3333-333333333333"


def _assento(jogador, nome, mesa, assento, dia=DIA):
    return {
        "id": f"a-{jogador}", "tournament_day_id": dia, "player_id": jogador,
        "seat_number": assento, "tournament_tables": {"table_number": mesa},
        "players": {"name": nome, "document_number": "123.456.789-00"},
    }


@pytest.fixture
def banco(monkeypatch, stub):
    fake = FakeSupabase({
        "tournament_days": [
            {"id": DIA, "day_name": "Día Final", "tournament_id": TOUR,
             "organization_id": ORG, "broadcast_code": "ABC234"},
            {"id": OUTRO_DIA, "day_name": "Día 1A", "tournament_id": TOUR,
             "organization_id": ORG, "broadcast_code": "ZZZ999"},
        ],
        "tournaments": [{"id": TOUR, "name": "Main Event NSOP"}],
        "app_settings": [{"id": 1, "organization_id": ORG, "currency": "PEN", "language": "es-ES"}],
        "seat_allocations": [
            _assento("j1", "humberto Farfan", 2, 5),
            _assento("j2", "Christian Maguiña", 1, 3),
            _assento("j3", "Ana Paredes", 1, 7),
            # Alternado: sem mesa, não entra no quadro.
            {"id": "a-alt", "tournament_day_id": DIA, "player_id": "j4", "seat_number": None,
             "tournament_tables": None, "players": {"name": "Zeca Alternado"}},
            # Outro dia (outro código): nunca aparece aqui.
            _assento("j9", "Alheio", 3, 1, dia=OUTRO_DIA),
        ],
        "tournament_players": [
            {"id": "tp1", "tournament_day_id": DIA, "player_id": "j1", "status": "active",
             "is_qualified_entry": True, "total_chips": 763800},
            {"id": "tp2", "tournament_day_id": DIA, "player_id": "j2", "status": "active",
             "is_qualified_entry": True, "total_chips": 180300},
            # Comprou direto no dia final: as fichas são o stack inicial, não classificação.
            {"id": "tp3", "tournament_day_id": DIA, "player_id": "j3", "status": "active",
             "is_qualified_entry": False, "total_chips": 50000},
        ],
    })
    monkeypatch.setattr(mod, "supabase_admin", fake)
    stub(ModuleService, org_name=lambda org: "NSOP" if org == ORG else None)
    return fake


class TestServico:

    def test_lista_quem_senta_onde_em_ordem_alfabetica(self, banco):
        r = PublicTvService.get_seating("ABC234")
        assert isinstance(r, PublicSeating)
        assert [(s.name, s.table_number, s.seat_number) for s in r.seats] == [
            ("Ana Paredes", 1, 7),
            ("Christian Maguiña", 1, 3),
            ("humberto Farfan", 2, 5),   # minúscula não vai para o fim da lista
        ]

    def test_cabecalho_do_quadro(self, banco):
        r = PublicTvService.get_seating("ABC234")
        assert (r.day_id, r.tournament_name, r.day_name) == (DIA, "Main Event NSOP", "Día Final")
        assert r.organization_name == "NSOP"
        assert r.language == "es-ES"   # idioma do clube: a TV anônima não tem o do usuário

    def test_fichas_so_de_quem_veio_de_classificatorio(self, banco):
        fichas = {s.name: s.chips for s in PublicTvService.get_seating("ABC234").seats}
        assert fichas == {"Ana Paredes": None, "Christian Maguiña": 180300, "humberto Farfan": 763800}

    def test_codigo_vale_maiusculo_ou_minusculo_com_espacos(self, banco):
        assert len(PublicTvService.get_seating("  abc234 ").seats) == 3

    def test_outro_codigo_mostra_so_o_seu_dia(self, banco):
        r = PublicTvService.get_seating("ZZZ999")
        assert [s.name for s in r.seats] == ["Alheio"]

    @pytest.mark.parametrize("codigo", ["NAOEXISTE", "", None])
    def test_codigo_invalido_e_404(self, banco, codigo):
        with pytest.raises(ErroDeNegocio) as erro:
            PublicTvService.get_seating(codigo)
        assert erro.value.code == "codigo_de_tv_invalido"

    def test_sem_assentos_ainda_devolve_quadro_vazio(self, banco):
        banco.store["seat_allocations"] = []
        r = PublicTvService.get_seating("ABC234")
        assert r.seats == []
        assert r.day_name == "Día Final"

    def test_falha_nas_fichas_nao_derruba_o_quadro(self, banco, monkeypatch):
        original = banco.table

        def table(nome):
            if nome == "tournament_players":
                raise RuntimeError("timeout")
            return original(nome)

        monkeypatch.setattr(banco, "table", table)
        r = PublicTvService.get_seating("ABC234")
        assert len(r.seats) == 3
        assert all(s.chips is None for s in r.seats)


class TestRota:

    def test_sem_login_e_so_os_campos_do_quadro(self, banco):
        corpo = TestClient(app).get("/public/tv/ABC234/seating").json()
        assert set(corpo.keys()) == {
            "day_id", "tournament_name", "day_name", "organization_name", "language", "seats",
        }
        # Documento, ids de jogador e de alocação ficam do lado de dentro.
        assert set(corpo["seats"][0].keys()) == {"name", "table_number", "seat_number", "chips"}
        assert "123.456.789-00" not in str(corpo)
        assert "j1" not in str(corpo)

    def test_codigo_invalido_responde_404_com_codigo(self, banco):
        r = TestClient(app).get("/public/tv/NAOEXISTE/seating")
        assert r.status_code == 404
        assert r.json()["detail"]["code"] == "codigo_de_tv_invalido"
