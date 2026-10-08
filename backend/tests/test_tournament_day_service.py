"""Testes do serviço de dia de torneio, além do cálculo puro de nível.

Complementa `test_tournament_day.py` (que cobre a matemática do relógio)
com o que depende do banco: agregação de entradas, avanço de
classificados, status do torneio derivado dos dias, e o status enriquecido
que a TV consulta em loop.

Dois pontos concentram o risco:

- **A agregação em lote.** `_entries_by_day` e o resumo por dia existem
  para NÃO fazer uma consulta por dia (N+1). O teste com vários dias fixa
  o resultado; se alguém voltar ao laço, os números continuam certos, mas
  o teste de contagem de round-trips acusa.
- **O cache de 60s do status enriquecido.** Ele guarda chipcount e
  entradas entre os polls de 3s da TV. Um cache com chave errada mostra o
  chipcount de um dia na tela de outro.
"""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app.models.tournament_day import TournamentDayCreate, TournamentDayUpdate
from app.services import tournament_day_service as mod
from app.services.tournament_day_service import TournamentDayService as S

from tests.conftest import FakeSupabase


TOUR = "22222222-2222-2222-2222-222222222222"
D1 = "77777777-7777-7777-7777-777777777771"
D2 = "77777777-7777-7777-7777-777777777772"
FINAL = "77777777-7777-7777-7777-7777777777ff"


def _dia(id_=D1, **kw):
    base = {
        "id": id_, "tournament_id": TOUR, "day_name": "Dia 1", "day_number": 1,
        "buy_in": 100, "max_players": 200, "status": "pending",
        "starting_chips": 10000, "rebuy_chips": 10000, "addon_chips": 5000,
        "registered_players": 0, "total_entries": 0, "prize_pool": 0,
        "eliminations_count": 0, "current_level": 1, "elapsed_time": 0,
        "is_paused": True, "timer_started_at": None, "manual_time_adjustment": 0,
        "day_type": "regular", "qualifies_to_day_id": None,
        "tournament_date": "2026-06-08T20:00:00Z",
        "created_at": "2026-06-08T00:00:00Z",
    }
    base.update(kw)
    return base


def _jogador(dia=D1, buy=1, rebuy=0, addon=0, status="active", fichas=10000, **kw):
    base = {
        "id": f"tp-{dia}-{buy}-{rebuy}-{addon}-{status}", "tournament_id": TOUR,
        "tournament_day_id": dia, "player_id": "p1", "status": status,
        "buy_in_count": buy, "rebuy_count": rebuy, "addon_count": addon,
        "total_buy_in_amount": 100.0 * buy, "total_rebuy_amount": 100.0 * rebuy,
        "total_addon_amount": 50.0 * addon, "total_chips": fichas,
        "is_qualified_entry": False,
    }
    base.update(kw)
    return base


@pytest.fixture(autouse=True)
def cache_limpo():
    """O cache de agregados é módulo-global: sem limpar, um teste enxerga o
    número do anterior."""
    mod._chipcount_cache.clear()
    yield
    mod._chipcount_cache.clear()


def _monta(monkeypatch, **tabelas):
    base = {
        "tournament_days": [_dia()],
        "tournament_players": [],
        "tournaments": [{"id": TOUR, "name": "Torneio", "status": "pending"}],
        "blinds": [],
    }
    base.update(tabelas)
    fake = FakeSupabase(base)
    monkeypatch.setattr(mod, "supabase", fake)
    return fake


class TestJogadoresSeparadoDeReentradas:
    """Recompra e add-on NAO criam jogador novo.

    Reclamacao do dono do clube: "os rebuys e addons estao entrando como sendo
    novos jogadores, aumentando a contagem de um torneio". O banco sempre esteve
    certo — `registered_players` bate com os buy-ins —, mas a agregacao somava
    buy_in_count + rebuy_count num numero so, e a tela mostrava isso ao lado de
    um icone de pessoas. Quem recompra tres vezes continua sendo UMA pessoa.

    Detalhe que mostra o tamanho da confusao: o numero antigo somava recompra e
    IGNORAVA add-on. Nao era jogadores nem entradas.

    REENTRADA e so a recompra (regra do diretor): ela traz um eliminado de
    volta. O add-on compra fichas para quem ja esta na mesa e nao conta em
    nenhum dos dois numeros da tela.
    """

    def _um_jogador(self, buy_ins=1, rebuys=0, addons=0, status="active"):
        return {
            "id": f"tp-{buy_ins}-{rebuys}-{addons}-{status}",
            "tournament_day_id": D1, "tournament_id": TOUR,
            "buy_in_count": buy_ins, "rebuy_count": rebuys, "addon_count": addons,
            "status": status,
        }

    def test_quem_recompra_continua_sendo_um_jogador(self, monkeypatch):
        """Um jogador com 3 recompras e 1 add-on: 1 pessoa, 3 reentradas."""
        _monta(monkeypatch, tournament_players=[
            self._um_jogador(buy_ins=1, rebuys=3, addons=1),
        ])
        entradas, reentradas = S._entries_by_day([D1])
        assert entradas[D1] == 1      # uma entrada: o buy-in
        assert reentradas[D1] == 3    # as 3 recompras; o add-on fica fora

    def test_add_on_nao_e_reentrada(self, monkeypatch):
        """Add-on nao traz ninguem de volta: so fichas e dinheiro."""
        _monta(monkeypatch, tournament_players=[
            self._um_jogador(buy_ins=1, rebuys=0, addons=2),
        ])
        entradas, reentradas = S._entries_by_day([D1])
        assert entradas[D1] == 1
        assert reentradas[D1] == 0

    def test_dia_sem_reentrada_devolve_zero(self, monkeypatch):
        _monta(monkeypatch, tournament_players=[
            self._um_jogador(buy_ins=1),
            self._um_jogador(buy_ins=1, status="eliminated"),
        ])
        _, reentradas = S._entries_by_day([D1])
        assert reentradas.get(D1, 0) == 0

    def test_dois_inscritos_e_cinco_recompras_sao_duas_entradas(self, monkeypatch):
        """O caso exato que o dono do clube mandou por print.

        A tela mostrava ENTRADAS 7 e REENTRADAS 5 num torneio de DOIS inscritos.
        O 7 era buy-ins + recompras somados; o torneio parecia ter tres vezes
        mais gente do que tinha. Entrada e buy-in: sao 2. As 5 recompras ja
        estao no campo ao lado."""
        _monta(monkeypatch, tournament_players=[
            self._um_jogador(buy_ins=1, rebuys=3),
            self._um_jogador(buy_ins=1, rebuys=2),
        ])
        dia = S.get_tournament_day(D1)
        assert dia.total_entries == 2
        assert dia.total_reentries == 5

    def test_o_dia_devolve_as_reentradas_separadas(self, monkeypatch):
        """O campo chega na tela: sem ele o front nao tem como separar."""
        _monta(monkeypatch, tournament_players=[
            self._um_jogador(buy_ins=1, rebuys=2, addons=1),
        ])
        dia = S.get_tournament_day(D1)
        assert dia.total_reentries == 2   # as recompras; o add-on fica fora


class TestCodigoDeTV:
    def test_resolve_o_codigo_para_o_dia(self, monkeypatch):
        _monta(monkeypatch, tournament_days=[_dia(
            broadcast_code="ABC234", tournaments={"name": "Torneio"})])
        r = S.resolve_broadcast_code("abc234")
        assert r["day_id"] == D1
        assert r["tournament_name"] == "Torneio"

    def test_codigo_e_normalizado_para_maiusculo(self, monkeypatch):
        """Quem digita na TV não vai se preocupar com caixa."""
        _monta(monkeypatch, tournament_days=[_dia(broadcast_code="ABC234")])
        assert S.resolve_broadcast_code("  abc234  ")["day_id"] == D1

    @pytest.mark.parametrize("entrada", ["", "   ", None])
    def test_codigo_vazio_e_recusado(self, monkeypatch, entrada):
        _monta(monkeypatch)
        with pytest.raises(ValueError, match="inválido"):
            S.resolve_broadcast_code(entrada)

    def test_codigo_desconhecido_e_recusado(self, monkeypatch):
        _monta(monkeypatch, tournament_days=[_dia(broadcast_code="ABC234")])
        with pytest.raises(ValueError, match="inválido"):
            S.resolve_broadcast_code("ZZZZZZ")


