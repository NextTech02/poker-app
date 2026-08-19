"""Cadastro de jogador: nome + sobrenome separados e documento que vale.

Os dois achados do teste de aceitação feito pelo dono do clube:

- **"Adicionaria um campo para o nome e outro para sobrenome."** As colunas
  first_name/last_name são novas, mas `name` CONTINUA preenchido — 93 arquivos
  do sistema (recibo de prêmio, alocação de mesa, ranking, tela de TV) leem
  players.name. Se o backend deixasse de manter `name` em dia, o jogador
  apareceria sem nome no recibo do prêmio.
- **"Coloquei um monte de 0 e aceitou."** O documento é o comprovante de quem
  recebeu dinheiro; a tela avisa cedo, mas quem VALE é o backend, porque a
  mesma API atende a importação, o replay da fila offline e qualquer cliente
  fora do navegador.

E a regra que protege o balcão: cadastro antigo ('national_id', um deles com
documento inválido) NÃO pode ser bloqueado — corrigir o telefone desse jogador
tem de continuar funcionando.
"""
import pytest
from fastapi import HTTPException

from app.models.player import PlayerCreate, PlayerUpdate, sincronizar_nome
from app.services import player_service as mod
from app.services.player_service import PlayerService as S

from tests.conftest import FakeSupabase

JOGADOR = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1"


def _linha(**kw):
    base = {
        "id": JOGADOR, "name": "Beto Silva Souza",
        "first_name": "Beto", "last_name": "Silva Souza",
        "email": "beto@clube.com", "phone": "11999998888", "nationality": "Brasil",
        "document_type": "cpf", "document_number": "52998224725",
        "created_at": "2026-06-08T00:00:00Z",
    }
    base.update(kw)
    return base


def _novo(**kw):
    base = {
        "first_name": "Ana", "last_name": "Costa Lima",
        "email": "ana@clube.com", "phone": "11988887777", "nationality": "Brasil",
        "document_type": "cpf", "document_number": "529.982.247-25",
    }
    base.update(kw)
    return PlayerCreate(**base)


@pytest.fixture
def banco(monkeypatch):
    fake = FakeSupabase({"players": []})
    monkeypatch.setattr(mod, "supabase", fake)
    return fake


class _QueryRecusada:
    """Query que estoura no execute(), como o Postgres faz com o CHECK."""

    def __init__(self, erro):
        self._erro = erro

    def __getattr__(self, nome):  # .eq(...), .select(...) continuam encadeando
        return lambda *a, **k: self

    def execute(self):
        raise RuntimeError(self._erro)


_CHECK_ANTIGO = (
    'new row for relation "players" violates check constraint '
    '"players_document_type_check"'
)


def _banco_sem_migracao(banco, monkeypatch, aceitos=("passport", "national_id", "driver_license")):
    """Banco com o CHECK ANTIGO: recusa cpf/dni/cedula.

    É o estado do banco enquanto db/migrations/database_migration_document_types
    não roda — e o formulário do balcão já abre em 'cpf'.
    """
    original = banco.table

    def table(nome):
        q = original(nome)
        for op in ("insert", "update"):
            metodo = getattr(q, op)

            def gravar(payload, *a, _metodo=metodo, **k):
                linhas = payload if isinstance(payload, list) else [payload]
                recusado = any(
                    lin.get("document_type") not in aceitos
                    for lin in linhas
                    if "document_type" in lin
                )
                return _QueryRecusada(_CHECK_ANTIGO) if recusado else _metodo(payload, *a, **k)

            setattr(q, op, gravar)
        return q

    monkeypatch.setattr(banco, "table", table)


