"""Relógio de mesa e time bank: o que o servidor guarda e o que ele recusa.

O relógio em si roda no tablet do dealer. O servidor guarda a configuração do
dia e o uso dos cartões, e é daí que vêm as regras presas aqui:

- **O saldo é calculado, não gravado.** Direito (iniciais + bônus dos intervalos
  já começados) mais os eventos. Sem rotina de crédito, não há cartão em dobro.
- **Reentrada recomeça os cartões.** Cada evento guarda o `rebuy_count` do
  momento, e o saldo só soma os da entrada atual.
- **Reenviar não desconta de novo.** O tablet reenvia quando a rede volta, com
  o mesmo `client_event_id`.
- **Time bank exige eliminação por mesa.** Na eliminação em massa o sistema não
  sabe quem saiu, e a lista da mesa mostraria quem já foi embora.
"""
import pytest

from app.models.table_clock import (
    CartaoUsado,
    ConfiguracaoDoRelogio,
    PedidoDeAjuste,
)
from app.models.tournament_day import TournamentDay
from app.services import table_clock_service as modulo
from app.services import time_bank_regras as regras
from app.services.table_clock_service import TableClockService as S
from app.services.tournament_day_service import TournamentDayService
from app.utils.erros import ErroDeNegocio
from tests.conftest import FakeSupabase

DIA = "dia-1"
TORNEIO = "torneio-1"
ORG = "org-1"
MESA = "mesa-1"
USUARIO = "usuario-1"

BLINDS = [
    {"level": 1, "small_blind": 100, "big_blind": 200, "ante": 0, "duration": 20, "is_break": False},
    {"level": 2, "small_blind": 200, "big_blind": 400, "ante": 400, "duration": 20, "is_break": False},
    {"level": 3, "small_blind": 0, "big_blind": 0, "ante": 0, "duration": 10, "is_break": True},
    {"level": 4, "small_blind": 300, "big_blind": 600, "ante": 600, "duration": 20, "is_break": False},
    {"level": 5, "small_blind": 0, "big_blind": 0, "ante": 0, "duration": 10, "is_break": True},
]


def _status(nivel=1, exibido=1, intervalo=False, pausado=False):
    return {
        "current_level": nivel,
        "display_level": exibido,
        "is_paused": pausado,
        "current_blind": {**BLINDS[nivel - 1], "is_break": intervalo},
        "current_level_ends_at": 1000.0,
        "server_time": 900.0,
        "time_remaining_current_level": 100,
    }


def _inscrito(tp_id, jogador, status="active", reentradas=0, nome="Ana"):
    return {
        "id": tp_id, "tournament_day_id": DIA, "tournament_id": TORNEIO, "player_id": jogador,
        "status": status, "rebuy_count": reentradas,
        "players": {"name": nome, "nickname": None},
    }


def _assento(jogador, numero, nome="Ana", mesa=MESA):
    return {
        "id": f"s-{jogador}", "table_id": mesa, "tournament_day_id": DIA, "player_id": jogador,
        "seat_number": numero, "players": {"name": nome, "nickname": None},
        "tournament_tables": {"table_number": 5},
    }


@pytest.fixture
def cenario(monkeypatch):
    """Um dia com uma mesa, Ana sentada no assento 3, relógio e banco ligados."""
    fake = FakeSupabase({
        "tournaments": [{
            "id": TORNEIO, "name": "Main Event", "organization_id": ORG, "elimination_mode": "table",
            "stage_id": "etapa-1",
        }],
        "tournament_tables": [{
            "id": MESA, "tournament_day_id": DIA, "table_number": 5, "seats": 9, "status": "active",
        }],
        "tournament_days": [{
            "id": DIA, "tournament_id": TORNEIO, "day_name": "Dia 1", "status": "active",
            "tournaments": {"name": "Main Event", "stage_id": "etapa-1"},
        }],
        "tournament_players": [_inscrito("tp1", "p1")],
        "seat_allocations": [_assento("p1", 3)],
        "table_clock_settings": [{
            "tournament_day_id": DIA, "organization_id": ORG, "enabled": True,
            "preflop_seconds": 20, "postflop_seconds": 30, "called_clock_seconds": 30,
            "start_level": 1, "time_bank_enabled": True, "card_seconds": 30,
            "initial_cards": 2, "cards_per_break": 1, "max_cards_per_decision": 6,
        }],
        "time_bank_events": [],
    })
    monkeypatch.setattr(modulo, "supabase", fake)
    dia = TournamentDay.model_construct(id=DIA, tournament_id=TORNEIO, day_name="Dia 1", current_level=1)
    monkeypatch.setattr(
        TournamentDayService, "get_day_with_stage",
        staticmethod(lambda day_id, with_blinds=False: (dia, "etapa-1", BLINDS) if day_id == DIA else (None, None, None)),
    )
    fake.status = _status()
    monkeypatch.setattr(
        TournamentDayService, "get_enriched_timer_status",
        staticmethod(lambda day_id, day=None, blinds_do_dia=None: fake.status),
    )
    return fake