class TestStatusDoTorneioDerivadoDosDias:
    """O torneio não tem status próprio editável: ele é consequência dos
    dias. Um torneio "pendente" com um dia rodando some da tela de quem
    está operando."""

    def test_um_dia_ativo_torna_o_torneio_ativo(self, monkeypatch):
        fake = _monta(monkeypatch, tournament_days=[
            _dia(D1, status="completed"), _dia(D2, status="active")])
        S._sync_tournament_status(TOUR)
        assert fake.store["tournaments"][0]["status"] == "active"

    def test_todos_encerrados_encerra_o_torneio(self, monkeypatch):
        fake = _monta(monkeypatch, tournament_days=[
            _dia(D1, status="completed"), _dia(D2, status="cancelled")])
        S._sync_tournament_status(TOUR)
        assert fake.store["tournaments"][0]["status"] == "completed"

    def test_so_cancelados_nao_conta_como_concluido(self, monkeypatch):
        """Um torneio cujos dias foram todos cancelados não "aconteceu"."""
        fake = _monta(monkeypatch, tournament_days=[_dia(D1, status="cancelled")])
        S._sync_tournament_status(TOUR)
        assert fake.store["tournaments"][0]["status"] == "pending"

    def test_dia_pendente_mantem_o_torneio_pendente(self, monkeypatch):
        fake = _monta(monkeypatch, tournament_days=[
            _dia(D1, status="pending"), _dia(D2, status="completed")])
        S._sync_tournament_status(TOUR)
        assert fake.store["tournaments"][0]["status"] == "pending"

    def test_torneio_sem_dias_nao_e_tocado(self, monkeypatch):
        fake = _monta(monkeypatch, tournament_days=[])
        S._sync_tournament_status(TOUR)
        assert fake.store["tournaments"][0]["status"] == "pending"


class TestCriacaoELeitura:
    def test_dia_nasce_zerado_e_pendente(self, monkeypatch):
        """Os contadores são derivados; nascer com outro valor criaria uma
        divergência que nenhum trigger corrige depois."""
        fake = _monta(monkeypatch, tournament_days=[])
        dia = S.create_tournament_day(TournamentDayCreate(
            tournament_id=TOUR, day_name="Dia 1", buy_in=100, max_players=50))
        assert dia.status == "pending"
        assert fake.store["tournament_days"][0]["prize_pool"] == 0
        assert fake.store["tournament_days"][0]["registered_players"] == 0

    def test_entradas_sao_somadas_numa_consulta_para_todos_os_dias(self, monkeypatch):
        """ENTRADA = buy-in. So isso.

        Quem recompra nao entrou de novo no torneio: ele voltou para dentro
        dele, disputando a mesma vaga. Um dia com 2 inscritos e 3 recompras tem
        2 ENTRADAS e 3 REENTRADAS — a tela mostrava 5, e o operador reclamou com
        razao que o torneio parecia ter o dobro de gente.

        Add-on tambem nao e entrada: e ficha extra para quem ja esta na mesa.
        """
        _monta(monkeypatch,
               tournament_days=[_dia(D1), _dia(D2, day_number=2)],
               tournament_players=[
                   _jogador(D1, buy=1, rebuy=2, addon=5),
                   _jogador(D1, buy=1, rebuy=0),
                   _jogador(D2, buy=1, rebuy=1),
               ])
        dias = {d.id: d for d in S.get_tournament_days(TOUR)}
        assert {i: d.total_entries for i, d in dias.items()} == {D1: 2, D2: 1}
        # E as recompras nao somem: elas tem campo proprio.
        assert dias[D1].total_reentries == 2   # as 2 recompras; add-on fica fora
        assert dias[D2].total_reentries == 1

    def test_filtra_por_varios_status_de_uma_vez(self, monkeypatch):
        _monta(monkeypatch, tournament_days=[
            _dia(D1, status="active"), _dia(D2, status="completed", day_number=2),
            _dia(FINAL, status="cancelled", day_number=3)])
        r = S.get_tournament_days(TOUR, status="active,completed")
        assert {d.id for d in r} == {D1, D2}

    def test_sem_dias_devolve_lista_vazia(self, monkeypatch):
        _monta(monkeypatch, tournament_days=[])
        assert S.get_tournament_days(TOUR) == []

    def test_busca_um_dia_com_as_entradas(self, monkeypatch):
        _monta(monkeypatch, tournament_players=[_jogador(D1, buy=1, rebuy=3)])
        dia = S.get_tournament_day(D1)
        assert dia.total_entries == 1      # uma entrada: o buy-in
        assert dia.total_reentries == 3    # as tres recompras, em campo proprio

    def test_pode_pular_a_contagem_de_entradas(self, monkeypatch):
        """Os comandos do relógio não usam total_entries; pular a varredura
        economiza um round-trip no endpoint mais chamado do sistema."""
        _monta(monkeypatch, tournament_players=[_jogador(D1, buy=1, rebuy=3)])
        assert S.get_tournament_day(D1, include_entries=False).total_entries == 0

    def test_dia_inexistente_devolve_none(self, monkeypatch):
        _monta(monkeypatch)
        assert S.get_tournament_day("nao-existe") is None

    def test_dia_com_etapa_numa_consulta_so(self, monkeypatch):
        _monta(monkeypatch, tournament_days=[_dia(
            D1, tournaments={"stage_id": "etapa-1"})])
        dia, etapa = S.get_day_with_stage(D1)
        assert dia.id == D1
        assert etapa == "etapa-1"

    def test_dia_com_etapa_inexistente(self, monkeypatch):
        _monta(monkeypatch, tournament_days=[])
        assert S.get_day_with_stage("nao-existe") == (None, None)

    def test_dia_sem_torneio_embutido_nao_quebra(self, monkeypatch):
        _monta(monkeypatch, tournament_days=[_dia(D1, tournaments=None)])
        dia, etapa = S.get_day_with_stage(D1)
        assert dia is not None
        assert etapa is None


class TestResumoPorDia:
    def test_usa_a_rpc_quando_ela_existe(self, monkeypatch):
        fake = _monta(monkeypatch)
        fake.rpcs["get_tournament_day_summaries"] = [{
            "id": D1, "tournament_id": TOUR, "day_name": "Dia 1", "day_number": 1,
            "status": "pending", "buy_in": 100, "registered_players": 3,
            "max_players": 200, "prize_pool": 240, "tournament_date": None,
            "created_at": "2026-06-08T00:00:00Z",
        }]
        r = S.get_tournament_day_summary(TOUR)
        assert len(r) == 1
        assert r[0].registered_players == 3

    def test_sem_a_rpc_cai_no_caminho_em_lote(self, monkeypatch):
        """A RPC pode não estar no banco de um cliente que ainda não migrou;
        o resultado tem de ser o mesmo, só com mais round-trips."""
        _monta(monkeypatch,
               tournament_days=[_dia(D1), _dia(D2, day_number=2)],
               tournament_players=[
                   _jogador(D1, buy=2, rebuy=1, addon=3),
                   _jogador(D2, buy=1, rebuy=0, addon=0),
               ])
        r = {s.id: s for s in S.get_tournament_day_summary(TOUR)}
        assert r[D1].total_buy_ins == 2
        assert r[D1].total_rebuys == 1
        assert r[D1].total_addons == 3
        assert r[D1].total_entries == 2       # so os buy-ins
        assert r[D2].total_entries == 1

    def test_resumo_de_um_dia_especifico(self, monkeypatch):
        _monta(monkeypatch, tournament_days=[_dia(D1), _dia(D2, day_number=2)])
        r = S._get_tournament_day_summary_batched(day_id=D2)
        assert [s.id for s in r] == [D2]

    def test_sem_dias_o_resumo_e_vazio(self, monkeypatch):
        _monta(monkeypatch, tournament_days=[])
        assert S._get_tournament_day_summary_batched(TOUR) == []