class TestNomeESobrenome:
    def test_criar_com_nome_e_sobrenome_preenche_o_nome_completo(self, banco):
        """`name` é o que 93 telas mostram; sem ele o recibo do prêmio sai sem
        o nome de quem recebeu."""
        criado = S.create_player(_novo())
        assert criado.first_name == "Ana"
        assert criado.last_name == "Costa Lima"
        assert criado.name == "Ana Costa Lima"
        assert banco.store["players"][0]["name"] == "Ana Costa Lima"

    def test_cliente_antigo_manda_so_o_nome_e_o_sobrenome_e_deduzido(self, banco):
        """O deploy não é atômico: o frontend anterior continua no ar mandando
        só `name`. A divisão é no PRIMEIRO espaço."""
        S.create_player(_novo(first_name=None, last_name=None,
                              name="José Felipe Pinto Faria"))
        gravado = banco.store["players"][0]
        assert gravado["first_name"] == "José"
        assert gravado["last_name"] == "Felipe Pinto Faria"
        assert gravado["name"] == "José Felipe Pinto Faria"

    def test_nome_de_uma_palavra_so_fica_sem_sobrenome(self, banco):
        """1 dos 11 cadastros de hoje não tem espaço no nome — não pode virar
        sobrenome repetido ('Madonna Madonna')."""
        S.create_player(_novo(first_name=None, last_name=None, name="Madonna"))
        gravado = banco.store["players"][0]
        assert gravado["first_name"] == "Madonna"
        assert gravado["last_name"] is None
        assert gravado["name"] == "Madonna"

    def test_espaco_duplicado_nao_entra_no_sobrenome(self, banco):
        """"Adam  Louis" gravado assim deixaria a busca por sobrenome falhando
        para sempre."""
        S.create_player(_novo(first_name=None, last_name=None,
                              name="Adam  Louis   Ross"))
        gravado = banco.store["players"][0]
        assert gravado["first_name"] == "Adam"
        assert gravado["last_name"] == "Louis Ross"
        assert gravado["name"] == "Adam Louis Ross"

    def test_sobrenome_com_espacos_nas_pontas_nao_suja_o_nome_completo(self, banco):
        S.create_player(_novo(first_name="  Ana ", last_name=" Costa  Lima "))
        assert banco.store["players"][0]["name"] == "Ana Costa Lima"

    def test_editar_so_o_sobrenome_remonta_o_nome_completo(self, banco):
        """Casou e mudou de sobrenome: `name` tem de acompanhar, senão a tela
        de TV segue chamando o nome antigo."""
        banco.store["players"].append(_linha())
        atualizado = S.update_player(JOGADOR, PlayerUpdate(last_name="Andrade"))
        assert atualizado.first_name == "Beto"
        # A conferência é no que FICOU GRAVADO: é a coluna `name` que as 93
        # telas leem depois, não o objeto devolvido nesta resposta.
        assert banco.store["players"][0]["name"] == "Beto Andrade"

    def test_editar_so_o_nome_completo_redivide_as_partes(self, banco):
        """PATCH do cliente antigo (só `name`) não pode deixar first/last
        apontando para o nome anterior."""
        banco.store["players"].append(_linha())
        S.update_player(JOGADOR, PlayerUpdate(name="Carlos Dias"))
        gravado = banco.store["players"][0]
        assert (gravado["first_name"], gravado["last_name"]) == ("Carlos", "Dias")
        assert gravado["name"] == "Carlos Dias"

    def test_linha_antiga_sem_as_colunas_novas_ainda_divide(self, banco):
        """Enquanto a migração não roda, a linha só tem `name`: editar o
        sobrenome precisa achar o primeiro nome do mesmo jeito."""
        banco.store["players"].append(
            {k: v for k, v in _linha().items() if k not in ("first_name", "last_name")}
        )
        S.update_player(JOGADOR, PlayerUpdate(last_name="Andrade"))
        assert banco.store["players"][0]["name"] == "Beto Andrade"

    def test_editar_outro_campo_nao_mexe_no_nome(self, banco):
        banco.store["players"].append(_linha())
        S.update_player(JOGADOR, PlayerUpdate(phone="11900000000"))
        gravado = banco.store["players"][0]
        assert gravado["name"] == "Beto Silva Souza"
        assert gravado["last_name"] == "Silva Souza"

    def test_jogador_lido_do_banco_sem_as_colunas_novas_nao_quebra(self, banco):
        """GET de linha antiga (pré-migração) tem de responder com as partes
        deduzidas, não com erro de validação."""
        banco.store["players"].append(
            {k: v for k, v in _linha().items() if k not in ("first_name", "last_name")}
        )
        lido = S.get_player(JOGADOR)
        assert (lido.first_name, lido.last_name) == ("Beto", "Silva Souza")


