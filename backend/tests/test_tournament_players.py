"""Testes da inscricao de jogador, rebuy, addon e eliminacao.

E a operacao mais repetida do evento: cada uma dessas chamadas movimenta
dinheiro e fichas. Os pontos sensiveis sao os limites (dia cheio, inscricao
duplicada) e o rake, que desde os tipos de buy passou a ser por transacao.
"""
import pytest

from app.services import tournament_player_service
from app.services import sales_block_service
from app.services.sales_block_service import SalesBlockService
from app.services.tournament_player_service import TournamentPlayerService
from app.services.cashbox_service import CashboxService
from app.models.tournament_player import TournamentPlayerCreate, TournamentPlayerUpdate

from tests.conftest import FakeSupabase


TOUR = "22222222-2222-2222-2222-222222222222"
DIA = "77777777-7777-7777-7777-777777777777"
PLAYER = "44444444-4444-4444-4444-444444444444"
TP = "66666666-6666-6666-6666-666666666666"
# Segundo dia do MESMO torneio (o 1B) e a inscricao do jogador nele.
DIA_1B = "88888888-8888-8888-8888-888888888888"
TP_1B = "99999999-9999-9999-9999-999999999999"


def _dia(buy_in=100, chips=10000, rake=20, max_players=None, registrados=0):
    return {
        "id": DIA, "tournament_id": TOUR, "buy_in": buy_in,
        "starting_chips": chips, "rake_percentage": rake,
        "max_players": max_players, "registered_players": registrados,
        "rebuy_amount": buy_in, "addon_amount": buy_in,
        "rebuy_chips": chips, "addon_chips": chips,
        "created_at": "2026-06-08T00:00:00Z",
    }


def _monta(monkeypatch, dia=None, jogadores=None, tabelas=None):
    base = {
        "tournaments": [{"id": TOUR, "name": "Torneio A"}],
        "tournament_days": [dia or _dia()],
        "tournament_players": jogadores if jogadores is not None else [],
        "players": [{"id": PLAYER, "name": "Fulano", "nickname": "fu"}],
        "transactions": [],
        "buy_types": [],
    }
    base.update(tabelas or {})
    fake = FakeSupabase(base)
    monkeypatch.setattr(tournament_player_service, "supabase", fake)
    # O bloqueio de vendas le do MESMO banco falso: sem isto ele consultaria o
    # Supabase de verdade no meio do teste.
    monkeypatch.setattr(sales_block_service, "supabase", fake)
    monkeypatch.setattr(CashboxService, "require_open_cashbox_for_tournament",
                        staticmethod(lambda *a, **k: None))
    return fake


def _inscricao(**kw):
    dados = dict(tournament_id=TOUR, tournament_day_id=DIA, player_id=PLAYER)
    dados.update(kw)
    return TournamentPlayerCreate(**dados)


