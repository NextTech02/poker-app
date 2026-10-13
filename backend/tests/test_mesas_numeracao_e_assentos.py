"""Mesas com quantos assentos o clube quiser, e com o número que o operador escolher.

Duas regras que saíram do código em out/2026:

- **Assentos tinham teto de 10** (modelo, rota e CHECK do banco). O salão
  monta mesa de 11 na final e de 12 em evento especial; o teto transformava
  o pedido em erro. Fica só o mínimo: zero continua recusado.
- **O número da mesa era automático** (sempre o próximo livre). O número é
  o rótulo da mesa FÍSICA: o salão pode já ter as mesas 1-4 de outro evento,
  e o torneio usa as 5-8. Agora o lote aceita `start_number` e a mesa aceita
  trocar de número — com uma recusa própria (409, código) quando o número já
  existe no dia, porque duas "Mesa 3" mandariam o jogador para a cadeira
  errada.
"""
import pytest

from app.models.seat_allocation import SeatAllocationCreate
from app.models.table import Table, TableCreate, TableUpdate
from app.services.table_service import TableService as TSvc
from app.utils.erros import ErroDeNegocio

from tests.conftest import FakeSupabase


TOUR = "22222222-2222-2222-2222-222222222222"
DIA = "77777777-7777-7777-7777-777777777777"
MESA = "66666666-6666-6666-6666-666666666666"


def _mesa(numero=1, lugares=9):
    return Table(id=MESA, tournament_id=TOUR, tournament_day_id=DIA,
                 table_number=numero, seats=lugares, occupied_seats=0,
                 status="active", created_at="2026-06-08T00:00:00Z")


def _linha(numero, lugares=9):
    return {"id": f"m{numero}", "tournament_id": TOUR, "tournament_day_id": DIA,
            "table_number": numero, "seats": lugares, "status": "active",
            "occupied_seats": 0, "created_at": "2026-06-08T00:00:00Z"}


@pytest.fixture
def banco(monkeypatch):
    """Só a mesa 3 existe no dia."""
    fake = FakeSupabase({"tournament_tables": [_linha(3)]})
    monkeypatch.setattr("app.services.table_service.supabase", fake)
    return fake


# ─────────────────────────────────────────────────────────────────────────────
# Assentos sem teto
# ─────────────────────────────────────────────────────────────────────────────

class TestAssentosSemTeto:
    def test_modelo_aceita_mesa_de_12(self):
        assert TableCreate(table_number=1, seats=12).seats == 12
        assert TableUpdate(seats=14).seats == 14

    def test_modelo_ainda_recusa_mesa_sem_assento(self):
        with pytest.raises(ValueError):
            TableCreate(table_number=1, seats=0)

    def test_assento_12_cabe_na_alocacao(self):
        # O assento vai até onde a mesa for; quem confere se cabe na mesa é o
        # serviço de alocação, contra `seats`.
        assert SeatAllocationCreate(player_id="p", table_id="m", seat_number=12).seat_number == 12

    def test_mesa_de_12_passa_pela_rota_de_criacao(self, client, stub):
        recebido = {}
        stub(TSvc, create_table=lambda tid, dados, tournament_day_id=None: recebido.update(seats=dados.seats) or _mesa(lugares=dados.seats))
        r = client.post(f"/tables/tournament/{TOUR}", json={"table_number": 1, "seats": 12})
        assert r.status_code == 201
        assert r.json()["seats"] == 12
        assert recebido == {"seats": 12}

    def test_lote_de_12_lugares_passa_pela_rota(self, client, stub):
        recebido = {}

        def fake(tid, count, seats, tournament_day_id=None, start_number=None):
            recebido.update(count=count, seats=seats, start=start_number)
            return [_mesa(lugares=seats)]

        stub(TSvc, create_multiple_tables=fake)
        r = client.post(f"/tables/tournament/{TOUR}/bulk?count=1&seats=12")
        assert r.status_code == 201
        assert recebido == {"count": 1, "seats": 12, "start": None}

    def test_lote_sem_assento_continua_recusado_so_com_minimo(self, client):
        r = client.post(f"/tables/tournament/{TOUR}/bulk?count=1&seats=0")
        assert r.status_code == 400
        assert r.json()["detail"]["code"] == "lugares_por_mesa_invalido"
        assert r.json()["detail"]["minimo"] == 1
        assert "maximo" not in r.json()["detail"]

    def test_servico_grava_a_mesa_de_12(self, banco):
        mesa = TSvc.create_table(TOUR, TableCreate(table_number=4, seats=12), tournament_day_id=DIA)
        assert mesa.seats == 12


# ─────────────────────────────────────────────────────────────────────────────
# Número escolhido pelo operador
# ─────────────────────────────────────────────────────────────────────────────

