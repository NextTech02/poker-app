"""Telão PÚBLICO: o que a TV do salão recebe sem login.

A rota `/public/tv/days/{id}/extras` nasceu de um buraco concreto: a TV
anônima nunca mostrava os prêmios (os endpoints de premiação exigem login) e
formatava a moeda pela linha de `app_settings` de uma organização qualquer.
Ela é aberta à internet, então o que se testa aqui é tanto o que SAI (prêmios
visíveis, moeda do clube certo) quanto o que NÃO pode sair (nome de jogador,
documento, prêmio escondido).
"""
from decimal import Decimal
from types import SimpleNamespace

import pytest

from app.models.public_tv import PublicTvExtras
from app.models.tournament_day import TournamentDay, TournamentDayUpdate
from app.services import public_tv_service as mod
from app.services.module_service import ModuleService
from app.services.prize_allocation_service import PrizeAllocationService as PAS
from app.services.public_tv_service import PublicTvService
from app.utils.erros import ErroDeNegocio

from tests.conftest import FakeSupabase


DIA = "77777777-7777-7777-7777-777777777777"
TOUR = "22222222-2222-2222-2222-222222222222"
ORG = "33333333-3333-3333-3333-333333333333"
OUTRA_ORG = "44444444-4444-4444-4444-444444444444"


def _premio(pos, valor, **extra):
    base = {"id": f"p{pos}", "tournament_id": TOUR, "position": pos,
            "prize_amount": valor, "visible": True, "prize_type": "cash",
            "player_id": "j1", "players": {"name": "Fulano"},
            "document_number": "123.456.789-00", "paid": True}
    base.update(extra)
    return base


@pytest.fixture
def banco(monkeypatch, stub):
    fake = FakeSupabase({
        "tournament_days": [{"id": DIA, "tournament_id": TOUR, "organization_id": ORG}],
        "app_settings": [
            {"id": 1, "organization_id": OUTRA_ORG, "currency": "USD", "language": "en-US"},
            {"id": 2, "organization_id": ORG, "currency": "PEN", "language": "es-ES"},
        ],
        "prize_allocations": [
            _premio(2, 7500),
            _premio(1, 15000),
            _premio(3, 5000, visible=False),
            _premio(4, 0, prize_type="vaga", vaga_target_day_id="d-final"),
        ],
    })
    monkeypatch.setattr(mod, "supabase_admin", fake)
    # `org_name` lê com o client de verdade por dentro; aqui ele é decorativo.
    stub(ModuleService, org_name=lambda org: "Zonabet Poker" if org == ORG else None)
    stub(PAS, get_prize_summary=lambda tid: SimpleNamespace(available_prize_pool=Decimal("45000")))
    return fake


class TestServico:

    def test_devolve_clube_moeda_pool_e_premios_visiveis(self, banco):
        r = PublicTvService.get_day_extras(DIA)
        assert isinstance(r, PublicTvExtras)
        assert r.organization_name == "Zonabet Poker"
        assert r.prize_pool == 45000.0
        assert [p.position for p in r.prizes] == [1, 2, 4]   # ordenado; o 3º está escondido
        assert r.prizes[0].prize_amount == 15000.0

    def test_moeda_e_da_organizacao_do_dia_nao_da_primeira_linha(self, banco):
        """Antes a TV lia `app_settings` sem filtro e pegava a linha de
        qualquer clube (USD, aqui). O dia é do clube peruano: S/."""
        assert PublicTvService.get_day_extras(DIA).currency == "PEN"

    def test_idioma_e_da_organizacao_do_dia(self, banco):
        """A TV do salão não tem login: o idioma do clube só chega por aqui."""
        assert PublicTvService.get_day_extras(DIA).language == "es-ES"

    def test_sem_app_settings_cai_em_brl_e_portugues(self, banco):
        banco.store["app_settings"] = []
        r = PublicTvService.get_day_extras(DIA)
        assert r.currency == "BRL"
        assert r.language == "pt-BR"

    def test_nada_sensivel_sai_pela_rota_aberta(self, banco):
        """A rota não tem login: nome de jogador, documento e pagamento ficam
        de fora mesmo estando na linha do prêmio."""
        premio = PublicTvService.get_day_extras(DIA).prizes[0].model_dump()
        for campo in ("player_name", "player_id", "document_number", "paid", "players"):
            assert campo not in premio

    def test_vaga_leva_o_destino(self, banco):
        vaga = PublicTvService.get_day_extras(DIA).prizes[-1]
        assert vaga.prize_type == "vaga"
        assert vaga.vaga_target_day_id == "d-final"

    def test_dia_inexistente_e_404_com_codigo(self, banco):
        with pytest.raises(ErroDeNegocio) as exc:
            PublicTvService.get_day_extras("nao-existe")
        assert exc.value.status == 404
        assert exc.value.code == "dia_nao_encontrado"

    def test_resumo_de_premiacao_falhando_nao_leva_os_premios_junto(self, banco, stub):
        """O resumo soma vendas de todos os dias e pode falhar sozinho; a lista
        de prêmios é lida à parte e continua chegando ao telão."""
        def _estoura(tid):
            raise RuntimeError("rpc fora")
        stub(PAS, get_prize_summary=_estoura)
        r = PublicTvService.get_day_extras(DIA)
        assert r.prize_pool is None
        assert len(r.prizes) == 3

    def test_falha_ao_ler_premios_vira_lista_vazia(self, banco, monkeypatch):
        class _Explode:
            def table(self, name):
                if name == "prize_allocations":
                    raise RuntimeError("tabela fora")
                return banco.table(name)
        monkeypatch.setattr(mod, "supabase_admin", _Explode())
        assert PublicTvService.get_day_extras(DIA).prizes == []

    def test_falha_ao_ler_moeda_vira_brl(self, banco, monkeypatch):
        class _Explode:
            def table(self, name):
                if name == "app_settings":
                    raise RuntimeError("tabela fora")
                return banco.table(name)
        monkeypatch.setattr(mod, "supabase_admin", _Explode())
        r = PublicTvService.get_day_extras(DIA)
        assert r.currency == "BRL"
        assert r.language == "pt-BR"