class TestEdicaoEExclusao:
    def test_marcar_como_ativo_grava_o_horario_de_inicio(self, monkeypatch):
        fake = _monta(monkeypatch)
        S.update_tournament_day(D1, TournamentDayUpdate(status="active"))
        assert fake.store["tournament_days"][0]["start_time"] is not None

    def test_mudar_o_status_do_dia_repercute_no_torneio(self, monkeypatch):
        fake = _monta(monkeypatch)
        S.update_tournament_day(D1, TournamentDayUpdate(status="active"))
        assert fake.store["tournaments"][0]["status"] == "active"

    def test_edicao_comum_nao_mexe_no_torneio(self, monkeypatch):
        fake = _monta(monkeypatch)
        S.update_tournament_day(D1, TournamentDayUpdate(day_name="Outro"))
        assert fake.store["tournaments"][0]["status"] == "pending"

    def test_dia_inexistente_devolve_none(self, monkeypatch):
        _monta(monkeypatch, tournament_days=[])
        assert S.update_tournament_day(D1, TournamentDayUpdate(day_name="X")) is None

    def test_coluna_inexistente_e_descartada_e_o_resto_salva(self, monkeypatch):
        """Um cliente que ainda não rodou a migração não pode ficar sem
        conseguir salvar NADA por causa de uma coluna nova."""
        fake = _monta(monkeypatch)
        original = fake.table
        estados = {"primeira": True}

        def _table(nome):
            if nome == "tournament_days" and estados["primeira"]:
                estados["primeira"] = False
                raise Exception('column "broadcast_prize_size" does not exist')
            return original(nome)

        monkeypatch.setattr(fake, "table", _table)
        r = S.update_tournament_day(
            D1, TournamentDayUpdate(day_name="Novo", broadcast_prize_size=150))
        assert r is not None
        assert fake.store["tournament_days"][0]["day_name"] == "Novo"

    def test_grava_a_logo_do_clube_no_dia(self, monkeypatch):
        """A logo do clube e configuracao POR DIA, como o resto do visual do
        telao: cada dia da etapa pode ter a marca de um patrocinador."""
        fake = _monta(monkeypatch)
        S.update_tournament_day(D1, TournamentDayUpdate(
            broadcast_club_logo_url="https://clube.com/logo.png",
            broadcast_club_logo_size=150,
        ))
        salvo = fake.store["tournament_days"][0]
        assert salvo["broadcast_club_logo_url"] == "https://clube.com/logo.png"
        assert salvo["broadcast_club_logo_size"] == 150

    def test_coluna_da_logo_ausente_nao_impede_salvar_o_resto(self, monkeypatch):
        """Ate a migracao rodar, quem editar a transmissao nao pode perder as
        outras alteracoes por causa da coluna nova."""
        fake = _monta(monkeypatch)
        original = fake.table
        estados = {"primeira": True}

        def _table(nome):
            if nome == "tournament_days" and estados["primeira"]:
                estados["primeira"] = False
                raise Exception('column "broadcast_club_logo_url" does not exist')
            return original(nome)

        monkeypatch.setattr(fake, "table", _table)
        r = S.update_tournament_day(D1, TournamentDayUpdate(
            day_name="Novo", broadcast_club_logo_url="https://clube.com/logo.png"))
        assert r is not None
        assert fake.store["tournament_days"][0]["day_name"] == "Novo"

    def test_erro_que_nao_e_de_coluna_sobe(self, monkeypatch):
        fake = _monta(monkeypatch)

        def _table(nome):
            raise Exception("connection reset by peer")

        monkeypatch.setattr(fake, "table", _table)
        arg = TournamentDayUpdate(day_name="X")
        with pytest.raises(Exception, match="connection reset"):
            S.update_tournament_day(D1, arg)

    def test_apaga(self, monkeypatch):
        fake = _monta(monkeypatch)
        assert S.delete_tournament_day(D1) is True
        assert fake.store["tournament_days"] == []

    def test_apagar_inexistente_devolve_false(self, monkeypatch):
        _monta(monkeypatch, tournament_days=[])
        assert S.delete_tournament_day(D1) is False

    def test_dias_de_um_torneio(self, monkeypatch):
        _monta(monkeypatch, tournament_days=[_dia(D1), _dia(D2, day_number=2)])
        assert len(S.get_days_by_tournament(TOUR)) == 2


class TestSobreviventesEAvanco:
    def test_lista_quem_nao_foi_eliminado(self, monkeypatch):
        _monta(monkeypatch, tournament_players=[
            _jogador(D1, status="active"), _jogador(D1, status="eliminated", buy=2)])
        r = S.get_survivors(D1)
        assert len(r) == 1
        assert r[0]["status"] == "active"

    def test_inscricao_estornada_nao_e_sobrevivente(self, monkeypatch):
        """Cancelar a venda devolveu o dinheiro ao jogador. Trata-lo como
        sobrevivente o levaria ao dia final com stack, ocupando vaga e
        disputando a premiacao de quem pagou."""
        _monta(monkeypatch, tournament_players=[
            _jogador(D1, status="active"), _jogador(D1, status="cancelled", buy=2)])
        r = S.get_survivors(D1)
        assert [p["status"] for p in r] == ["active"]

    def _dia_classificatorio(self, **kw):
        base = dict(day_type="qualifying", qualifies_to_day_id=FINAL,
                    registered_players=10, eliminations_count=3, prize_pool=1000)
        base.update(kw)
        return _dia(D1, **base)

    def test_avanca_pelo_contador_quando_o_banco_nao_tem_a_coluna_de_fichas(self, monkeypatch):
        """Caminho antigo: sobreviventes = inscritos − eliminados.

        Vale para o banco ainda não migrado (nenhuma linha traz
        `final_chip_count`). O deploy do código não é atômico com a migração, e
        travar o avanço nessa janela pararia o clube no meio do torneio. O
        prêmio do classificatório vai junto: quem se classificou já pagou por
        ele."""
        fake = _monta(monkeypatch,
                      tournament_days=[self._dia_classificatorio(),
                                       _dia(FINAL, day_type="final", prize_pool=500,
                                            registered_players=2, day_number=9)],
                      tournament_players=[_jogador(D1, buy=4, rebuy=2, addon=1)])
        r = S.advance_qualifiers(D1)
        assert r["advanced_count"] == 7
        assert r["total_entries"] == 4     # entrada e buy-in; as 2 recompras nao contam
        # As FICHAS somam tudo — cada recompra e cada add-on entrega pilha nova:
        # 4 buy-ins × 10000 + 2 rebuys × 10000 + 1 add-on × 5000
        assert r["total_chips"] == 65000
        final = [d for d in fake.store["tournament_days"] if d["id"] == FINAL][0]
        assert final["prize_pool"] == 1500
        assert final["registered_players"] == 9

    def test_dia_comum_nao_avanca(self, monkeypatch):
        _monta(monkeypatch, tournament_days=[_dia(D1, day_type="regular")])
        with pytest.raises(ValueError, match="não é um dia classificatório"):
            S.advance_qualifiers(D1)

    def test_sem_dia_final_vinculado(self, monkeypatch):
        _monta(monkeypatch, tournament_days=[
            self._dia_classificatorio(qualifies_to_day_id=None)])
        with pytest.raises(ValueError, match="dia final vinculado"):
            S.advance_qualifiers(D1)

    def test_dia_final_apagado(self, monkeypatch):
        _monta(monkeypatch, tournament_days=[self._dia_classificatorio()])
        with pytest.raises(ValueError, match="Dia final não encontrado"):
            S.advance_qualifiers(D1)

    def test_todos_eliminados_nao_avanca_ninguem(self, monkeypatch):
        """Avançar 0 jogadores é sinal de contagem errada de eliminações — o
        erro precisa aparecer aqui, e não como um dia final vazio."""
        _monta(monkeypatch, tournament_days=[
            self._dia_classificatorio(eliminations_count=10),
            _dia(FINAL, day_number=9)])
        with pytest.raises(ValueError, match="Nenhum sobrevivente"):
            S.advance_qualifiers(D1)

    def test_dia_inexistente(self, monkeypatch):
        _monta(monkeypatch, tournament_days=[])
        with pytest.raises(ValueError, match="não encontrado"):
            S.advance_qualifiers(D1)

    def test_clube_que_elimina_pelo_contador_nao_precisa_das_fichas(self, monkeypatch):
        """Clube que registra jogador a jogador MAS controla a eliminacao pelo
        contador generico do dia: os 90 inscritos continuam 'active' na lista,
        embora 87 tenham sido eliminados.

        Exigir o stack de todos ali cobraria fichas de quem saiu ha' horas e
        travaria o avanco no meio do evento ('87 de 90 sem fichas registradas'),
        sem o dia final abrir. Sem evidencia do fluxo por jogador, vale o
        contador."""
        jogadores = [
            _jogador(D1, player_id=f"p{i}", id=f"tp{i}", final_chip_count=None)
            for i in range(90)
        ]
        fake = _monta(
            monkeypatch,
            tournament_days=[
                self._dia_classificatorio(registered_players=90, eliminations_count=87),
                _dia(FINAL, day_type="final", registered_players=0, day_number=9),
            ],
            tournament_players=jogadores,
        )
        r = S.advance_qualifiers(D1)
        assert r["advanced_count"] == 3
        # Caminho por contador: nenhuma linha nova no dia final.
        assert not [p for p in fake.store["tournament_players"]
                    if p["tournament_day_id"] == FINAL]

    def test_contador_batendo_com_a_lista_ainda_exige_as_fichas(self, monkeypatch):
        """Quando as eliminacoes FORAM lancadas jogador a jogador (o contador
        bate com a lista), o clube usa o fluxo por jogador: avancar sem as
        fichas levaria todo mundo a' final com stack zerado."""
        _monta(
            monkeypatch,
            tournament_days=[
                self._dia_classificatorio(registered_players=10, eliminations_count=8),
                _dia(FINAL, day_type="final", day_number=9),
            ],
            tournament_players=[
                _jogador(D1, player_id="p1", id="tp1", final_chip_count=None),
                _jogador(D1, player_id="p2", id="tp2", final_chip_count=None),
            ],
        )
        with pytest.raises(ValueError, match="Registre as fichas"):
            S.advance_qualifiers(D1)