class TestInscricao:
    def test_registra_e_cobra_o_buy_in(self, monkeypatch):
        fake = _monta(monkeypatch)
        r = TournamentPlayerService.register_player(_inscricao(), "u1")
        assert r.player_id == PLAYER
        # gera a transacao de entrada
        entradas = [t for t in fake.store["transactions"] if t["type"] == "buy_in"]
        assert len(entradas) == 1
        assert float(entradas[0]["amount"]) == 100.0

    def test_rake_vem_do_dia_quando_nao_ha_tipo_de_buy(self, monkeypatch):
        fake = _monta(monkeypatch, dia=_dia(buy_in=100, rake=20))
        TournamentPlayerService.register_player(_inscricao(), "u1")
        entrada = fake.store["transactions"][0]
        assert float(entrada["rake_amount"]) == 20.0

    def test_rake_do_tipo_de_buy_tem_precedencia(self, monkeypatch):
        """Cada tipo de buy tem o proprio rake; ignorar isso faria o rake da
        etapa fechar diferente do combinado."""
        fake = _monta(monkeypatch, dia=_dia(buy_in=100, rake=20), tabelas={
            "buy_types": [{"id": "bt1", "name": "Turbo", "rake_percentage": 5,
                           "amount": 100, "category": "buy_in"}],
        })
        TournamentPlayerService.register_player(_inscricao(buy_type_id="bt1"), "u1")
        entrada = fake.store["transactions"][0]
        assert float(entrada["rake_amount"]) == 5.0

    def test_inscricao_duplicada_no_mesmo_dia_e_recusada(self, monkeypatch):
        _monta(monkeypatch, jogadores=[{
            "id": TP, "tournament_id": TOUR, "tournament_day_id": DIA,
            "player_id": PLAYER, "status": "active",
        }])
        arg = _inscricao()
        with pytest.raises(ValueError, match="já está registrado"):
            TournamentPlayerService.register_player(arg, "u1")

    def test_dia_cheio_recusa_novo_jogador(self, monkeypatch):
        """Aceitar acima do limite deixaria alguem sem assento."""
        _monta(monkeypatch, dia=_dia(max_players=10, registrados=10))
        arg = _inscricao()
        with pytest.raises(ValueError, match="cheio"):
            TournamentPlayerService.register_player(arg, "u1")

    def test_torneio_inexistente_e_recusado(self, monkeypatch):
        _monta(monkeypatch, tabelas={"tournaments": []})
        arg = _inscricao()
        with pytest.raises(ValueError, match="Tournament not found"):
            TournamentPlayerService.register_player(arg, "u1")

    def test_dia_inexistente_e_recusado(self, monkeypatch):
        _monta(monkeypatch, tabelas={"tournament_days": []})
        arg = _inscricao()
        with pytest.raises(ValueError, match="Tournament day not found"):
            TournamentPlayerService.register_player(arg, "u1")

    def test_entrega_as_fichas_iniciais(self, monkeypatch):
        fake = _monta(monkeypatch, dia=_dia(chips=25000))
        TournamentPlayerService.register_player(_inscricao(), "u1")
        assert fake.store["tournament_players"][0]["total_chips"] == 25000


class TestRebuyEAddon:
    def _com_jogador(self, monkeypatch, **kw):
        jogador = {
            "id": TP, "tournament_id": TOUR, "tournament_day_id": DIA,
            "player_id": PLAYER, "status": "active", "rebuy_count": 0, "addon_count": 0,
            "total_chips": 10000, "total_spent": 100,
            "total_buy_in_amount": 100, "total_rebuy_amount": 0, "total_addon_amount": 0,
            "created_at": "2026-06-08T00:00:00Z", "registered_at": "2026-06-08T00:00:00Z",
        }
        jogador.update(kw)
        return _monta(monkeypatch, jogadores=[jogador])

    def test_rebuy_soma_valor_fichas_e_contador(self, monkeypatch):
        fake = self._com_jogador(monkeypatch)
        TournamentPlayerService.add_rebuy(TP, "u1", skip_level_gate=True)
        linha = fake.store["tournament_players"][0]
        assert linha["rebuy_count"] == 1
        assert linha["total_chips"] == 20000
        rebuys = [t for t in fake.store["transactions"] if t["type"] == "rebuy"]
        assert len(rebuys) == 1

    def test_addon_soma_contador_proprio(self, monkeypatch):
        fake = self._com_jogador(monkeypatch)
        TournamentPlayerService.add_addon(TP, "u1")
        assert fake.store["tournament_players"][0]["addon_count"] == 1

    def test_jogador_inexistente_e_recusado(self, monkeypatch):
        _monta(monkeypatch)
        with pytest.raises(ValueError):
            TournamentPlayerService.add_rebuy("nao-existe", "u1", skip_level_gate=True)

    def test_dois_rebuys_acumulam(self, monkeypatch):
        """Dois rebuys seguidos no mesmo jogador nao podem se sobrescrever."""
        fake = self._com_jogador(monkeypatch)
        TournamentPlayerService.add_rebuy(TP, "u1", skip_level_gate=True)
        TournamentPlayerService.add_rebuy(TP, "u1", skip_level_gate=True)
        assert fake.store["tournament_players"][0]["rebuy_count"] == 2