class TestRota:
    """Sem header de autenticação: é a TV do salão."""

    def test_extras_sem_login(self, client, stub):
        stub(PublicTvService, get_day_extras=lambda did: PublicTvExtras(
            day_id=did, tournament_id=TOUR, organization_name="Clube", currency="PEN",
            language="es-ES", prize_pool=45000, prizes=[{"position": 1, "prize_amount": 15000}]))
        r = client.get(f"/public/tv/days/{DIA}/extras")
        assert r.status_code == 200
        corpo = r.json()
        assert corpo["currency"] == "PEN"
        assert corpo["language"] == "es-ES"
        assert corpo["prizes"][0]["position"] == 1
        assert corpo["prizes"][0]["prize_type"] == "cash"

    def test_dia_inexistente_da_404_estruturado(self, client, stub):
        def _estoura(did):
            raise ErroDeNegocio("dia_nao_encontrado", "Dia não encontrado.", status=404)
        stub(PublicTvService, get_day_extras=_estoura)
        r = client.get(f"/public/tv/days/{DIA}/extras")
        assert r.status_code == 404
        assert r.json()["detail"]["code"] == "dia_nao_encontrado"

    def test_rota_de_codigo_continua_resolvendo(self, client, stub):
        """`/tv/{code}` e `/tv/days/...` convivem: um segmento vs três."""
        from app.services.tournament_day_service import TournamentDayService as TDS
        stub(TDS, resolve_broadcast_code=lambda code: {"day_id": DIA, "tournament_id": TOUR})
        assert client.get("/public/tv/ABC234").json()["day_id"] == DIA


class TestModeloDoDia:
    """NULL nas cores passou a significar "padrão do app" — o modelo de
    resposta tem de aceitar, senão todo GET do dia cai em 500 depois da
    migração que zera as cores herdadas."""

    def _linha(self, **kw):
        base = {"id": DIA, "tournament_id": TOUR, "day_name": "Dia 1", "buy_in": 100,
                "max_players": 200, "created_at": "2026-06-08T00:00:00Z"}
        base.update(kw)
        return base

    def test_cores_nulas_sao_aceitas(self):
        dia = TournamentDay(**self._linha(
            broadcast_timer_color=None, broadcast_title_color=None,
            broadcast_sidebar_value_color=None, broadcast_bg_color=None,
            broadcast_break_timer_color=None))
        assert dia.broadcast_timer_color is None
        assert dia.broadcast_bg_color is None

    def test_criacao_nao_grava_cor_fixa(self):
        """O service grava `model_dump()` inteiro: um default de cor aqui
        viraria a cor "escolhida" de todo dia novo."""
        from app.models.tournament_day import TournamentDayCreate
        dados = TournamentDayCreate(tournament_id=TOUR, day_name="Dia 1",
                                    buy_in=100, max_players=200).model_dump()
        for campo in ("broadcast_timer_color", "broadcast_sidebar_value_color",
                      "broadcast_bg_color", "broadcast_break_bg_color"):
            assert dados[campo] is None
        # ...e a criação NÃO manda a coluna nova de overlay (pode não existir ainda).
        assert "broadcast_bg_overlay" not in dados

    def test_overlay_tem_padrao_na_resposta(self):
        assert TournamentDay(**self._linha()).broadcast_bg_overlay == 45

    def test_reentradas_entram_e_saem_do_modelo(self):
        """Antes o campo existia no banco e no toggle mas não no modelo: o
        PATCH descartava e o GET nunca devolvia."""
        assert TournamentDay(**self._linha(broadcast_show_reentries=False)).broadcast_show_reentries is False
        # Padrão LIGADO desde 2026-10: o tile "Reentradas" é fixo no layout do cliente.
        assert TournamentDay(**self._linha()).broadcast_show_reentries is True
        patch = TournamentDayUpdate(broadcast_show_reentries=True).model_dump(exclude_unset=True)
        assert patch == {"broadcast_show_reentries": True}

    def test_overlay_no_patch_respeita_a_faixa(self):
        assert TournamentDayUpdate(broadcast_bg_overlay=60).model_dump(exclude_unset=True) == {"broadcast_bg_overlay": 60}
        assert TournamentDayUpdate(broadcast_bg_overlay=0).model_dump(exclude_unset=True) == {"broadcast_bg_overlay": 0}
        with pytest.raises(ValueError):
            TournamentDayUpdate(broadcast_bg_overlay=95)