class TestBuscaDoBalcao:
    """A busca é usada no Caixa, com fila esperando."""

    def _espiar(self, banco, monkeypatch):
        filtros = []
        original = banco.table

        def table(nome):
            q = original(nome)
            or_original = q.or_

            def or_(expr, *a, **k):
                filtros.append(expr)
                return or_original(expr, *a, **k)

            q.or_ = or_
            return q

        monkeypatch.setattr(banco, "table", table)
        return filtros

    def test_a_busca_continua_sobre_o_nome_completo(self, banco, monkeypatch):
        """`name` é "first_name last_name", então um ilike só acha por nome,
        por sobrenome ou pelos dois juntos — inclusive nas linhas em que a
        migração ainda não rodou."""
        filtros = self._espiar(banco, monkeypatch)
        S.get_players(search="silva")
        assert filtros == ["name.ilike.%silva%,nickname.ilike.%silva%"]

    def test_espaco_extra_digitado_nao_zera_o_resultado(self, banco, monkeypatch):
        """Quem digita "beto  silva" no balcão não pode ouvir "não achei"."""
        filtros = self._espiar(banco, monkeypatch)
        S.get_players(search="  beto   silva ")
        assert filtros == ["name.ilike.%beto silva%,nickname.ilike.%beto silva%"]


class TestDocumento:
    def test_um_monte_de_zero_e_recusado(self, banco):
        """O achado do dono do clube. Recibo com documento 00000000000 não
        vale nada na prestação de contas."""
        # O payload é montado FORA do bloco: dentro do `raises` fica só a
        # chamada sob teste, para a exceção não poder vir da montagem.
        dados = _novo(document_number="00000000000")
        with pytest.raises(HTTPException) as exc:
            S.create_player(dados)
        assert exc.value.status_code == 400
        assert banco.store["players"] == []

    def test_cpf_com_digito_errado_e_recusado(self, banco):
        dados = _novo(document_number="52998224726")
        with pytest.raises(HTTPException) as exc:
            S.create_player(dados)
        assert exc.value.status_code == 400

    def test_sequencia_trivial_e_recusada(self, banco):
        dados = _novo(document_type="dni", document_number="12345678")
        with pytest.raises(HTTPException) as exc:
            S.create_player(dados)
        assert exc.value.status_code == 400
        assert banco.store["players"] == []

    def test_documento_valido_e_gravado_sem_pontuacao(self, banco):
        """Guardar normalizado é o que impede "529.982.247-25" e "52998224725"
        virarem dois jogadores diferentes."""
        criado = S.create_player(_novo())
        assert criado.document_number == "52998224725"

    def test_tipo_desconhecido_e_recusado_com_frase_de_tela(self, banco):
        dados = _novo(document_type="rg")
        with pytest.raises(HTTPException) as exc:
            S.create_player(dados)
        assert exc.value.status_code == 400
        assert isinstance(exc.value.detail, str)

    def test_dni_do_peru_e_cedula_da_colombia_sao_aceitos(self, banco):
        """O clube opera em Brasil, Peru e Colômbia."""
        assert S.create_player(_novo(document_type="dni", document_number="10293847")).document_number == "10293847"
        assert S.create_player(
            _novo(email="b@c.com", document_type="cedula", document_number="1020304050")
        ).document_number == "1020304050"

    def test_cadastro_legado_invalido_continua_editavel(self, banco):
        """O jogador legado com documento inválido não pode travar o balcão:
        corrigir o telefone dele tem de passar."""
        banco.store["players"].append(
            _linha(document_type="national_id", document_number="00000000000")
        )
        atualizado = S.update_player(JOGADOR, PlayerUpdate(phone="11900000000"))
        assert atualizado.phone == "11900000000"

    def test_reenviar_o_documento_legado_invalido_nao_bloqueia(self, banco):
        """A tela manda o formulário inteiro ao salvar; o documento antigo volta
        junto mesmo quando o operador só mexeu no e-mail."""
        banco.store["players"].append(
            _linha(document_type="national_id", document_number="00000000000")
        )
        atualizado = S.update_player(JOGADOR, PlayerUpdate(
            email="novo@clube.com", document_type="national_id",
            document_number="00000000000",
        ))
        assert atualizado.email == "novo@clube.com"

    def test_trocar_o_documento_para_um_tipo_novo_passa_a_valer_a_regra(self, banco):
        banco.store["players"].append(
            _linha(document_type="national_id", document_number="00000000000")
        )
        dados = PlayerUpdate(document_type="cpf")
        with pytest.raises(HTTPException) as exc:
            S.update_player(JOGADOR, dados)
        assert exc.value.status_code == 400

    def test_mudar_so_o_numero_valida_com_o_tipo_ja_gravado(self, banco):
        """O PATCH não manda o tipo; sem ler a linha atual, um CPF errado
        entraria por falta de contexto."""
        banco.store["players"].append(_linha())
        dados = PlayerUpdate(document_number="11111111111")
        with pytest.raises(HTTPException) as exc:
            S.update_player(JOGADOR, dados)
        assert exc.value.status_code == 400