class TestAvancoComFichasReais:
    """Avanço jogador a jogador: cada classificado vira uma linha do dia final
    com o stack que ele contou na mesa.

    É o que faz a ficha viajar. Sem essas linhas o dia final não tem de onde
    tirar chipcount, e o telão do dia final acaba mostrando número de outro dia.
    """

    def _dia_classificatorio(self, **kw):
        base = dict(day_type="qualifying", qualifies_to_day_id=FINAL,
                    registered_players=10, eliminations_count=3, prize_pool=1000)
        base.update(kw)
        return _dia(D1, **base)

    def _monta_avanco(self, monkeypatch, jogadores, **dias_kw):
        return _monta(
            monkeypatch,
            tournament_days=[self._dia_classificatorio(**dias_kw),
                             _dia(FINAL, day_type="final", prize_pool=500,
                                  registered_players=2, total_entries=0, day_number=9)],
            tournament_players=jogadores,
        )

    def _sobrevivente(self, player_id, fichas, nome="Fulano", **kw):
        return _jogador(D1, player_id=player_id, id=f"tp-{player_id}",
                        final_chip_count=fichas, players={"name": nome}, **kw)

    def test_cria_uma_linha_no_dia_final_com_o_stack_real(self, monkeypatch):
        fake = self._monta_avanco(monkeypatch, [
            self._sobrevivente("p1", 42000, "Ana"),
            self._sobrevivente("p2", 18500, "Bruno"),
        ])
        r = S.advance_qualifiers(D1)
        assert r["advanced_count"] == 2
        na_final = [p for p in fake.store["tournament_players"]
                    if p["tournament_day_id"] == FINAL]
        assert sorted(p["total_chips"] for p in na_final) == [18500, 42000]

    def test_marca_a_origem_da_classificacao(self, monkeypatch):
        """Sem is_qualified_entry/qualified_from_day_id, o relatório do dia
        final conta o classificado como buy-in direto."""
        fake = self._monta_avanco(monkeypatch, [self._sobrevivente("p1", 42000)])
        S.advance_qualifiers(D1)
        linha = [p for p in fake.store["tournament_players"]
                 if p["tournament_day_id"] == FINAL][0]
        assert linha["is_qualified_entry"] is True
        assert linha["qualified_from_day_id"] == D1

    def test_classificado_nao_paga_buy_in_de_novo(self, monkeypatch):
        """buy_in_count=0 mantém o financeiro do dia final limpo — a entrada já
        foi cobrada no classificatório."""
        fake = self._monta_avanco(monkeypatch, [self._sobrevivente("p1", 42000)])
        S.advance_qualifiers(D1)
        linha = [p for p in fake.store["tournament_players"]
                 if p["tournament_day_id"] == FINAL][0]
        assert linha["buy_in_count"] == 0
        assert linha["total_buy_in_amount"] == 0
        assert linha["status"] == "active"

    def test_sem_fichas_registradas_nao_avanca(self, monkeypatch):
        """Avançar antes de contar as fichas levaria todo mundo para a final com
        stack zerado — e não há como descobrir depois quanto cada um tinha."""
        self._monta_avanco(monkeypatch, [
            self._sobrevivente("p1", 42000),
            self._sobrevivente("p2", None),
        ])
        with pytest.raises(ValueError, match="Registre as fichas"):
            S.advance_qualifiers(D1)

    def test_ficha_zerada_conta_como_nao_registrada(self, monkeypatch):
        """Zero fichas não é um stack: quem chegou a zero foi eliminado."""
        self._monta_avanco(monkeypatch, [self._sobrevivente("p1", 0)])
        with pytest.raises(ValueError, match="Registre as fichas"):
            S.advance_qualifiers(D1)

    def test_nada_e_gravado_quando_falta_ficha(self, monkeypatch):
        """A validação vem ANTES do insert: meio avanço deixaria o dia final com
        parte dos classificados e nenhuma forma de saber quem falta."""
        fake = self._monta_avanco(monkeypatch, [
            self._sobrevivente("p1", 42000),
            self._sobrevivente("p2", None),
        ])
        with pytest.raises(ValueError):
            S.advance_qualifiers(D1)
        assert not [p for p in fake.store["tournament_players"]
                    if p["tournament_day_id"] == FINAL]

    def test_avancar_duas_vezes_nao_duplica_nem_soma_o_premio_de_novo(self, monkeypatch):
        """O operador clica duas vezes; o dia final não pode ganhar jogadores
        fantasmas nem premiação dobrada."""
        fake = self._monta_avanco(monkeypatch, [self._sobrevivente("p1", 42000)])
        S.advance_qualifiers(D1)
        segundo = S.advance_qualifiers(D1)
        assert segundo["advanced_count"] == 0
        na_final = [p for p in fake.store["tournament_players"]
                    if p["tournament_day_id"] == FINAL]
        assert len(na_final) == 1
        final = [d for d in fake.store["tournament_days"] if d["id"] == FINAL][0]
        assert final["prize_pool"] == 1500

    def test_nao_soma_inscritos_na_mao(self, monkeypatch):
        """O trigger update_tournament_player_count já soma 1 por linha inserida
        no banco real. Somar aqui também mostraria o DOBRO de inscritos no dia
        final — por isso registered_players não entra no update."""
        fake = self._monta_avanco(monkeypatch, [self._sobrevivente("p1", 42000)])
        S.advance_qualifiers(D1)
        final = [d for d in fake.store["tournament_days"] if d["id"] == FINAL][0]
        assert final["registered_players"] == 2  # o fake não tem trigger

    def test_devolve_as_fichas_reais_e_quem_avancou(self, monkeypatch):
        """O toast do operador precisa dizer quem passou e com quanto — este é o
        número que a mesa confere na abertura do dia final."""
        self._monta_avanco(monkeypatch, [
            self._sobrevivente("p1", 42000, "Ana"),
            self._sobrevivente("p2", 18500, "Bruno"),
        ])
        r = S.advance_qualifiers(D1)
        assert r["total_chips"] == 60500
        assert sorted(p["player_name"] for p in r["players"]) == ["Ana", "Bruno"]
        assert {p["player_id"]: p["chips"] for p in r["players"]} == {
            "p1": 42000, "p2": 18500}

    def test_carrega_o_premio_do_classificatorio(self, monkeypatch):
        fake = self._monta_avanco(monkeypatch, [self._sobrevivente("p1", 42000)])
        S.advance_qualifiers(D1)
        final = [d for d in fake.store["tournament_days"] if d["id"] == FINAL][0]
        assert final["prize_pool"] == 1500

    def test_eliminado_nao_avanca(self, monkeypatch):
        """Só quem sobreviveu leva fichas para a final."""
        fake = self._monta_avanco(monkeypatch, [
            self._sobrevivente("p1", 42000),
            self._sobrevivente("p2", 9000, status="eliminated"),
        ])
        r = S.advance_qualifiers(D1)
        assert r["advanced_count"] == 1
        na_final = [p for p in fake.store["tournament_players"]
                    if p["tournament_day_id"] == FINAL]
        assert na_final[0]["player_id"] == "p1"

    def test_quem_ja_comprou_entrada_na_final_nao_ganha_linha_dobrada(self, monkeypatch):
        """Jogador que fez buy-in direto no dia final e também se classificou:
        uma linha só, senão ele aparece duas vezes na mesa."""
        fake = self._monta_avanco(monkeypatch, [
            self._sobrevivente("p1", 42000),
            _jogador(FINAL, player_id="p1", id="tp-final-p1"),
        ])
        r = S.advance_qualifiers(D1)
        assert r["advanced_count"] == 0
        assert len([p for p in fake.store["tournament_players"]
                    if p["tournament_day_id"] == FINAL]) == 1

    def test_limpa_o_cache_de_agregados_dos_dois_dias(self, monkeypatch):
        """A TV lê o chipcount de um cache de 60s; sem limpar, o dia final
        apareceria vazio logo depois do avanço."""
        self._monta_avanco(monkeypatch, [self._sobrevivente("p1", 42000)])
        mod._chipcount_cache[FINAL] = (9e12, 0, 0)
        mod._chipcount_cache[D1] = (9e12, 999, 9)
        S.advance_qualifiers(D1)
        assert FINAL not in mod._chipcount_cache
        assert D1 not in mod._chipcount_cache


class TestFichasFinais:
    def test_atualiza_a_contagem_de_um_jogador(self, monkeypatch):
        fake = _monta(monkeypatch, tournament_players=[_jogador(D1)])
        assert S.update_player_chips(D1, "p1", 42000) is True
        assert fake.store["tournament_players"][0]["final_chip_count"] == 42000

    def test_jogador_fora_do_dia(self, monkeypatch):
        _monta(monkeypatch, tournament_players=[])
        assert S.update_player_chips(D1, "p1", 1) is False

    def test_lote_usa_a_rpc_quando_disponivel(self, monkeypatch):
        fake = _monta(monkeypatch)
        fake.rpcs["bulk_update_chip_counts"] = 2
        r = S.bulk_update_chips(D1, [{"player_id": "p1", "chip_count": 1},
                                     {"player_id": "p2", "chip_count": 2}])
        assert r == 2
        assert fake.rpc_calls[0][0] == "bulk_update_chip_counts"

    def test_sem_a_rpc_atualiza_um_a_um(self, monkeypatch):
        _monta(monkeypatch, tournament_players=[
            _jogador(D1, player_id="p1"), _jogador(D1, buy=2, player_id="p2")])
        r = S.bulk_update_chips(D1, [{"player_id": "p1", "chip_count": 10},
                                     {"player_id": "p9", "chip_count": 20}])
        assert r == 1      # p9 não está no dia

    def test_lote_vazio_nao_consulta_nada(self, monkeypatch):
        fake = _monta(monkeypatch)
        assert S.bulk_update_chips(D1, []) == 0
        assert fake.rpc_calls == []

    def test_lote_invalida_o_cache_de_agregados(self, monkeypatch):
        """Sem isso, a TV mostraria o chipcount antigo por até 60s depois de
        o operador corrigir as fichas."""
        fake = _monta(monkeypatch)
        fake.rpcs["bulk_update_chip_counts"] = 1
        mod._chipcount_cache[D1] = (9e12, 999, 9)
        S.bulk_update_chips(D1, [{"player_id": "p1", "chip_count": 1}])
        assert D1 not in mod._chipcount_cache