def _usar(id_do_evento="e1", tp="tp1"):
    return S.usar_cartao(MESA, CartaoUsado(tournament_player_id=tp, client_event_id=id_do_evento), USUARIO)


def _uuid(n):
    return f"00000000-0000-0000-0000-{n:012d}"


class TestSaldo:
    def test_conta_os_intervalos_ja_comecados(self):
        assert regras.intervalos_passados(BLINDS, 2) == 0
        assert regras.intervalos_passados(BLINDS, 3) == 1
        assert regras.intervalos_passados(BLINDS, 5) == 2

    def test_direito_soma_iniciais_e_bonus(self):
        config = ConfiguracaoDoRelogio(initial_cards=2, cards_per_break=1)
        assert regras.direito(config, BLINDS, 1) == 2
        assert regras.direito(config, BLINDS, 4) == 3

    def test_so_a_entrada_atual_conta(self):
        eventos = [{"cards": -1, "entry_marker": 0}, {"cards": -1, "entry_marker": 1}]
        assert regras.saldo(2, eventos, 1) == 1

    def test_nunca_mostra_saldo_negativo(self):
        """Dois tablets gastando o último cartão ao mesmo tempo não viram -1 na tela."""
        assert regras.saldo(1, [{"cards": -1, "entry_marker": 0}] * 2, 0) == 0


class TestConfiguracao:
    def test_dia_sem_configuracao_vem_desligado_com_os_padroes(self, cenario):
        cenario.store["table_clock_settings"].clear()
        config = S.obter_configuracao(DIA)
        assert config.enabled is False
        assert (config.preflop_seconds, config.postflop_seconds) == (20, 30)
        assert (config.card_seconds, config.initial_cards, config.cards_per_break) == (30, 2, 1)
        assert config.max_cards_per_decision == 6

    def test_salvar_grava_o_clube_do_torneio(self, cenario):
        """`organization_id` explícito: a política do banco exige e o DEFAULT depende do JWT."""
        cenario.store["table_clock_settings"].clear()
        S.salvar_configuracao(DIA, ConfiguracaoDoRelogio(enabled=True, preflop_seconds=15))
        linha = cenario.store["table_clock_settings"][0]
        assert linha["organization_id"] == ORG
        assert linha["tournament_day_id"] == DIA
        assert linha["preflop_seconds"] == 15

    def test_salvar_de_novo_nao_duplica_o_dia(self, cenario):
        S.salvar_configuracao(DIA, ConfiguracaoDoRelogio(enabled=False))
        assert len(cenario.store["table_clock_settings"]) == 1
        assert S.obter_configuracao(DIA).enabled is False

    def test_tempo_fora_do_limite_e_recusado(self):
        with pytest.raises(ValueError):
            ConfiguracaoDoRelogio(preflop_seconds=2)