class TestOrdemDoDeploy:
    """O cadastro no balcão não pode depender de a migração já ter rodado.

    O formulário abre com 'cpf', mas o CHECK do banco só passa a aceitar os
    tipos por país depois de database_migration_document_types.sql. Se a tela
    subir antes, TODO cadastro novo estouraria no Postgres — com a fila
    esperando. O número do documento é o que vale no recibo; o tipo do país
    pode esperar a migração.
    """

    def test_cadastro_novo_entra_com_o_tipo_legado_quando_falta_a_migracao(self, banco, monkeypatch):
        _banco_sem_migracao(banco, monkeypatch)
        criado = S.create_player(_novo())
        assert criado.document_number == "52998224725"
        assert banco.store["players"][0]["document_type"] == "national_id"
        assert banco.store["players"][0]["name"] == "Ana Costa Lima"

    def test_tipo_que_o_banco_antigo_ja_aceitava_nao_e_trocado(self, banco, monkeypatch):
        """Só desce para o legado quem o CHECK antigo recusaria."""
        _banco_sem_migracao(banco, monkeypatch)
        criado = S.create_player(_novo(document_type="passport", document_number="AB123456"))
        assert criado.document_type == "passport"

    def test_edicao_do_documento_tambem_sobrevive_a_falta_da_migracao(self, banco, monkeypatch):
        banco.store["players"].append(_linha(document_type="national_id", document_number="123456"))
        _banco_sem_migracao(banco, monkeypatch)
        S.update_player(JOGADOR, PlayerUpdate(document_type="cpf", document_number="52998224725"))
        gravado = banco.store["players"][0]
        assert gravado["document_number"] == "52998224725"
        assert gravado["document_type"] == "national_id"

    def test_documento_invalido_continua_recusado_antes_de_chegar_ao_banco(self, banco, monkeypatch):
        """Tolerar o banco antigo não é tolerar documento ruim."""
        _banco_sem_migracao(banco, monkeypatch)
        dados = _novo(document_number="00000000000")
        with pytest.raises(HTTPException) as exc:
            S.create_player(dados)
        assert exc.value.status_code == 400
        assert banco.store["players"] == []

    def test_falha_que_nao_e_de_migracao_continua_estourando(self, banco, monkeypatch):
        """Sem engolir erro de verdade (e sem ficar tentando para sempre)."""
        original = banco.table

        def table(nome):
            q = original(nome)
            q.insert = lambda *a, **k: _QueryRecusada("connection reset by peer")
            return q

        monkeypatch.setattr(banco, "table", table)
        dados = _novo()
        with pytest.raises(RuntimeError, match="connection reset by peer"):
            S.create_player(dados)