class TestEstatisticas:
    def test_estatisticas_de_um_dia(self, monkeypatch):
        _monta(monkeypatch, tournament_players=[
            _jogador(D1, buy=1, rebuy=1, addon=2, status="active"),
            _jogador(D1, buy=1, status="eliminated"),
        ])
        r = S.get_qualifying_day_stats(D1)
        assert r.total_players == 2
        assert r.eliminated_players == 1
        assert r.qualified_players == 1
        assert r.total_entries == 2           # entrada e buy-in; o rebuy vai em total_rebuys
        assert r.total_rebuys == 1
        assert r.total_collected == 400.0     # 200 buy-in + 100 rebuy + 100 add-on

    def test_dia_inexistente(self, monkeypatch):
        _monta(monkeypatch, tournament_days=[])
        with pytest.raises(ValueError, match="não encontrado"):
            S.get_qualifying_day_stats(D1)

    def test_agregado_da_final_soma_os_classificatorios(self, monkeypatch):
        _monta(monkeypatch,
               tournament_days=[
                   _dia(FINAL, day_type="final", prize_pool=5000, day_number=9),
                   _dia(D1, qualifies_to_day_id=FINAL, prize_pool=1000),
                   _dia(D2, qualifies_to_day_id=FINAL, prize_pool=800, day_number=2),
               ],
               tournament_players=[
                   _jogador(D1, buy=2, rebuy=1),
                   _jogador(D2, buy=3, rebuy=0),
                   _jogador(FINAL, buy=1, is_qualified_entry=True),
                   _jogador(FINAL, buy=1, rebuy=1, is_qualified_entry=False),
               ])
        r = S.get_final_day_aggregated_stats(FINAL)
        assert len(r.qualifying_days) == 2
        assert r.total_qualifying_buy_ins == 5
        assert r.total_qualifying_rebuys == 1
        assert r.total_qualifying_prize_pool == 1800
        assert r.total_qualified_players == 1
        assert r.direct_buy_in_players == 1

    def test_final_sem_classificatorios(self, monkeypatch):
        _monta(monkeypatch, tournament_days=[_dia(FINAL, day_type="final")])
        r = S.get_final_day_aggregated_stats(FINAL)
        assert r.qualifying_days == []
        assert r.total_qualifying_entries == 0

    def test_dia_final_inexistente(self, monkeypatch):
        _monta(monkeypatch, tournament_days=[])
        with pytest.raises(ValueError, match="não encontrado"):
            S.get_final_day_aggregated_stats(FINAL)


class TestComandosDoRelogio:
    def test_iniciar_ativa_o_torneio_na_primeira_vez(self, monkeypatch):
        fake = _monta(monkeypatch)
        S.start_timer(D1)
        assert fake.store["tournaments"][0]["status"] == "active"

    def test_retomar_nao_refaz_a_sincronizacao(self, monkeypatch):
        """Pausar mantém o dia 'active'; ao retomar, o torneio já está ativo e
        os 2 round-trips da sincronização seriam desperdício num comando que
        o operador aperta o tempo todo."""
        fake = _monta(monkeypatch, tournament_days=[_dia(D1, status="active")])
        fake.store["tournaments"][0]["status"] = "active"
        chamadas = []
        monkeypatch.setattr(S, "_sync_tournament_status",
                            staticmethod(lambda tid: chamadas.append(tid)))
        S.start_timer(D1)
        assert chamadas == []

    def test_dia_inexistente_em_cada_comando(self, monkeypatch):
        _monta(monkeypatch, tournament_days=[])
        for fn in (S.start_timer, S.pause_timer, S.next_level,
                   S.previous_level, S.reset_timer, S.get_timer_status):
            with pytest.raises(ValueError, match="not found"):
                fn(D1)
        with pytest.raises(ValueError, match="not found"):
            S.adjust_timer(D1, 60)
        with pytest.raises(ValueError, match="not found"):
            S.set_level(D1, 2)

    def test_pausar_com_relogio_rodando_materializa_o_decorrido(self, monkeypatch):
        """O tempo fica ancorado em `timer_started_at`; ao pausar é preciso
        somá-lo a `elapsed_time`, senão o torneio "volta no tempo"."""
        inicio = datetime.now(timezone.utc) - timedelta(seconds=90)
        fake = _monta(monkeypatch, tournament_days=[_dia(
            D1, is_paused=False, timer_started_at=inicio.isoformat(),
            elapsed_time=30)])
        S.pause_timer(D1)
        linha = fake.store["tournament_days"][0]
        assert linha["elapsed_time"] == pytest.approx(120, abs=2)
        assert linha["timer_started_at"] is None

    def test_pausar_o_que_ja_estava_pausado_nao_soma_nada(self, monkeypatch):
        fake = _monta(monkeypatch, tournament_days=[_dia(
            D1, is_paused=True, elapsed_time=45)])
        S.pause_timer(D1)
        assert fake.store["tournament_days"][0]["elapsed_time"] == 45

    def test_adicionar_tempo_reduz_o_decorrido(self, monkeypatch):
        """"Adicionar 60s ao relógio" é o mesmo que recuar o decorrido em 60s."""
        fake = _monta(monkeypatch, tournament_days=[_dia(D1, elapsed_time=300)])
        S.adjust_timer(D1, 60)
        linha = fake.store["tournament_days"][0]
        assert linha["elapsed_time"] == 240
        assert linha["manual_time_adjustment"] == 60

    def test_tirar_mais_tempo_do_que_existe_para_em_zero(self, monkeypatch):
        fake = _monta(monkeypatch, tournament_days=[_dia(D1, elapsed_time=30)])
        S.adjust_timer(D1, 999)
        assert fake.store["tournament_days"][0]["elapsed_time"] == 0

    def test_ajustar_com_o_relogio_rodando_reancora_o_inicio(self, monkeypatch):
        inicio = datetime.now(timezone.utc) - timedelta(seconds=60)
        fake = _monta(monkeypatch, tournament_days=[_dia(
            D1, is_paused=False, timer_started_at=inicio.isoformat(), elapsed_time=0)])
        S.adjust_timer(D1, -30)
        linha = fake.store["tournament_days"][0]
        assert linha["elapsed_time"] == pytest.approx(90, abs=2)
        assert linha["timer_started_at"] is not None

    def test_define_o_nivel(self, monkeypatch):
        fake = _monta(monkeypatch)
        S.set_level(D1, 4)
        assert fake.store["tournament_days"][0]["current_level"] == 4

    def test_nivel_zero_e_recusado(self, monkeypatch):
        _monta(monkeypatch)
        with pytest.raises(ValueError, match="at least 1"):
            S.set_level(D1, 0)

    def _blinds(self):
        return [
            {"id": "b1", "tournament_day_id": D1, "level": 1, "duration": 10,
             "small_blind": 100, "big_blind": 200, "ante": 0, "is_break": False},
            {"id": "b2", "tournament_day_id": D1, "level": 2, "duration": 10,
             "small_blind": 200, "big_blind": 400, "ante": 0, "is_break": False},
            {"id": "b3", "tournament_day_id": D1, "level": 3, "duration": 15,
             "small_blind": 0, "big_blind": 0, "ante": 0, "is_break": True},
        ]

    def test_avancar_o_nivel_alinha_o_decorrido_ao_inicio_dele(self, monkeypatch):
        """Sem alinhar, o próximo nível começaria já com parte do tempo
        consumido — a mesa perderia minutos de jogo."""
        fake = _monta(monkeypatch, blinds=self._blinds())
        S.next_level(D1)
        linha = fake.store["tournament_days"][0]
        assert linha["current_level"] == 2
        assert linha["elapsed_time"] == 600

    def test_voltar_o_nivel(self, monkeypatch):
        fake = _monta(monkeypatch, tournament_days=[_dia(D1, current_level=3)],
                      blinds=self._blinds())
        S.previous_level(D1)
        linha = fake.store["tournament_days"][0]
        assert linha["current_level"] == 2
        assert linha["elapsed_time"] == 600

    def test_nao_volta_abaixo_do_primeiro_nivel(self, monkeypatch):
        fake = _monta(monkeypatch, blinds=self._blinds())
        S.previous_level(D1)
        assert fake.store["tournament_days"][0]["current_level"] == 1

    def test_reiniciar_zera_tudo(self, monkeypatch):
        fake = _monta(monkeypatch, tournament_days=[_dia(
            D1, current_level=7, elapsed_time=3000, manual_time_adjustment=120,
            is_paused=False, timer_started_at="2026-06-08T10:00:00Z")])
        S.reset_timer(D1)
        linha = fake.store["tournament_days"][0]
        assert (linha["current_level"], linha["elapsed_time"],
                linha["manual_time_adjustment"], linha["is_paused"],
                linha["timer_started_at"]) == (1, 0, 0, True, None)

    def test_status_usa_a_mesma_conta_da_tv(self, monkeypatch):
        """ATIVOS = ENTRADAS − ELIMINACOES, como no telao. Contar status
        'active' errava: o inscrito novo nasce 'registered', e no modo em
        massa ninguem muda de status ao sair."""
        _monta(monkeypatch,
               tournament_days=[_dia(D1, eliminations_count=1)],
               tournament_players=[
                   _jogador(D1, buy=1, rebuy=1, status="registered"),
                   _jogador(D1, buy=1, status="eliminated"),
               ])
        r = S.get_timer_status(D1)
        assert r.total_entries == 2     # a recompra nao e entrada nova
        assert r.active_players == 1

    def test_status_soma_o_tempo_corrido_desde_o_inicio(self, monkeypatch):
        inicio = datetime.now(timezone.utc) - timedelta(seconds=120)
        _monta(monkeypatch, tournament_days=[_dia(
            D1, is_paused=False, timer_started_at=inicio.isoformat(), elapsed_time=60)])
        assert S.get_timer_status(D1).elapsed_time == pytest.approx(180, abs=2)