class TestNumeracaoDoLote:
    def test_sem_numero_inicial_continua_da_maior(self, banco):
        mesas = TSvc.create_multiple_tables(TOUR, 2, 9, tournament_day_id=DIA)
        assert [m.table_number for m in mesas] == [4, 5]

    def test_com_numero_inicial_comeca_onde_o_operador_pediu(self, banco):
        mesas = TSvc.create_multiple_tables(TOUR, 2, 9, tournament_day_id=DIA, start_number=10)
        assert [m.table_number for m in mesas] == [10, 11]

    def test_numero_inicial_que_colide_e_recusado_com_o_numero_certo(self, banco):
        # 2, 3, 4 — a 3 já existe. Nada é gravado: o lote é tudo ou nada.
        with pytest.raises(ErroDeNegocio) as exc:
            TSvc.create_multiple_tables(TOUR, 3, 9, tournament_day_id=DIA, start_number=2)
        assert exc.value.code == "numero_de_mesa_repetido"
        assert exc.value.status == 409
        assert exc.value.dados["table_number"] == 3
        assert [m.table_number for m in TSvc.get_day_tables(DIA)] == [3]

    def test_rota_passa_o_numero_inicial_ao_servico(self, client, stub):
        recebido = {}

        def fake(tid, count, seats, tournament_day_id=None, start_number=None):
            recebido.update(start=start_number)
            return [_mesa(numero=start_number)]

        stub(TSvc, create_multiple_tables=fake)
        r = client.post(f"/tables/tournament/{TOUR}/bulk?count=1&seats=9&start_number=7")
        assert r.status_code == 201
        assert recebido == {"start": 7}
        assert r.json()[0]["table_number"] == 7

    def test_numero_inicial_zero_e_recusado_antes_do_servico(self, client):
        r = client.post(f"/tables/tournament/{TOUR}/bulk?count=1&seats=9&start_number=0")
        assert r.status_code == 400
        assert r.json()["detail"]["code"] == "numero_de_mesa_invalido"
        assert r.json()["detail"]["minimo"] == 1


class TestTrocaDeNumero:
    class _BancoQueRecusa:
        """O Postgres respondendo à UNIQUE (tournament_day_id, table_number)."""

        def __init__(self, mensagem):
            self._mensagem = mensagem

        def table(self, *_):
            return self

        def update(self, *_):
            return self

        def insert(self, *_):
            return self

        def eq(self, *_):
            return self

        def execute(self):
            raise Exception(self._mensagem)

    def test_unique_do_banco_vira_recusa_com_codigo(self, monkeypatch):
        monkeypatch.setattr(
            "app.services.table_service.supabase",
            self._BancoQueRecusa('duplicate key value violates unique constraint "tournament_tables_day_table_number_key"'),
        )
        with pytest.raises(ErroDeNegocio) as exc:
            TSvc.update_table(MESA, TableUpdate(table_number=2))
        assert exc.value.code == "numero_de_mesa_repetido"
        assert exc.value.status == 409
        assert exc.value.dados["table_number"] == 2

    def test_criar_mesa_com_numero_repetido_tambem_e_recusa(self, monkeypatch):
        monkeypatch.setattr(
            "app.services.table_service.supabase",
            self._BancoQueRecusa("23505"),
        )
        with pytest.raises(ErroDeNegocio) as exc:
            TSvc.create_table(TOUR, TableCreate(table_number=5, seats=9), tournament_day_id=DIA)
        assert exc.value.code == "numero_de_mesa_repetido"
        assert exc.value.dados["table_number"] == 5

    def test_outro_erro_do_banco_nao_e_mascarado(self, monkeypatch):
        # Conexão caída não é "número repetido": tem de subir como está, para
        # virar 500 e aparecer no log — não uma recusa que o operador "corrige".
        monkeypatch.setattr(
            "app.services.table_service.supabase",
            self._BancoQueRecusa("connection reset by peer"),
        )
        with pytest.raises(Exception) as exc:
            TSvc.update_table(MESA, TableUpdate(table_number=2))
        assert not isinstance(exc.value, ErroDeNegocio)

    def test_troca_de_numero_grava(self, banco):
        mesa = TSvc.update_table("m3", TableUpdate(table_number=12))
        assert mesa.table_number == 12
        assert mesa.seats == 9  # só o número mudou

    def test_rota_patch_devolve_409_com_codigo_e_numero(self, client, stub):
        def recusa(mid, dados):
            raise ErroDeNegocio("numero_de_mesa_repetido", "Já existe", status=409, table_number=2)

        stub(TSvc, update_table=recusa)
        r = client.patch(f"/tables/{MESA}", json={"table_number": 2})
        assert r.status_code == 409
        assert r.json()["detail"]["code"] == "numero_de_mesa_repetido"
        assert r.json()["detail"]["table_number"] == 2

    def test_rota_de_criacao_devolve_409_com_codigo(self, client, stub):
        def recusa(tid, dados, tournament_day_id=None):
            raise ErroDeNegocio("numero_de_mesa_repetido", "Já existe", status=409, table_number=1)

        stub(TSvc, create_table=recusa)
        r = client.post(f"/tables/tournament/{TOUR}", json={"table_number": 1, "seats": 9})
        assert r.status_code == 409
        assert r.json()["detail"]["code"] == "numero_de_mesa_repetido"

    def test_rota_patch_recusa_numero_zero_na_validacao(self, client):
        assert client.patch(f"/tables/{MESA}", json={"table_number": 0}).status_code == 422