class TestEliminacao:
    def _ativo(self, monkeypatch):
        return _monta(monkeypatch, jogadores=[{
            "id": TP, "tournament_id": TOUR, "tournament_day_id": DIA,
            "player_id": PLAYER, "status": "active", "rebuy_count": 0, "addon_count": 0,
            "total_chips": 10000, "total_spent": 100,
            "total_buy_in_amount": 100, "total_rebuy_amount": 0, "total_addon_amount": 0,
            "created_at": "2026-06-08T00:00:00Z", "registered_at": "2026-06-08T00:00:00Z",
        }])

    def test_marca_como_eliminado(self, monkeypatch):
        fake = self._ativo(monkeypatch)
        TournamentPlayerService.eliminate_player(TP, "u1")
        assert fake.store["tournament_players"][0]["status"] == "eliminated"

    def test_eliminar_duas_vezes_com_idempotente_nao_estoura(self, monkeypatch):
        """O replay da fila offline pode reenviar a mesma eliminacao."""
        self._ativo(monkeypatch)
        TournamentPlayerService.eliminate_player(TP, "u1")
        TournamentPlayerService.eliminate_player(TP, "u1", idempotent=True)

    def test_atualizacao_direta_muda_o_status(self, monkeypatch):
        fake = self._ativo(monkeypatch)
        TournamentPlayerService.eliminate_player(TP, "u1")
        TournamentPlayerService.update_tournament_player(
            TP, TournamentPlayerUpdate(status="active")
        )
        assert fake.store["tournament_players"][0]["status"] == "active"


class TestListagens:
    def test_lista_por_torneio(self, monkeypatch):
        _monta(monkeypatch, jogadores=[{
            "id": TP, "tournament_id": TOUR, "tournament_day_id": DIA,
            "player_id": PLAYER, "status": "active", "rebuy_count": 0, "addon_count": 0,
            "total_chips": 10000, "total_spent": 100,
            "total_buy_in_amount": 100, "total_rebuy_amount": 0, "total_addon_amount": 0,
            "created_at": "2026-06-08T00:00:00Z", "registered_at": "2026-06-08T00:00:00Z",
            "players": {"name": "Fulano", "nickname": "fu"},
        }])
        r = TournamentPlayerService.get_tournament_players(TOUR)
        assert len(r) == 1

    def test_torneio_vazio_devolve_lista_vazia(self, monkeypatch):
        _monta(monkeypatch)
        assert TournamentPlayerService.get_tournament_players(TOUR) == []