class TestBlindsDoDia:
    def test_prefere_os_blinds_do_DIA(self, monkeypatch):
        _monta(monkeypatch, blinds=[
            {"id": "b1", "tournament_day_id": D1, "level": 1, "duration": 10},
            {"id": "b9", "tournament_id": TOUR, "tournament_day_id": None,
             "level": 1, "duration": 99},
        ])
        assert S._get_all_blinds(D1, TOUR)[0]["duration"] == 10

    def test_cai_nos_blinds_do_TORNEIO_quando_o_dia_nao_tem(self, monkeypatch):
        """Estruturas antigas foram cadastradas no torneio, antes de a
        estrutura passar a ser por dia."""
        _monta(monkeypatch, blinds=[
            {"id": "b9", "tournament_id": TOUR, "tournament_day_id": None,
             "level": 1, "duration": 99},
        ])
        assert S._get_all_blinds(D1, TOUR)[0]["duration"] == 99

    def test_sem_blinds_devolve_lista_vazia(self, monkeypatch):
        _monta(monkeypatch)
        assert S._get_all_blinds(D1, TOUR) == []

    def test_dia_vazio_NAO_herda_a_estrutura_de_outro_dia(self, monkeypatch):
        """Todo blind criado por dia também grava o tournament_id. Se o
        fallback por torneio não excluísse essas linhas, um dia com a estrutura
        apagada passaria a mostrar no telão os blinds do dia vizinho — pior do
        que ficar vazio, porque ninguém percebe."""
        _monta(monkeypatch, blinds=[
            {"id": "b2", "tournament_id": TOUR, "tournament_day_id": D2,
             "level": 1, "duration": 42},
        ])
        assert S._get_all_blinds(D1, TOUR) == []