class TestDiasAbertos:
    def test_encerrado_nao_aparece(self, cenario):
        cenario.store["tournament_days"].append({
            "id": "dia-2", "tournament_id": TORNEIO, "day_name": "Dia 2", "status": "completed",
            "tournaments": {"name": "Main Event"},
        })
        assert [d["id"] for d in S.dias_abertos()] == [DIA]

    def test_pendente_aparece_para_preparar_o_tablet(self, cenario):
        """O dia só vira ativo quando o relógio de blinds liga."""
        cenario.store["tournament_days"][0]["status"] = "pending"
        assert [d["id"] for d in S.dias_abertos()] == [DIA]

    def test_nao_lista_mais_do_que_o_limite(self, cenario):
        cenario.store["tournament_days"] = [
            {"id": f"d{i}", "status": "pending", "created_at": f"2026-10-{i:02d}", "tournaments": {}}
            for i in range(1, 29)
        ] * 2
        assert len(S.dias_abertos()) == modulo.LIMITE_DE_DIAS_NA_LISTA

    def test_traz_o_nome_do_torneio(self, cenario):
        assert S.dias_abertos()[0]["tournament_name"] == "Main Event"

    def test_diz_se_o_dia_ja_comecou(self, cenario):
        """O tablet mostra "em andamento" ou "ainda não começou" ao lado do dia."""
        assert S.dias_abertos()[0]["status"] == "active"

    def _outra_etapa(self, cenario):
        cenario.store["tournaments"].append({"id": "torneio-2", "name": "Turbo", "stage_id": "etapa-2"})
        cenario.store["tournament_days"].append({
            "id": "dia-9", "tournament_id": "torneio-2", "day_name": "Dia 1", "status": "active",
            "tournaments": {"name": "Turbo"},
        })

    def test_com_etapa_so_lista_os_dias_dela(self, cenario):
        self._outra_etapa(cenario)
        assert [d["id"] for d in S.dias_abertos("etapa-1")] == [DIA]
        assert [d["id"] for d in S.dias_abertos("etapa-2")] == ["dia-9"]

    def test_sem_etapa_lista_todas(self, cenario):
        self._outra_etapa(cenario)
        assert sorted(d["id"] for d in S.dias_abertos()) == sorted([DIA, "dia-9"])

    def test_etapa_sem_torneio_nao_lista_nada(self, cenario):
        assert S.dias_abertos("etapa-vazia") == []


class TestEstadoDaMesa:
    def test_mostra_quem_esta_sentado_com_os_cartoes(self, cenario):
        estado = S.estado_da_mesa(MESA)
        assert estado["seats"] == [{
            "seat_number": 3, "tournament_player_id": "tp1", "name": "Ana", "nickname": None, "cards": 2,
        }]
        assert estado["time_bank"] == {"available": True, "reason": None}

    def test_mesa_inexistente_e_recusada(self, cenario):
        with pytest.raises(ErroDeNegocio) as erro:
            S.estado_da_mesa("nao-existe")
        assert erro.value.code == "mesa_nao_encontrada"

    def test_entrega_o_nivel_e_a_hora_do_servidor(self, cenario):
        cenario.status = _status(nivel=2, exibido=2)
        timer = S.estado_da_mesa(MESA)["timer"]
        assert (timer["level"], timer["big_blind"], timer["ante"]) == (2, 400, 400)
        assert (timer["level_ends_at"], timer["server_time"]) == (1000.0, 900.0)

    def test_intervalo_chega_ao_tablet(self, cenario):
        cenario.status = _status(nivel=3, exibido=2, intervalo=True)
        assert S.estado_da_mesa(MESA)["timer"]["is_break"] is True

    def test_o_bonus_do_intervalo_entra_sozinho(self, cenario):
        cenario.status = _status(nivel=3, exibido=2, intervalo=True)
        assert S.estado_da_mesa(MESA)["seats"][0]["cards"] == 3

    def test_dia_sem_blinds_proprios_conta_os_intervalos_do_torneio(self, cenario, monkeypatch):
        dia = TournamentDay.model_construct(id=DIA, tournament_id=TORNEIO, day_name="Dia 1")
        monkeypatch.setattr(
            TournamentDayService, "get_day_with_stage",
            staticmethod(lambda day_id, with_blinds=False: (dia, "etapa-1", [])),
        )
        monkeypatch.setattr(
            TournamentDayService, "_get_all_blinds",
            staticmethod(lambda day_id, tournament_id, blinds_do_dia=None: BLINDS),
        )
        cenario.status = _status(nivel=3, exibido=2, intervalo=True)
        assert S.estado_da_mesa(MESA)["seats"][0]["cards"] == 3

    def test_antes_do_nivel_de_inicio_o_relogio_nao_esta_ativo(self, cenario):
        cenario.store["table_clock_settings"][0]["start_level"] = 3
        cenario.status = _status(nivel=4, exibido=3)
        assert S.estado_da_mesa(MESA)["clock_active"] is True
        cenario.status = _status(nivel=2, exibido=2)
        assert S.estado_da_mesa(MESA)["clock_active"] is False

    def test_desligado_no_dia_nao_esta_ativo(self, cenario):
        cenario.store["table_clock_settings"][0]["enabled"] = False
        assert S.estado_da_mesa(MESA)["clock_active"] is False

    def test_eliminacao_em_massa_fica_sem_time_bank(self, cenario):
        cenario.store["tournaments"][0]["elimination_mode"] = "bulk"
        estado = S.estado_da_mesa(MESA)
        assert estado["time_bank"] == {"available": False, "reason": "eliminacao_em_massa"}
        assert estado["seats"] == []

    def test_banco_desligado_ainda_mostra_quem_esta_na_mesa(self, cenario):
        """A mesa desenhada no tablet precisa dos nomes com ou sem cartões."""
        cenario.store["table_clock_settings"][0]["time_bank_enabled"] = False
        estado = S.estado_da_mesa(MESA)
        assert estado["time_bank"] == {"available": False, "reason": "desligado"}
        assert [a["name"] for a in estado["seats"]] == ["Ana"]

    def test_entrega_os_assentos_bloqueados(self, cenario):
        cenario.store["tournament_tables"][0]["blocked_seats"] = [4, 9]
        assert S.estado_da_mesa(MESA)["table"]["blocked_seats"] == [4, 9]

    def test_mesa_sem_bloqueio_vem_com_lista_vazia(self, cenario):
        assert S.estado_da_mesa(MESA)["table"]["blocked_seats"] == []

    def test_entrega_o_tempo_do_nivel_para_o_relogio_pausado(self, cenario):
        """Pausado não há fim do nível: sem o tempo restante, o centro da mesa ficaria vazio."""
        assert S.estado_da_mesa(MESA)["timer"]["time_remaining"] == 100

    def test_eliminado_ainda_sentado_nao_aparece(self, cenario):
        cenario.store["tournament_players"][0]["status"] = "eliminated"
        assert S.estado_da_mesa(MESA)["seats"] == []