class TestDocumentoJaGravado:
    """Quem opera precisa conseguir corrigir o telefone AGORA.

    Documento inválido entrou em lote pela planilha antiga (a importação não
    validava). Se a régua batesse no que já está gravado, esse jogador ficaria
    impossível de editar — e a tela manda o formulário INTEIRO ao salvar.
    """

    def test_reenviar_o_documento_ja_gravado_nao_bloqueia_outro_campo(self, banco):
        banco.store["players"].append(_linha(document_type="passport", document_number="AB1"))
        atualizado = S.update_player(JOGADOR, PlayerUpdate(
            phone="11900000000", document_type="passport", document_number="AB1",
        ))
        assert atualizado.phone == "11900000000"

    def test_mascara_diferente_ainda_conta_como_o_mesmo_documento(self, banco):
        banco.store["players"].append(_linha(document_type="cedula", document_number="12345"))
        atualizado = S.update_player(JOGADOR, PlayerUpdate(
            phone="11900000000", document_type="cedula", document_number="1.23-45",
        ))
        assert atualizado.phone == "11900000000"
        assert banco.store["players"][0]["document_number"] == "12345"

    def test_documento_novo_invalido_continua_recusado(self, banco):
        """A tolerância é só para o valor que já estava lá."""
        banco.store["players"].append(_linha(document_type="passport", document_number="AB1"))
        dados = PlayerUpdate(document_number="AB2")
        with pytest.raises(HTTPException) as exc:
            S.update_player(JOGADOR, dados)
        assert exc.value.status_code == 400


class TestPatchParcialDoNome:
    """PATCH que não pode ser aplicado é 400 — nunca descarte calado.

    Pela tela não acontece (o formulário exige o nome), mas acontece pelo
    replay da fila offline, pela importação e por qualquer cliente HTTP.
    """

    def test_apagar_o_nome_mandando_so_o_sobrenome_e_recusado(self, banco):
        banco.store["players"].append(_linha())
        dados = PlayerUpdate(first_name="", last_name="Silva")
        with pytest.raises(HTTPException) as exc:
            S.update_player(JOGADOR, dados)
        assert exc.value.status_code == 400
        # E nada foi gravado pela metade.
        assert banco.store["players"][0]["name"] == "Beto Silva Souza"

    def test_apagar_so_o_primeiro_nome_tambem_e_recusado(self, banco):
        banco.store["players"].append(_linha())
        dados = PlayerUpdate(first_name="   ")
        with pytest.raises(HTTPException) as exc:
            S.update_player(JOGADOR, dados)
        assert exc.value.status_code == 400

    def test_apagar_so_o_sobrenome_continua_valendo(self, banco):
        """Isso é edição legítima: o jogador passa a ter só o primeiro nome."""
        banco.store["players"].append(_linha())
        S.update_player(JOGADOR, PlayerUpdate(first_name="Beto", last_name=""))
        gravado = banco.store["players"][0]
        assert gravado["name"] == "Beto"
        assert gravado["last_name"] is None


class TestSincronizarNome:
    """Espelho do trigger do banco (database_migration_player_first_last_name).

    As duas pontas precisam concordar: o banco divide quem grava só `name`, e
    o backend divide antes de gravar. Divergir aqui cria jogador com sobrenome
    diferente do que aparece no recibo.
    """

    @pytest.mark.parametrize("entrada,esperado", [
        ({"name": "José Felipe Pinto"}, ("José", "Felipe Pinto", "José Felipe Pinto")),
        ({"name": "Madonna"}, ("Madonna", None, "Madonna")),
        ({"first_name": "Ana", "last_name": "Costa"}, ("Ana", "Costa", "Ana Costa")),
        ({"first_name": "Ana"}, ("Ana", None, "Ana")),
        # As partes mandam: `name` desatualizado é reescrito, não o contrário.
        ({"name": "Ana Antiga", "first_name": "Ana", "last_name": "Nova"},
         ("Ana", "Nova", "Ana Nova")),
    ])
    def test_divisao_e_remontagem(self, entrada, esperado):
        r = sincronizar_nome(entrada)
        assert (r.get("first_name"), r.get("last_name"), r.get("name")) == esperado

    def test_nao_altera_o_dicionario_recebido(self):
        entrada = {"name": "Ana Costa"}
        sincronizar_nome(entrada)
        assert entrada == {"name": "Ana Costa"}