class TestBloqueioDeVendas:
    """Encerrado o registro tardio, o Caixa precisa PARAR de vender.

    Desabilitar o botao na tela nao basta: a fila offline e qualquer chamada
    direta a API continuariam passando. A trava tem de valer no servidor.
    """

    def _inscrito(self, dia=None):
        """Inscrito com o DIA embutido, como o PostgREST devolve no join.

        O embed do rebuy/add-on passou a trazer tambem `sales_blocked`: e' o
        que permite checar a trava do dia SEM uma segunda ida ao banco. Por
        isso o dia inteiro entra aqui — o fake nao resolve joins sozinho.
        """
        return [{
            "id": TP, "tournament_id": TOUR, "tournament_day_id": DIA,
            "player_id": PLAYER, "status": "active", "rebuy_count": 0, "addon_count": 0,
            "total_chips": 10000, "total_spent": 100,
            "total_buy_in_amount": 100, "total_rebuy_amount": 0, "total_addon_amount": 0,
            "created_at": "2026-06-08T00:00:00Z", "registered_at": "2026-06-08T00:00:00Z",
            "tournament_days": dict(dia or _dia()),
        }]

    def test_dia_bloqueado_recusa_a_inscricao_e_nao_cobra(self, monkeypatch):
        dia = _dia()
        dia["sales_blocked"] = True
        dia["sales_blocked_reason"] = "registro tardio encerrado"
        fake = _monta(monkeypatch, dia=dia)
        inscricao = _inscricao()   # preparo fora do raises: só o servico sob teste dentro

        with pytest.raises(ValueError, match="registro tardio encerrado"):
            TournamentPlayerService.register_player(inscricao, "u1")

        # Nada de meio-termo: nem inscricao, nem transacao.
        assert fake.store["tournament_players"] == []
        assert fake.store["transactions"] == []

    def test_dia_bloqueado_recusa_rebuy_e_addon(self, monkeypatch):
        dia = _dia()
        dia["sales_blocked"] = True
        fake = _monta(monkeypatch, dia=dia, jogadores=self._inscrito(dia))

        with pytest.raises(ValueError, match="Vendas bloqueadas"):
            TournamentPlayerService.add_rebuy(TP, "u1")
        with pytest.raises(ValueError, match="Vendas bloqueadas"):
            TournamentPlayerService.add_addon(TP, "u1")

        assert fake.store["transactions"] == []
        assert fake.store["tournament_players"][0]["rebuy_count"] == 0
        assert fake.store["tournament_players"][0]["addon_count"] == 0

    def test_etapa_bloqueada_vale_mesmo_com_o_dia_liberado(self, monkeypatch):
        """Chave-mestra do diretor: 'fecha tudo agora'."""
        fake = _monta(monkeypatch, tabelas={
            "tournaments": [{
                "id": TOUR, "name": "Torneio A", "stage_id": "e1",
                "stages": {"sales_blocked": True, "sales_blocked_reason": "evento encerrado"},
            }],
        })
        inscricao = _inscricao()   # preparo fora do raises: só o servico sob teste dentro
        with pytest.raises(ValueError, match="evento encerrado"):
            TournamentPlayerService.register_player(inscricao, "u1")
        assert fake.store["transactions"] == []

    def test_sem_bloqueio_a_venda_segue_normal(self, monkeypatch):
        fake = _monta(monkeypatch)
        TournamentPlayerService.register_player(_inscricao(), "u1")
        assert len(fake.store["transactions"]) == 1

    def test_replay_offline_ignora_o_bloqueio(self, monkeypatch):
        """A venda aconteceu ANTES do bloqueio, com o operador sem rede.
        Rejeita-la no sync perderia dinheiro que ja esta na gaveta dele."""
        dia = _dia()
        dia["sales_blocked"] = True
        fake = _monta(monkeypatch, dia=dia)
        TournamentPlayerService.register_player(_inscricao(), "u1", skip_sales_block=True)
        assert len(fake.store["transactions"]) == 1

    def test_linha_sem_o_flag_nao_bloqueia_nada(self, monkeypatch):
        """Dia gravado antes da migracao: a linha simplesmente nao traz o flag,
        e ausencia de flag e' venda liberada."""
        fake = _monta(monkeypatch)   # dia sem a coluna sales_blocked
        TournamentPlayerService.register_player(_inscricao(), "u1")
        assert len(fake.store["transactions"]) == 1

    # ── Tolerancia REAL a' migracao pendente ────────────────────────────────
    # O FakeSupabase ignora a string do select, entao a consulta com o embed
    # `stages(sales_blocked, ...)` nunca falha sozinha e o try/except do
    # servico — o mecanismo que faz o backend novo conviver com o banco antigo —
    # ficava sem cobertura. Estes testes forcam o erro na consulta certa.

    def _quebrar_a_consulta_do_bloqueio(self, monkeypatch, fake, erro):
        """Faz SO' a consulta que cita `sales_blocked` estourar."""
        original = fake.table

        class _Espiao:
            def __init__(self, q):
                self._q = q

            def select(self, *a, **k):
                if a and "sales_blocked" in str(a[0]):
                    raise erro
                return self._q.select(*a, **k)

            def __getattr__(self, nome):
                return getattr(self._q, nome)

        monkeypatch.setattr(
            fake, "table",
            lambda nome: _Espiao(original(nome)) if nome == "tournaments" else original(nome),
        )

    def test_coluna_ainda_nao_migrada_nao_impede_a_venda(self, monkeypatch):
        """Backend novo + migracao ainda nao aplicada: e' o dia do deploy. Parar
        de vender por causa disso seria pior que a doenca."""
        fake = _monta(monkeypatch)
        self._quebrar_a_consulta_do_bloqueio(
            monkeypatch, fake,
            Exception('column stages.sales_blocked does not exist'),
        )
        TournamentPlayerService.register_player(_inscricao(), "u1")
        assert len(fake.store["transactions"]) == 1

    # ── Uma politica so' quando a consulta da trava falha ───────────────────
    # A trava e' controle SECUNDARIO e fica desligada na quase totalidade das
    # noites. Recusar a venda por causa de um soluco de 3 s do PostgREST parava
    # o Caixa do clube inteiro, com a fila no balcao e sem contorno — e nem
    # protegia dinheiro: com o banco fora, o INSERT da venda falha logo depois.
    # Agora as DUAS consultas (dia e etapa) seguem em frente e registram a
    # falha; antes cada uma fazia uma coisa diferente no mesmo pedido.

    def test_falha_de_rede_na_consulta_da_etapa_nao_para_a_venda(self, monkeypatch, caplog):
        fake = _monta(monkeypatch)
        self._quebrar_a_consulta_do_bloqueio(
            monkeypatch, fake, Exception("timeout of 30000ms exceeded"))
        with caplog.at_level("ERROR"):
            TournamentPlayerService.register_player(_inscricao(), "u1")
        assert len(fake.store["transactions"]) == 1
        # Passar nao pode ser em silencio: a falha fica auditavel no log.
        assert any("Trava de vendas NÃO verificada" in r.message for r in caplog.records)

    def test_falha_ao_ler_o_dia_segue_a_mesma_politica(self, monkeypatch, caplog):
        """Duas politicas opostas para o mesmo risco, no mesmo pedido, era o
        pior dos mundos: o operador nao tinha como saber se a venda ia entrar."""
        _monta(monkeypatch)
        fake = FakeSupabase({})

        def _explode(_nome):
            raise Exception("connection reset by peer")

        monkeypatch.setattr(fake, "table", _explode)
        monkeypatch.setattr(sales_block_service, "supabase", fake)
        with caplog.at_level("ERROR"):
            SalesBlockService.assert_sales_allowed(TOUR, DIA)
        assert any("Trava de vendas NÃO verificada" in r.message for r in caplog.records)