class TestUsarCartao:
    def test_desconta_e_devolve_o_saldo(self, cenario):
        resposta = _usar(_uuid(1))
        assert resposta["cards"] == 1
        evento = cenario.store["time_bank_events"][0]
        assert (evento["kind"], evento["cards"], evento["organization_id"]) == ("use", -1, ORG)
        assert (evento["table_id"], evento["seat_number"], evento["created_by"]) == (MESA, 3, USUARIO)

    def test_reenviar_o_mesmo_evento_nao_desconta_de_novo(self, cenario):
        """A rede caiu depois de gravar: o tablet não viu a resposta e manda outra vez."""
        primeira = _usar(_uuid(1))
        segunda = _usar(_uuid(1))
        assert segunda == primeira
        assert len(cenario.store["time_bank_events"]) == 1

    def test_sem_cartao_e_recusado(self, cenario):
        _usar(_uuid(1))
        _usar(_uuid(2))
        with pytest.raises(ErroDeNegocio) as erro:
            _usar(_uuid(3))
        assert erro.value.code == "sem_cartoes"
        assert len(cenario.store["time_bank_events"]) == 2

    def test_jogador_de_outro_dia_e_recusado(self, cenario):
        cenario.store["tournament_players"].append({**_inscrito("tp9", "p9"), "tournament_day_id": "dia-9"})
        with pytest.raises(ErroDeNegocio) as erro:
            _usar(_uuid(1), tp="tp9")
        assert erro.value.code == "jogador_fora_do_dia"

    def test_eliminacao_em_massa_recusa(self, cenario):
        cenario.store["tournaments"][0]["elimination_mode"] = "bulk"
        with pytest.raises(ErroDeNegocio) as erro:
            _usar(_uuid(1))
        assert erro.value.code == "time_bank_indisponivel"

    def test_banco_desligado_recusa(self, cenario):
        cenario.store["table_clock_settings"][0]["time_bank_enabled"] = False
        with pytest.raises(ErroDeNegocio) as erro:
            _usar(_uuid(1))
        assert erro.value.code == "time_bank_indisponivel"

    def test_reentrada_recomeca_os_cartoes(self, cenario):
        _usar(_uuid(1))
        _usar(_uuid(2))
        assert S.estado_da_mesa(MESA)["seats"][0]["cards"] == 0
        cenario.store["tournament_players"][0]["rebuy_count"] = 1
        assert S.estado_da_mesa(MESA)["seats"][0]["cards"] == 2

    def test_estornar_a_reentrada_devolve_o_saldo_anterior(self, cenario):
        _usar(_uuid(1))
        cenario.store["tournament_players"][0]["rebuy_count"] = 1
        assert S.estado_da_mesa(MESA)["seats"][0]["cards"] == 2
        cenario.store["tournament_players"][0]["rebuy_count"] = 0
        assert S.estado_da_mesa(MESA)["seats"][0]["cards"] == 1

    def test_jogador_sem_assento_ainda_pode_gastar(self, cenario):
        """Trocou de mesa enquanto o tablet estava sem rede: o gasto vale assim mesmo."""
        cenario.store["seat_allocations"].clear()
        assert _usar(_uuid(1))["cards"] == 1
        assert cenario.store["time_bank_events"][0]["seat_number"] is None


