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
        "buy_types": [
            {"id": "bt2", "tournament_id": TOUR, "name": "Rebuy", "amount": 20, "category": "rebuy",
             "active": True, "sort_order": 2, "rake_percentage": 20, "chips": 10000},
            {"id": "bt1", "tournament_id": TOUR, "name": "Buy-in", "amount": 50, "category": "buy_in",
             "active": True, "sort_order": 1, "rake_percentage": 20, "chips": 20000},
            {"id": "bt3", "tournament_id": TOUR, "name": "Antigo", "amount": 99, "category": "addon",
             "active": False, "sort_order": 3},
            {"id": "bt9", "tournament_id": "outro-torneio", "name": "Alheio", "amount": 1,
             "category": "buy_in", "active": True, "sort_order": 0},
        ],
        # Jogadores deste dia (p1, p2) e de outro dia (p9); vendas por meio.
        "tournament_players": [
            {"id": "p1", "tournament_day_id": DIA}, {"id": "p2", "tournament_day_id": DIA},
            {"id": "p9", "tournament_day_id": "outro-dia"},
        ],
        "transactions": [
            {"id": "x1", "tournament_player_id": "p1", "type": "buy_in", "buy_type_id": "bt1", "status": "active"},
            {"id": "x2", "tournament_player_id": "p2", "type": "buy_in", "buy_type_id": "bt1", "status": "active"},
            {"id": "x3", "tournament_player_id": "p1", "type": "rebuy", "buy_type_id": "bt2", "status": "active"},
            {"id": "x4", "tournament_player_id": "p1", "type": "rebuy", "buy_type_id": "bt2", "status": "active"},
            {"id": "x5", "tournament_player_id": "p2", "type": "rebuy", "buy_type_id": "bt2", "status": "cancelled"},
            {"id": "x6", "tournament_player_id": "p2", "type": "buy_in", "buy_type_id": None, "status": "active"},
            {"id": "x7", "tournament_player_id": "p9", "type": "buy_in", "buy_type_id": "bt1", "status": "active"},
            {"id": "x8", "tournament_player_id": "p1", "type": "prize", "buy_type_id": None, "status": "active"},
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

    def test_meios_de_entrada_ativos_do_torneio_na_ordem_do_caixa(self, banco):
        """Só os ATIVOS deste torneio, por sort_order; sem rake, fichas ou id."""
        r = PublicTvService.get_day_extras(DIA)
        assert [(b.name, b.amount, b.category) for b in r.buy_types] == [
            ("Buy-in", 50.0, "buy_in"), ("Rebuy", 20.0, "rebuy"),
        ]
        corpo = r.model_dump()["buy_types"][0]
        assert set(corpo.keys()) == {"name", "count", "amount", "category"}

    def test_conta_as_vendas_do_dia_por_meio(self, banco):
        """Buy-in: 2 com meio + 1 antiga sem meio (cai no primeiro buy_in) = 3.
        Rebuy: 2 ativas (a cancelada fica fora). Jogador de outro dia e
        transação que não é venda não contam."""
        r = PublicTvService.get_day_extras(DIA)
        assert [(b.name, b.count) for b in r.buy_types] == [("Buy-in", 3), ("Rebuy", 2)]

    def test_dia_sem_vendas_mostra_zero_em_cada_meio(self, banco):
        banco.store["transactions"] = []
        r = PublicTvService.get_day_extras(DIA)
        assert [b.count for b in r.buy_types] == [0, 0]

    def test_falha_ao_contar_vendas_nao_tira_a_lista(self, banco, monkeypatch):
        class _Explode:
            def table(self, name):
                if name == "transactions":
                    raise RuntimeError("boom")
                return banco.table(name)
        monkeypatch.setattr(mod, "supabase_admin", _Explode())
        r = PublicTvService.get_day_extras(DIA)
        assert [(b.name, b.count) for b in r.buy_types] == [("Buy-in", 0), ("Rebuy", 0)]

    def test_sem_meios_de_entrada_a_lista_vem_vazia(self, banco):
        banco.store["buy_types"] = []
        assert PublicTvService.get_day_extras(DIA).buy_types == []

    def test_falha_ao_ler_meios_de_entrada_vira_lista_vazia(self, banco, monkeypatch):
        class _Explode:
            def table(self, name):
                if name == "buy_types":
                    raise RuntimeError("boom")
                return banco.table(name)
        monkeypatch.setattr(mod, "supabase_admin", _Explode())
        r = PublicTvService.get_day_extras(DIA)
        assert r.buy_types == []
        assert r.currency == "PEN"   # o resto segue normal

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

    def test_divulgacao_tem_padrao_na_resposta_e_nao_entra_na_criacao(self):
        """Coluna da direita do telão: sem URL, ligada, inteira. A criação
        do dia não manda as colunas (podem não existir ainda)."""
        from app.models.tournament_day import TournamentDayCreate, TournamentDayUpdate
        dia = TournamentDay(**self._linha())
        assert dia.broadcast_promo_url is None
        assert dia.broadcast_show_promo is True
        assert dia.broadcast_promo_fit == "contain"
        dados = TournamentDayCreate(tournament_id=TOUR, day_name="Dia 1",
                                    buy_in=100, max_players=200).model_dump()
        for campo in ("broadcast_promo_url", "broadcast_show_promo", "broadcast_promo_fit"):
            assert campo not in dados
        patch = TournamentDayUpdate(broadcast_promo_url="https://cdn/x.webp",
                                    broadcast_promo_fit="cover").model_dump(exclude_unset=True)
        assert patch == {"broadcast_promo_url": "https://cdn/x.webp", "broadcast_promo_fit": "cover"}

    def test_meios_de_entrada_no_telao_nascem_desligados_e_entradas_ligada(self):
        from app.models.tournament_day import TournamentDayCreate
        dia = TournamentDay(**self._linha())
        assert dia.broadcast_show_buy_types is False
        assert dia.broadcast_show_entries is True
        dados = TournamentDayCreate(tournament_id=TOUR, day_name="Dia 1",
                                    buy_in=100, max_players=200).model_dump()
        assert "broadcast_show_buy_types" not in dados
        assert "broadcast_show_entries" not in dados

    def test_tamanho_do_titulo_nasce_100_e_fica_entre_50_e_300(self):
        from pydantic import ValidationError
        from app.models.tournament_day import TournamentDayCreate, TournamentDayUpdate
        assert TournamentDay(**self._linha()).broadcast_title_size == 100
        assert TournamentDay(**self._linha(broadcast_title_size=180)).broadcast_title_size == 180
        dados = TournamentDayCreate(tournament_id=TOUR, day_name="Dia 1",
                                    buy_in=100, max_players=200).model_dump()
        assert "broadcast_title_size" not in dados
        assert TournamentDayUpdate(broadcast_title_size=150).model_dump(exclude_unset=True) == {"broadcast_title_size": 150}
        with pytest.raises(ValidationError):
            TournamentDayUpdate(broadcast_title_size=400)

    def test_ajuste_da_divulgacao_so_aceita_contain_ou_cover(self):
        from pydantic import ValidationError
        from app.models.tournament_day import TournamentDayUpdate
        with pytest.raises(ValidationError):
            TournamentDayUpdate(broadcast_promo_fit="stretch")

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


class TestPremiacaoPorEliminacao:
    """O telão mostra o pool KO ao lado do prizepool e, na fase Mystery,
    quantos envelopes faltam sair — nunca quem tem qual bounty."""

    def _resumo(self, **extra):
        base = dict(available_prize_pool=Decimal("6000"), total_prize_pool=Decimal("10000"),
                    ko_format="pko", ko_pool=Decimal("4000"))
        base.update(extra)
        return SimpleNamespace(**base)

    def test_sem_ko_nao_manda_nada_de_ko(self, banco):
        r = PublicTvService.get_day_extras(DIA)
        assert r.ko_format == "none"
        assert r.ko_pool is None and r.mystery_envelopes_left is None

    def test_pko_mostra_pool_total_e_pool_ko(self, banco, stub):
        stub(PAS, get_prize_summary=lambda tid: self._resumo())
        r = PublicTvService.get_day_extras(DIA)
        assert r.prize_pool == 10000.0   # posições + KO: o que o salão viu entrar
        assert r.ko_format == "pko"
        assert r.ko_pool == 4000.0
        assert r.mystery_envelopes_left is None

    def test_mystery_conta_os_envelopes_que_faltam(self, banco, stub):
        stub(PAS, get_prize_summary=lambda tid: self._resumo(ko_format="mystery"))
        banco.store["tournament_mystery_envelopes"] = [
            {"id": "e1", "tournament_id": TOUR, "value": 100, "drawn_at": None},
            {"id": "e2", "tournament_id": TOUR, "value": 200, "drawn_at": "2026-10-14T22:00:00Z"},
            {"id": "e3", "tournament_id": TOUR, "value": 50, "drawn_at": None},
            {"id": "x", "tournament_id": "outro", "value": 1, "drawn_at": None},
        ]
        assert PublicTvService.get_day_extras(DIA).mystery_envelopes_left == 2

    def test_mystery_antes_da_fase_nao_mostra_envelopes(self, banco, stub):
        stub(PAS, get_prize_summary=lambda tid: self._resumo(ko_format="mystery"))
        banco.store["tournament_mystery_envelopes"] = []
        r = PublicTvService.get_day_extras(DIA)
        assert r.ko_format == "mystery" and r.mystery_envelopes_left is None

    def test_resumo_que_falha_nao_derruba_o_telao(self, banco, stub):
        def explode(tid):
            raise RuntimeError("boom")
        stub(PAS, get_prize_summary=explode)
        r = PublicTvService.get_day_extras(DIA)
        assert r.prize_pool is None and r.ko_format == "none"


class TestListaDeEnvelopesNoTelao:
    def _resumo(self, **extra):
        base = dict(available_prize_pool=Decimal("6000"), total_prize_pool=Decimal("10000"),
                    ko_format="mystery", ko_pool=Decimal("4000"), ko_fund=Decimal("5000"))
        base.update(extra)
        return SimpleNamespace(**base)

    def test_envelopes_restantes_por_valor_e_o_fundo_com_garantido(self, banco, stub):
        stub(PAS, get_prize_summary=lambda tid: self._resumo())
        banco.store["tournament_mystery_envelopes"] = [
            {"id": "e1", "tournament_id": TOUR, "value": 1000, "drawn_at": None},
            {"id": "e2", "tournament_id": TOUR, "value": 2000, "drawn_at": None},
            {"id": "e3", "tournament_id": TOUR, "value": 1000, "drawn_at": None},
            {"id": "e4", "tournament_id": TOUR, "value": 1000, "drawn_at": "2026-10-14T22:00:00Z"},
        ]
        r = PublicTvService.get_day_extras(DIA)
        assert r.ko_pool == 5000.0
        assert r.mystery_envelopes == [{"value": 2000.0, "count": 1}, {"value": 1000.0, "count": 2}]
        assert r.mystery_envelopes_left == 3

    def test_antes_da_fase_mostra_o_nivel_de_inicio(self, banco, stub):
        stub(PAS, get_prize_summary=lambda tid: self._resumo())
        banco.store["tournament_mystery_envelopes"] = []
        banco.store["tournaments"] = [{"id": TOUR, "mystery_start_level": 13}]
        r = PublicTvService.get_day_extras(DIA)
        assert r.mystery_start_level == 13 and r.mystery_envelopes == []