class TestBloqueioNaVendaAvulsa:
    """POST /transactions tambem move caixa, prize pool e fidelidade.

    Essa rota nao recebe o dia no corpo, entao o bloqueio FINO (o Dia 1A
    encerrado enquanto o 1B continua vendendo) so' vale se o dia for descoberto
    pela inscricao do jogador. Sem isso o diretor encerra o registro tardio e o
    dinheiro continua entrando por fora.
    """

    def _inscrito(self):
        return [{
            "id": TP, "tournament_id": TOUR, "tournament_day_id": DIA,
            "player_id": PLAYER, "status": "active",
        }]

    def test_encontra_o_dia_pelo_jogador_inscrito_e_barra(self, monkeypatch):
        dia = _dia()
        dia["sales_blocked"] = True
        dia["sales_blocked_reason"] = "registro tardio encerrado"
        _monta(monkeypatch, dia=dia, jogadores=self._inscrito())
        with pytest.raises(ValueError, match="registro tardio encerrado"):
            SalesBlockService.assert_day_sales_allowed(TOUR, PLAYER, "buy_in")

    def test_dia_liberado_deixa_a_venda_passar(self, monkeypatch):
        _monta(monkeypatch, jogadores=self._inscrito())
        SalesBlockService.assert_day_sales_allowed(TOUR, PLAYER, "buy_in")

    def test_premio_nao_e_venda_e_nao_e_barrado(self, monkeypatch):
        """Pagar premiacao e' SAIDA de caixa: o clube paga justamente depois de
        encerrar as vendas."""
        dia = _dia()
        dia["sales_blocked"] = True
        _monta(monkeypatch, dia=dia, jogadores=self._inscrito())
        SalesBlockService.assert_day_sales_allowed(TOUR, PLAYER, "prize")

    # ── Jogador inscrito em DOIS dias do mesmo torneio (1A e 1B) ────────────
    # Desde a inscricao por dia o mesmo jogador tem uma linha por dia. Sem
    # ORDER BY, o banco devolvia as linhas na ordem que quisesse e a trava
    # sorteava qual dia checar: no balcao isso vira "as vezes deixa vender, as
    # vezes nao", com a fila esperando.

    def _dois_dias(self, monkeypatch, ordem):
        """1A (inscricao mais ANTIGA, BLOQUEADO) e 1B (liberado).

        `ordem` diz em que ordem o banco devolve as inscricoes.
        """
        dia_a = _dia()
        dia_a["sales_blocked"] = True
        dia_a["sales_blocked_reason"] = "registro tardio do 1A encerrado"
        dia_b = _dia()
        dia_b["id"] = DIA_1B
        inscricoes = {
            "1a": {"id": TP, "tournament_id": TOUR, "tournament_day_id": DIA,
                   "player_id": PLAYER, "status": "active",
                   "registered_at": "2026-06-08T18:00:00Z"},
            "1b": {"id": TP_1B, "tournament_id": TOUR, "tournament_day_id": DIA_1B,
                   "player_id": PLAYER, "status": "active",
                   "registered_at": "2026-06-09T18:00:00Z"},
        }
        return _monta(
            monkeypatch,
            jogadores=[inscricoes[k] for k in ordem],
            tabelas={"tournament_days": [dia_a, dia_b]},
        )

    def test_o_dia_da_venda_nao_depende_da_ordem_que_o_banco_devolve(self, monkeypatch):
        """Mesma inscricao escolhida sempre, venha o banco na ordem que vier."""
        for ordem in (["1a", "1b"], ["1b", "1a"]):
            self._dois_dias(monkeypatch, ordem)
            assert SalesBlockService.dia_da_venda(TOUR, PLAYER) == DIA

    def test_o_dia_checado_e_o_mesmo_que_a_venda_vai_gravar(self, monkeypatch):
        """A venda avulsa grava `tournament_player_id` na inscricao mais antiga.
        Se a trava checasse outro dia, o dinheiro entraria num dia que o diretor
        encerrou — ou seria recusado num dia aberto."""
        self._dois_dias(monkeypatch, ["1b", "1a"])
        with pytest.raises(ValueError, match="registro tardio do 1A encerrado"):
            SalesBlockService.assert_day_sales_allowed(TOUR, PLAYER, "buy_in")

    # ── A ETAPA sai daqui: quem checa e' create_transaction ─────────────────
    # A etapa era consultada DUAS vezes por venda (uma na rota, outra no
    # service). Numa noite de mil vendas sao mil idas ao banco a toa, no ponto
    # mais quente do sistema. Agora a rota checa so' o DIA (que so' ela sabe
    # descobrir) e a ETAPA fica com o service, que roda para TODO mundo.

    def test_a_rota_nao_consulta_mais_a_etapa(self, monkeypatch):
        _monta(monkeypatch, jogadores=self._inscrito(), tabelas={
            "tournaments": [{
                "id": TOUR, "name": "Torneio A", "stage_id": "e1",
                "stages": {"sales_blocked": True, "sales_blocked_reason": "evento encerrado"},
            }],
        })
        # Etapa bloqueada, dia liberado: aqui isto NAO barra mais nada.
        SalesBlockService.assert_day_sales_allowed(TOUR, PLAYER, "buy_in")

    def test_a_chave_mestra_da_etapa_continua_valendo_na_venda_avulsa(self, monkeypatch):
        """Teste-guarda: se alguem tirar `assert_sales_allowed` de
        `create_transaction`, a chave-mestra do diretor para de valer no POST
        /transactions e nada mais denunciaria isso."""
        from app.services import transaction_service
        from app.services.transaction_service import TransactionService
        from app.models.transaction import TransactionCreate

        fake = _monta(monkeypatch, tabelas={
            "tournaments": [{
                "id": TOUR, "name": "Torneio A", "stage_id": "e1",
                "stages": {"sales_blocked": True, "sales_blocked_reason": "evento encerrado"},
            }],
        })
        monkeypatch.setattr(transaction_service, "supabase", fake)
        venda = TransactionCreate(
            tournament_id=TOUR, player_id=PLAYER, type="buy_in", amount=100,
        )
        with pytest.raises(ValueError, match="evento encerrado"):
            TransactionService.create_transaction(venda, "u1")
        assert fake.store["transactions"] == []