class TestDesfazer:
    def test_devolve_o_cartao(self, cenario):
        usado = _usar(_uuid(1))
        assert S.desfazer_uso(usado["event_id"], USUARIO)["cards"] == 2
        desfeito = cenario.store["time_bank_events"][1]
        assert (desfeito["kind"], desfeito["cards"]) == ("undo", 1)
        assert desfeito["undoes_event_id"] == usado["event_id"]

    def test_desfazer_duas_vezes_nao_da_cartao_extra(self, cenario):
        usado = _usar(_uuid(1))
        S.desfazer_uso(usado["event_id"], USUARIO)
        assert S.desfazer_uso(usado["event_id"], USUARIO)["cards"] == 2
        assert len(cenario.store["time_bank_events"]) == 2

    def test_evento_inexistente_e_recusado(self, cenario):
        with pytest.raises(ErroDeNegocio) as erro:
            S.desfazer_uso("nao-existe", USUARIO)
        assert erro.value.code == "evento_nao_encontrado"

    def test_so_desfaz_uso(self, cenario):
        ajuste = S.ajustar(DIA, "tp1", PedidoDeAjuste(cards=1, reason="Erro do dealer"), USUARIO)
        with pytest.raises(ErroDeNegocio) as erro:
            S.desfazer_uso(ajuste["event_id"], USUARIO)
        assert erro.value.code == "evento_nao_desfazivel"


class TestAjuste:
    def test_soma_e_guarda_o_motivo(self, cenario):
        resposta = S.ajustar(DIA, "tp1", PedidoDeAjuste(cards=2, reason="Cortesia do diretor"), USUARIO)
        assert resposta["cards"] == 4
        evento = cenario.store["time_bank_events"][0]
        assert (evento["kind"], evento["reason"]) == ("adjust", "Cortesia do diretor")

    def test_tira_cartao(self, cenario):
        assert S.ajustar(DIA, "tp1", PedidoDeAjuste(cards=-1, reason="Punição"), USUARIO)["cards"] == 1

    def test_ajuste_zero_e_recusado(self):
        with pytest.raises(ValueError):
            PedidoDeAjuste(cards=0, reason="x")

    def test_motivo_e_obrigatorio(self):
        with pytest.raises(ValueError):
            PedidoDeAjuste(cards=1, reason="   ")

    def test_jogador_de_outro_dia_e_recusado(self, cenario):
        cenario.store["tournament_players"].append({**_inscrito("tp9", "p9"), "tournament_day_id": "dia-9"})
        with pytest.raises(ErroDeNegocio) as erro:
            S.ajustar(DIA, "tp9", PedidoDeAjuste(cards=1, reason="x"), USUARIO)
        assert erro.value.code == "jogador_fora_do_dia"


class TestPainel:
    def test_lista_ativos_com_mesa_assento_e_saldo(self, cenario):
        _usar(_uuid(1))
        cenario.store["tournament_players"].append(_inscrito("tp2", "p2", status="eliminated", nome="Bia"))
        painel = S.painel_do_dia(DIA)
        assert painel["players"] == [{
            "tournament_player_id": "tp1", "name": "Ana", "nickname": None,
            "table_number": 5, "seat_number": 3, "cards": 1, "used": 1,
        }]
        assert painel["entitled"] == 2

    def test_jogador_sem_assento_fica_na_lista(self, cenario):
        cenario.store["seat_allocations"].clear()
        linha = S.painel_do_dia(DIA)["players"][0]
        assert (linha["table_number"], linha["seat_number"]) == (None, None)

    def test_eliminacao_em_massa_avisa(self, cenario):
        cenario.store["tournaments"][0]["elimination_mode"] = "bulk"
        painel = S.painel_do_dia(DIA)
        assert painel["time_bank"] == {"available": False, "reason": "eliminacao_em_massa"}
        assert painel["players"] == []