class TestStatusEnriquecido:
    """É o que a TV consulta a cada 3s."""

    def _blinds(self):
        return [
            {"id": "b1", "tournament_day_id": D1, "level": 1, "duration": 10,
             "small_blind": 100, "big_blind": 200, "ante": 0, "is_break": False},
            {"id": "b2", "tournament_day_id": D1, "level": 2, "duration": 10,
             "small_blind": 200, "big_blind": 400, "ante": 0, "is_break": False},
            {"id": "b3", "tournament_day_id": D1, "level": 3, "duration": 15,
             "small_blind": 0, "big_blind": 0, "ante": 0, "is_break": True},
        ]

    def test_traz_o_blind_atual_e_o_proximo(self, monkeypatch):
        _monta(monkeypatch, blinds=self._blinds())
        r = S.get_enriched_timer_status(D1)
        assert r["current_blind"]["level"] == 1
        assert r["next_blind"]["level"] == 2
        assert r["next_break"]["level"] == 3

    def test_numero_exibido_nao_conta_o_intervalo(self, monkeypatch):
        """O intervalo ocupa uma POSICAO na estrutura, mas nao e nivel de jogo.

        A tela de blinds renumera pulando os intervalos (800/1600 e "Nivel 9");
        o telao mostrava a posicao crua ("NIVEL 10"), e a diferenca crescia a
        cada intervalo. O numero exibido conta so os niveis de jogo.
        """
        estrutura = [
            {"id": "b1", "tournament_day_id": D1, "level": 1, "duration": 10,
             "small_blind": 100, "big_blind": 200, "ante": 0, "is_break": False},
            {"id": "b2", "tournament_day_id": D1, "level": 2, "duration": 10,
             "small_blind": 0, "big_blind": 0, "ante": 0, "is_break": True},
            {"id": "b3", "tournament_day_id": D1, "level": 3, "duration": 10,
             "small_blind": 200, "big_blind": 400, "ante": 0, "is_break": False},
            {"id": "b4", "tournament_day_id": D1, "level": 4, "duration": 10,
             "small_blind": 0, "big_blind": 0, "ante": 0, "is_break": True},
            {"id": "b5", "tournament_day_id": D1, "level": 5, "duration": 10,
             "small_blind": 300, "big_blind": 600, "ante": 0, "is_break": False},
        ]
        assert S._numero_exibido(estrutura, 1) == 1
        assert S._numero_exibido(estrutura, 2) == 1   # intervalo: ultimo jogado
        assert S._numero_exibido(estrutura, 3) == 2
        assert S._numero_exibido(estrutura, 5) == 3   # posicao 5, nivel 3
        assert S._numero_exibido(estrutura, None) is None

        # Posicao 3 (200/400) e o segundo nivel de jogo: a TV mostra 2, nao 3.
        # O nivel e recalculado pelo tempo: 10 min de nivel 1 + 10 de intervalo.
        _monta(monkeypatch, blinds=estrutura,
               tournament_days=[_dia(current_level=3, elapsed_time=20 * 60)])
        r = S.get_enriched_timer_status(D1)
        assert r["current_level"] == 3
        assert r["display_level"] == 2
        assert r["current_blind"]["display_level"] == 2
        # Proximo na ordem e o intervalo (posicao 4); depois dele vem o nivel 3.
        assert r["next_blind"]["is_break"] is True
        assert r["next_blind"]["display_level"] == 2
        # O numero exibido e derivado: nao vaza para a linha do banco.
        assert "display_level" not in estrutura[2]

    def test_proximo_nivel_atravessa_buraco_na_numeracao(self, monkeypatch):
        """A numeracao tem buracos na vida real.

        Apagar um nivel ou um intervalo no meio da estrutura deixa 2 -> 4, 5 ->
        7 (ha varios assim em producao). O codigo procurava `atual + 1` exato,
        nao achava nada, e o telao anunciava "PROXIMOS BLINDS 0/0 (0)" para a
        mesa inteira — zero nao e um blind, e o operador nao tinha como saber o
        que vinha.
        """
        _monta(monkeypatch, blinds=[
            {"id": "b1", "tournament_day_id": D1, "level": 1, "duration": 10,
             "small_blind": 100, "big_blind": 200, "ante": 0, "is_break": False},
            {"id": "b3", "tournament_day_id": D1, "level": 3, "duration": 10,
             "small_blind": 300, "big_blind": 600, "ante": 50, "is_break": False},
        ])
        r = S.get_enriched_timer_status(D1)
        assert r["current_blind"]["level"] == 1
        assert r["next_blind"]["level"] == 3
        assert r["next_blind"]["big_blind"] == 600

    def test_proximo_nivel_e_o_menor_seguinte_mesmo_fora_de_ordem(self):
        """Direto na funcao, sem passar pelo banco falso — que reordena e
        esconderia justamente o que este teste protege: pegar o primeiro da
        lista daria o nivel errado em silencio, e este numero esta numa TV."""
        fora_de_ordem = [
            {"level": 9, "big_blind": 1800},
            {"level": 2, "big_blind": 400},
            {"level": 1, "big_blind": 200},
        ]
        assert S._proximo_blind(fora_de_ordem, 1)["level"] == 2
        assert S._proximo_blind(fora_de_ordem, 2)["level"] == 9
        assert S._proximo_blind(fora_de_ordem, 9) is None

    def test_nivel_nulo_na_estrutura_nao_derruba_o_proximo(self):
        """Linha sem nivel nao pode estourar a tela que a mesa inteira olha."""
        assert S._proximo_blind([{"level": None}, {"level": 4}], 1)["level"] == 4
        assert S._proximo_blind([], 1) is None

    def test_no_ultimo_nivel_nao_ha_proximo(self, monkeypatch):
        """Devolve None, e nao um blind zerado: e o telao que decide como dizer
        "acabou a estrutura"."""
        _monta(monkeypatch, blinds=[
            {"id": "b1", "tournament_day_id": D1, "level": 1, "duration": 10,
             "small_blind": 100, "big_blind": 200, "ante": 0, "is_break": False},
        ])
        assert S.get_enriched_timer_status(D1)["next_blind"] is None

    def test_o_nivel_se_corrige_sozinho_pelo_tempo(self, monkeypatch):
        """Se a tela ficar minutos sem atualizar (rede caiu, aba em segundo
        plano), o nível é recalculado do tempo e gravado — a TV nunca volta
        exibindo um nível vencido."""
        inicio = datetime.now(timezone.utc) - timedelta(seconds=700)
        fake = _monta(monkeypatch, tournament_days=[_dia(
            D1, is_paused=False, timer_started_at=inicio.isoformat(),
            elapsed_time=0, current_level=1)], blinds=self._blinds())
        r = S.get_enriched_timer_status(D1)
        assert r["current_level"] == 2
        assert fake.store["tournament_days"][0]["current_level"] == 2

    def test_pausado_nao_se_auto_corrige(self, monkeypatch):
        fake = _monta(monkeypatch, tournament_days=[_dia(
            D1, is_paused=True, elapsed_time=700, current_level=1)],
            blinds=self._blinds())
        S.get_enriched_timer_status(D1)
        assert fake.store["tournament_days"][0]["current_level"] == 1

    def test_sem_inicio_marcado_conta_como_pausado(self, monkeypatch):
        """`is_paused=False` com `timer_started_at` nulo é estado
        inconsistente; tratar como rodando faria o contador da tela descer
        sozinho enquanto o servidor devolve sempre o mesmo valor."""
        _monta(monkeypatch, tournament_days=[_dia(
            D1, is_paused=False, timer_started_at=None)], blinds=self._blinds())
        assert S.get_enriched_timer_status(D1)["is_paused"] is True

    def test_calcula_o_instante_absoluto_do_fim_do_nivel(self, monkeypatch):
        """Todas as telas derivam "restante = fim − agora" do MESMO valor;
        é o que elimina o desencontro de 1s entre o Controle e a TV."""
        inicio = datetime.now(timezone.utc)
        _monta(monkeypatch, tournament_days=[_dia(
            D1, is_paused=False, timer_started_at=inicio.isoformat(),
            elapsed_time=0)], blinds=self._blinds())
        r = S.get_enriched_timer_status(D1)
        assert r["current_level_ends_at"] == pytest.approx(inicio.timestamp() + 600, abs=2)
        assert r["next_break_starts_at"] == pytest.approx(inicio.timestamp() + 1200, abs=2)

    def test_pausado_nao_publica_instantes_absolutos(self, monkeypatch):
        _monta(monkeypatch, blinds=self._blinds())
        r = S.get_enriched_timer_status(D1)
        assert r["current_level_ends_at"] is None
        assert r["next_break_starts_at"] is None

    def test_stack_medio_e_ativos_saem_das_entradas_menos_eliminados(self, monkeypatch):
        _monta(monkeypatch,
               tournament_days=[_dia(D1, eliminations_count=2)],
               tournament_players=[
                   _jogador(D1, buy=1, rebuy=1, fichas=30000),
                   _jogador(D1, buy=1, fichas=20000),
                   _jogador(D1, buy=1, fichas=10000),
               ],
               blinds=self._blinds())
        r = S.get_enriched_timer_status(D1)
        # 3 inscritos, 1 recompra, 2 eliminados no contador.
        assert r["total_entries"] == 3      # entrada e buy-in
        assert r["total_reentries"] == 1
        # A conta e a que a tela mostra por extenso: ENTRADAS - ELIMINACOES.
        # A recompra ja baixou o contador quando foi vendida, entao ela NAO
        # aparece de novo aqui — somar a recompra aos ativos era o que fazia a
        # tela exibir "2 - 0 = 7".
        assert r["active_players"] == 1
        assert r["chipcount"] == 60000
        assert r["average_stack"] == 60000

    def test_sem_ativos_o_stack_medio_e_zero(self, monkeypatch):
        """Divisão por zero derrubaria a tela justamente no fim do torneio."""
        _monta(monkeypatch, tournament_days=[_dia(D1, eliminations_count=99)],
               tournament_players=[_jogador(D1, buy=1)], blinds=self._blinds())
        assert S.get_enriched_timer_status(D1)["average_stack"] == 0

    def test_o_cache_e_por_dia(self, monkeypatch):
        """Chave global mostraria o chipcount de um dia na tela de outro."""
        _monta(monkeypatch,
               tournament_days=[_dia(D1), _dia(D2, day_number=2)],
               tournament_players=[_jogador(D1, fichas=11000),
                                   _jogador(D2, fichas=22000)],
               blinds=self._blinds())
        assert S.get_enriched_timer_status(D1)["chipcount"] == 11000
        assert S.get_enriched_timer_status(D2)["chipcount"] == 22000

    def test_o_cache_evita_uma_nova_varredura(self, monkeypatch):
        _monta(monkeypatch, tournament_players=[_jogador(D1, fichas=15000)],
               blinds=self._blinds())
        S.get_enriched_timer_status(D1)
        # muda o banco: com cache válido, a resposta NÃO deve mudar
        mod.supabase.store["tournament_players"][0]["total_chips"] = 999999
        assert S.get_enriched_timer_status(D1)["chipcount"] == 15000

    def test_sem_jogadores_no_dia_cai_para_os_do_torneio(self, monkeypatch):
        """Dias antigos foram gravados só com `tournament_id`; sem esse
        fallback o chipcount da TV apareceria zerado."""
        _monta(monkeypatch,
               tournament_players=[_jogador(D1, fichas=7000, tournament_day_id=None)],
               blinds=self._blinds())
        assert S.get_enriched_timer_status(D1)["chipcount"] == 7000

    def test_falha_na_varredura_reaproveita_o_ultimo_valor(self, monkeypatch):
        """A TV está no ar; um erro momentâneo não pode zerar os números na
        frente do salão."""
        _monta(monkeypatch, tournament_players=[_jogador(D1, fichas=8000)],
               blinds=self._blinds())
        S.get_enriched_timer_status(D1)
        mod._chipcount_cache[D1] = (0, 8000, 1)      # expira o cache

        original = mod.supabase.table

        def _table(nome):
            if nome == "tournament_players":
                raise RuntimeError("timeout")
            return original(nome)

        monkeypatch.setattr(mod.supabase, "table", _table)
        assert S.get_enriched_timer_status(D1)["chipcount"] == 8000

    def test_dia_inexistente(self, monkeypatch):
        _monta(monkeypatch, tournament_days=[])
        with pytest.raises(ValueError, match="not found"):
            S.get_enriched_timer_status(D1)


class TestContadorDeEliminados:
    def test_soma_eliminados(self, monkeypatch):
        fake = _monta(monkeypatch, tournament_players=[
            _jogador(D1, buy=1), _jogador(D1, buy=1, rebuy=1)])
        r = S.adjust_eliminations(D1, 2)
        assert r["eliminations_count"] == 2
        # 2 entradas - 2 eliminados = 0. A recompra do segundo jogador ja tinha
        # baixado o contador na hora da venda; ela nao entra de novo aqui.
        assert r["active_players"] == 0
        assert r["total_entries"] == 2
        assert fake.store["tournament_days"][0]["eliminations_count"] == 2

    def test_desfaz_uma_eliminacao(self, monkeypatch):
        _monta(monkeypatch, tournament_days=[_dia(D1, eliminations_count=3)],
               tournament_players=[_jogador(D1, buy=5)])
        assert S.adjust_eliminations(D1, -1)["eliminations_count"] == 2

    def test_nao_desce_abaixo_de_zero(self, monkeypatch):
        _monta(monkeypatch, tournament_players=[_jogador(D1, buy=2)])
        assert S.adjust_eliminations(D1, -10)["eliminations_count"] == 0

    def test_nao_passa_do_total_de_entradas(self, monkeypatch):
        """Mais eliminados que vidas compradas deixaria "jogadores ativos"
        negativo na TV."""
        _monta(monkeypatch, tournament_players=[_jogador(D1, buy=3)])
        r = S.adjust_eliminations(D1, 99)
        assert r["eliminations_count"] == 3
        assert r["active_players"] == 0

    def test_o_teto_sao_as_entradas_mesmo_com_recompras(self, monkeypatch):
        """Nunca ha mais eliminados do que entradas ao mesmo tempo.

        Num dia de 2 inscritos, no maximo 2 pessoas estao fora da mesa AGORA —
        por mais recompras que tenham acontecido, porque cada uma ja baixou o
        contador quando foi vendida. Teto maior deixaria "jogadores ativos"
        negativo na TV."""
        _monta(monkeypatch, tournament_players=[
            _jogador(D1, buy=1, rebuy=3), _jogador(D1, buy=1, rebuy=2)])
        r = S.adjust_eliminations(D1, 99)
        assert r["eliminations_count"] == 2
        assert r["total_entries"] == 2
        assert r["active_players"] == 0

    def test_dia_inexistente(self, monkeypatch):
        _monta(monkeypatch, tournament_days=[])
        with pytest.raises(ValueError, match="not found"):
            S.adjust_eliminations(D1, 1)

    def test_modo_mesa_recusa_o_contador_em_massa(self, monkeypatch):
        """Por mesa, o contador e a contagem dos eliminados no assento. Um
        "Eliminar 1" sem nome descolaria o numero da lista."""
        fake = _monta(monkeypatch,
                      tournaments=[{"id": TOUR, "name": "T", "elimination_mode": "table"}],
                      tournament_players=[_jogador(D1, buy=3)])
        with pytest.raises(ValueError) as erro:
            S.adjust_eliminations(D1, 1)
        assert erro.value.code == "eliminacao_por_mesa"
        assert erro.value.status == 409
        assert fake.store["tournament_days"][0]["eliminations_count"] == 0

    def test_usa_o_rpc_atomico_quando_existe(self, monkeypatch):
        """Dois operadores clicando juntos nao podem perder um clique: o
        banco soma na mesma instrucao."""
        fake = _monta(monkeypatch, tournament_players=[_jogador(D1, buy=3)])
        fake.rpcs["registrar_eliminacao"] = lambda p: 1
        assert S.adjust_eliminations(D1, 1)["eliminations_count"] == 1
        assert ("registrar_eliminacao", {"p_day_id": D1, "p_qtd": 1}) in fake.rpc_calls

    def test_dia_final_conta_os_classificados_como_entradas(self, monkeypatch):
        """O classificado chega ao dia final com buy_in_count = 0. Sem conta-lo,
        o dia final tinha ~0 entradas: a TV mostrava 0 ativos e o contador nao
        aceitava eliminacao nenhuma."""
        _monta(monkeypatch,
               tournament_days=[_dia(FINAL, day_type="final")],
               tournament_players=[
                   _jogador(FINAL, buy=0, is_qualified_entry=True, id="q1"),
                   _jogador(FINAL, buy=0, is_qualified_entry=True, id="q2"),
                   _jogador(FINAL, buy=0, is_qualified_entry=True, id="q3",
                            status="cancelled"),
                   _jogador(FINAL, buy=1, id="direto"),
               ])
        r = S.adjust_eliminations(FINAL, 1)
        assert r["total_entries"] == 3      # 2 classificados vivos + 1 buy-in direto
        assert r["eliminations_count"] == 1
        assert r["active_players"] == 2

    def test_dia_final_avancado_pelo_contador_usa_os_inscritos(self, monkeypatch):
        """Avanco pelo contador nao cria linha de classificado: o dia final so
        tem `registered_players`. Ali ele e o piso das entradas."""
        _monta(monkeypatch,
               tournament_days=[_dia(FINAL, day_type="final", registered_players=12)],
               tournament_players=[])
        r = S.adjust_eliminations(FINAL, 2)
        assert r["total_entries"] == 12
        assert r["active_players"] == 10