class TestCaminhoQuenteDaVenda:
    """O POST /transactions roda mil vezes por noite; o cancelamento e' excecao.

    A medicao registrada neste projeto e' clara: o gargalo aqui e' a CASCATA de
    chamadas, nao o banco. Cada consulta a menos por venda e' fila andando.
    """

    def _inscrito(self, dia=None):
        return [{
            "id": TP, "tournament_id": TOUR, "tournament_day_id": DIA,
            "player_id": PLAYER, "status": "active", "rebuy_count": 0, "addon_count": 0,
            "total_chips": 10000, "total_spent": 100,
            "total_buy_in_amount": 100, "total_rebuy_amount": 0, "total_addon_amount": 0,
            "created_at": "2026-06-08T00:00:00Z", "registered_at": "2026-06-08T00:00:00Z",
            "tournament_days": dict(dia or _dia()),
        }]

    def _contar_tabelas(self, monkeypatch, fake):
        contagem = {}
        original = fake.table

        def _table(nome):
            contagem[nome] = contagem.get(nome, 0) + 1
            return original(nome)

        monkeypatch.setattr(fake, "table", _table)
        return contagem

    def _quebrar_o_select_que_cita_a_trava(self, monkeypatch, fake, tabela, erro):
        """Faz SO' a leitura que cita `sales_blocked` estourar naquela tabela."""
        original = fake.table

        class _Espiao:
            def __init__(self, q):
                self._q = q

            def select(self, *a, **k):
                if a and "sales_blocked" in str(a[0]):
                    raise erro
                return self._q.select(*a, **k)

            def __getattr__(self, nome):
                return getattr(self._q, nome)

        monkeypatch.setattr(
            fake, "table",
            lambda nome: _Espiao(original(nome)) if nome == tabela else original(nome),
        )

    def test_a_recompra_nao_le_o_dia_uma_segunda_vez(self, monkeypatch):
        """A recompra ja' le o dia embutido no inscrito. Reler `tournament_days`
        so' para saber se esta' bloqueado era uma ida ao banco de graca em cada
        recompra — e recompra e' o que mais roda no balcao."""
        fake = _monta(monkeypatch, jogadores=self._inscrito())
        contagem = self._contar_tabelas(monkeypatch, fake)
        TournamentPlayerService.add_rebuy(TP, "u1", skip_level_gate=True)
        assert contagem.get("tournament_days", 0) == 0
        assert fake.store["tournament_players"][0]["rebuy_count"] == 1

    def test_o_addon_nao_le_o_dia_uma_segunda_vez(self, monkeypatch):
        fake = _monta(monkeypatch, jogadores=self._inscrito())
        contagem = self._contar_tabelas(monkeypatch, fake)
        TournamentPlayerService.add_addon(TP, "u1")
        assert contagem.get("tournament_days", 0) == 0
        assert fake.store["tournament_players"][0]["addon_count"] == 1

    def test_dia_embutido_como_lista_tambem_e_lido(self, monkeypatch):
        """O PostgREST as vezes devolve o embed como lista de um item. Tratar
        isso como 'sem dia' desligaria a trava justamente na recompra."""
        _monta(monkeypatch)
        dia = _dia()
        dia["sales_blocked"] = True
        dia["sales_blocked_reason"] = "registro tardio encerrado"
        with pytest.raises(ValueError, match="registro tardio encerrado"):
            SalesBlockService.assert_sales_allowed(TOUR, DIA, day_row=[dia])

    def test_dia_bloqueado_ainda_barra_a_recompra_pelo_dia_embutido(self, monkeypatch):
        """Economizar consulta nao pode custar a trava."""
        dia = _dia()
        dia["sales_blocked"] = True
        dia["sales_blocked_reason"] = "registro tardio encerrado"
        fake = _monta(monkeypatch, dia=dia, jogadores=self._inscrito(dia))
        with pytest.raises(ValueError, match="registro tardio encerrado"):
            TournamentPlayerService.add_rebuy(TP, "u1", skip_level_gate=True)
        assert fake.store["transactions"] == []

    def test_banco_sem_a_migracao_nao_derruba_a_recompra(self, monkeypatch):
        """Dia do deploy: o backend novo cita `sales_blocked` e o banco antigo
        nao tem a coluna. Se a leitura do inscrito morresse ai', o clube ficaria
        sem vender recompra ate' a migracao rodar."""
        fake = _monta(monkeypatch, jogadores=self._inscrito())
        self._quebrar_o_select_que_cita_a_trava(
            monkeypatch, fake, "tournament_players",
            Exception("column tournament_days.sales_blocked does not exist"),
        )
        TournamentPlayerService.add_rebuy(TP, "u1", skip_level_gate=True)
        assert fake.store["tournament_players"][0]["rebuy_count"] == 1

    def test_a_etapa_e_consultada_uma_vez_so_por_venda(self, monkeypatch, client):
        """A rota checava a etapa e o service checava DE NOVO: a mesma consulta
        duas vezes em cada venda registrada."""
        from app.services import transaction_service

        fake = _monta(monkeypatch, jogadores=self._inscrito())
        monkeypatch.setattr(transaction_service, "supabase", fake)

        vezes = {"n": 0}
        original = SalesBlockService._bloqueio_da_etapa

        def _contar(tournament_id):
            vezes["n"] += 1
            return original(tournament_id)

        monkeypatch.setattr(SalesBlockService, "_bloqueio_da_etapa", staticmethod(_contar))

        r = client.post("/transactions", json={
            "tournament_id": TOUR, "player_id": PLAYER,
            "type": "buy_in", "amount": 100,
        })
        assert r.status_code == 201
        assert vezes["n"] == 1