class TestHistorico:
    def test_do_mais_novo_para_o_mais_velho_com_nome_e_mesa(self, cenario):
        cenario.store["time_bank_events"] = [
            {"id": "a", "tournament_day_id": DIA, "tournament_player_id": "tp1", "kind": "use", "cards": -1,
             "seat_number": 3, "level": 2, "reason": None, "created_at": "2026-11-06T20:00:00Z",
             "tournament_players": {"players": {"name": "Ana"}}, "tournament_tables": {"table_number": 5}},
            {"id": "b", "tournament_day_id": DIA, "tournament_player_id": "tp1", "kind": "undo", "cards": 1,
             "seat_number": 3, "level": 2, "reason": None, "created_at": "2026-11-06T20:01:00Z",
             "tournament_players": {"players": {"name": "Ana"}}, "tournament_tables": {"table_number": 5}},
        ]
        eventos = S.historico(DIA)
        assert [e["id"] for e in eventos] == ["b", "a"]
        assert (eventos[0]["player_name"], eventos[0]["table_number"]) == ("Ana", 5)


class TestRotas:
    def test_estado_da_mesa_responde(self, client, stub):
        stub(S, estado_da_mesa=lambda table_id: {"seats": [], "table_id": table_id})
        resposta = client.get(f"/table-clock/table/{MESA}")
        assert resposta.status_code == 200
        assert resposta.json()["table_id"] == MESA

    def test_recusa_vira_codigo_para_a_tela_traduzir(self, client, stub):
        def recusa(*_):
            raise ErroDeNegocio("sem_cartoes", "Este jogador não tem cartões.", status=409)
        stub(S, usar_cartao=recusa)
        resposta = client.post(
            f"/table-clock/table/{MESA}/cards",
            json={"tournament_player_id": "tp1", "client_event_id": _uuid(1)},
        )
        assert resposta.status_code == 409
        assert resposta.json()["detail"]["code"] == "sem_cartoes"

    def test_uso_passa_quem_operou(self, client, stub):
        pedidos = []
        stub(S, usar_cartao=lambda mesa, dados, usuario: pedidos.append((mesa, usuario)) or {"cards": 1})
        client.post(
            f"/table-clock/table/{MESA}/cards",
            json={"tournament_player_id": "tp1", "client_event_id": _uuid(1)},
        )
        assert pedidos == [(MESA, client.usuario["sub"])]

    def test_dealer_opera_mas_nao_configura(self, client, monkeypatch, stub):
        """A chave do dealer abre o tablet e nada além dele."""
        from app.models.staff import MyPermissions
        from app.services.staff_service import StaffService

        monkeypatch.setattr(
            StaffService, "get_my_permissions",
            staticmethod(lambda uid: MyPermissions(is_admin=False, permissions=["table_clock"])),
        )
        stub(S, estado_da_mesa=lambda table_id: {"seats": []})
        assert client.get(f"/table-clock/table/{MESA}").status_code == 200
        assert client.put(f"/table-clock/day/{DIA}/settings", json={"enabled": True}).status_code == 403
        assert client.get(f"/table-clock/day/{DIA}/panel").status_code == 403
        ajuste = client.post(
            f"/table-clock/day/{DIA}/players/tp1/adjust", json={"cards": 1, "reason": "x"},
        )
        assert ajuste.status_code == 403

    def test_sem_nenhuma_chave_nao_abre_o_tablet(self, client, monkeypatch):
        from app.models.staff import MyPermissions
        from app.services.staff_service import StaffService

        monkeypatch.setattr(
            StaffService, "get_my_permissions",
            staticmethod(lambda uid: MyPermissions(is_admin=False, permissions=["cashier"])),
        )
        assert client.get(f"/table-clock/table/{MESA}").status_code == 403

    def test_lista_de_dias_usa_a_etapa_do_cabecalho(self, client, stub):
        pedidos = []
        stub(S, dias_abertos=lambda stage_id=None: pedidos.append(stage_id) or [])
        client.get("/table-clock/days", headers={"X-Stage-ID": "etapa-1"})
        client.get("/table-clock/days")
        assert pedidos == ["etapa-1", None]

    def test_a_chave_nova_esta_na_lista_de_permissoes(self):
        from app.services.staff_service import ALL_PERMISSIONS

        assert "table_clock" in ALL_PERMISSIONS