class TestFichasEmJogoVemDasVendas:
    """"Fichas em jogo" e a soma do que as VENDAS entregaram.

    Ate os meios de entrada por dia, o numero era `contador x campo do dia` —
    correto enquanto todo rebuy entregava a mesma pilha. Com "rebuy duplo"
    entregando 25.000 onde o dia diz 10.000, a multiplicacao passa a mentir o
    stack medio no telao, que e o numero que o diretor usa para decidir o
    intervalo.

    A multiplicacao continua valendo para o que as vendas nao explicam: venda
    anterior a migracao (sem `chips`) e classificado que o avanco criou sem
    transacao nenhuma.
    """

    def _dia_obj(self):
        return SimpleNamespace(id=D1, starting_chips=10000, rebuy_chips=10000,
                               addon_chips=5000)

    def _venda(self, tp_id, tipo, chips, status="active"):
        return {"id": f"tx-{tp_id}-{tipo}-{chips}", "tournament_player_id": tp_id,
                "type": tipo, "chips": chips, "status": status}

    def test_soma_as_fichas_gravadas_em_cada_venda(self, monkeypatch):
        jogador = _jogador(buy=1, rebuy=1)
        fake = _monta(monkeypatch, tournament_players=[jogador], transactions=[
            self._venda(jogador["id"], "buy_in", 10000),
            self._venda(jogador["id"], "rebuy", 25000),  # recompra dupla
        ])
        fichas, entradas, reentradas = S._entradas_do_dia(self._dia_obj())
        assert fichas == 35000
        assert (entradas, reentradas) == (1, 1)

    def test_sem_venda_registrada_cai_na_multiplicacao_de_sempre(self, monkeypatch):
        """O classificado que o avanco cria nao tem transacao nenhuma: exigir
        venda zeraria as fichas do dia final inteiro."""
        _monta(monkeypatch, tournament_players=[_jogador(buy=1, rebuy=2, addon=1)])
        fichas, _, _ = S._entradas_do_dia(self._dia_obj())
        assert fichas == 10000 + 2 * 10000 + 5000

    def test_venda_antiga_sem_fichas_continua_valendo_o_campo_do_dia(self, monkeypatch):
        """Tudo que foi vendido antes da migracao tem `chips` nulo — some da
        soma se a gente exigir o numero gravado."""
        jogador = _jogador(buy=1, rebuy=1)
        _monta(monkeypatch, tournament_players=[jogador], transactions=[
            self._venda(jogador["id"], "buy_in", None),
            self._venda(jogador["id"], "rebuy", None),
        ])
        fichas, _, _ = S._entradas_do_dia(self._dia_obj())
        assert fichas == 20000

    def test_venda_estornada_nao_entrega_ficha(self, monkeypatch):
        """O estorno ja devolveu o contador; contar a linha cancelada deixaria
        o telao com fichas que voltaram para o caixa."""
        jogador = _jogador(buy=1, rebuy=0)
        _monta(monkeypatch, tournament_players=[jogador], transactions=[
            self._venda(jogador["id"], "buy_in", 10000),
            self._venda(jogador["id"], "rebuy", 25000, status="cancelled"),
        ])
        fichas, _, _ = S._entradas_do_dia(self._dia_obj())
        assert fichas == 10000

    def test_inscricao_de_duas_entradas_conta_a_venda_uma_vez(self, monkeypatch):
        """O buy-in e UMA linha para a inscricao inteira (buy_in_count=2 entra
        numa transacao so). Somar a linha E multiplicar o contador daria 30.000
        onde a venda entregou 20.000."""
        jogador = _jogador(buy=2)
        _monta(monkeypatch, tournament_players=[jogador], transactions=[
            self._venda(jogador["id"], "buy_in", 20000),
        ])
        fichas, entradas, _ = S._entradas_do_dia(self._dia_obj())
        assert fichas == 20000
        assert entradas == 2

    def test_recompra_sem_venda_gravada_soma_junto_com_a_que_tem(self, monkeypatch):
        """Dia que atravessou o deploy: uma recompra antes da migracao (sem
        `chips`) e outra depois. As duas precisam entrar."""
        jogador = _jogador(buy=1, rebuy=2)
        _monta(monkeypatch, tournament_players=[jogador], transactions=[
            self._venda(jogador["id"], "buy_in", 10000),
            self._venda(jogador["id"], "rebuy", 25000),
            self._venda(jogador["id"], "rebuy", None),
        ])
        fichas, _, _ = S._entradas_do_dia(self._dia_obj())
        assert fichas == 10000 + 25000 + 10000

    def test_pergunta_as_vendas_de_todos_numa_consulta_so(self, monkeypatch):
        """A consulta por jogador dentro do laco (N+1) ja derrubou o desempenho
        deste projeto antes — e um dia final tem centenas de inscritos."""
        jogadores = [_jogador(buy=1, rebuy=1, status=f"active-{i}") for i in range(5)]
        fake = _monta(monkeypatch, tournament_players=jogadores, transactions=[
            self._venda(j["id"], "rebuy", 25000) for j in jogadores
        ])
        original, idas = fake.table, []

        def _contando(nome):
            idas.append(nome)
            return original(nome)

        monkeypatch.setattr(fake, "table", _contando)
        S._entradas_do_dia(self._dia_obj())
        assert idas.count("transactions") == 1
        assert idas.count("tournament_players") == 1

    def test_dia_sem_ninguem_nao_pergunta_as_vendas(self, monkeypatch):
        """Sem inscrito nao ha o que perguntar — e um `in_` com lista vazia e
        uma ida ao banco jogada fora em cada poll da TV."""
        fake = _monta(monkeypatch, tournament_players=[])
        original, idas = fake.table, []

        def _contando(nome):
            idas.append(nome)
            return original(nome)

        monkeypatch.setattr(fake, "table", _contando)
        assert S._entradas_do_dia(self._dia_obj()) == (0, 0, 0)
        assert "transactions" not in idas

    def test_banco_sem_a_coluna_de_fichas_volta_a_multiplicar(self, monkeypatch):
        """O deploy do codigo nao e atomico com a migracao: enquanto `chips` nao
        existir, a consulta falha. Um numero teorico e melhor que um 500 no meio
        do evento."""
        jogador = _jogador(buy=1, rebuy=1)
        fake = _monta(monkeypatch, tournament_players=[jogador])
        original = fake.table

        def _sem_a_coluna(nome):
            if nome == "transactions":
                raise RuntimeError("column transactions.chips does not exist")
            return original(nome)

        monkeypatch.setattr(fake, "table", _sem_a_coluna)
        fichas, _, _ = S._entradas_do_dia(self._dia_obj())
        assert fichas == 20000
