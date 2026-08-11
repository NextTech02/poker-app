"""Testes da importacao de jogadores vinda de outro sistema.

A normalizacao e onde tudo se decide: o arquivo do concorrente vem com dado
sujo de anos de digitacao (telefone "1", documento em branco, data em formato
brasileiro). Aceitar lixo cria cadastro ruim; recusar demais faz o clube
perder a base inteira.
"""
import pytest

from app.services.player_import_service import PlayerImportService as S


def _linha(**kw):
    base = {
        "source_id": "100", "name": "Fulano de Tal", "nickname": "fu",
        "email": "fulano@exemplo.com", "phone": "11999998888", "mobile": "",
        "nationality": "Brasil", "doc_country": "Brasil",
        "document_type": "RG", "document_number": "123456",
        "birth_date": "18/07/2004",
    }
    base.update(kw)
    return base


class TestNormalizacao:
    def test_registro_completo_e_aceito(self):
        prontos, rejeitados = S._preparar([_linha()])
        assert len(prontos) == 1
        assert rejeitados == []

    def test_espacos_duplicados_no_nome_sao_colapsados(self):
        """O export traz "Adam  Louis Ross"; gravar assim deixaria a busca por
        nome falhando para sempre."""
        prontos, _ = S._preparar([_linha(name="Adam  Louis   Ross")])
        assert prontos[0]["name"] == "Adam Louis Ross"

    def test_data_brasileira_vira_iso(self):
        prontos, _ = S._preparar([_linha(birth_date="18/07/2004")])
        assert prontos[0]["birth_date"] == "2004-07-18"

    def test_data_invalida_nao_impede_a_importacao(self):
        """Data ruim nao pode custar o cadastro inteiro — vira vazia."""
        prontos, _ = S._preparar([_linha(birth_date="99/99/9999")])
        assert len(prontos) == 1
        assert prontos[0]["birth_date"] is None

    def test_data_ja_em_iso_e_mantida(self):
        prontos, _ = S._preparar([_linha(birth_date="2004-07-18")])
        assert prontos[0]["birth_date"] == "2004-07-18"

    @pytest.mark.parametrize("origem,esperado", [
        ("RG", "national_id"),
        ("CPF", "national_id"),
        ("Cedula", "national_id"),
        ("Passaporte", "passport"),
        ("passport", "passport"),
        ("CNH", "driver_license"),
    ])
    def test_tipos_de_documento_sao_traduzidos(self, origem, esperado):
        """O banco so aceita tres tipos; o concorrente usa nomes livres."""
        prontos, _ = S._preparar([_linha(document_type=origem)])
        assert prontos[0]["document_type"] == esperado

    def test_tipo_de_documento_desconhecido_e_rejeitado_com_motivo(self):
        _, rejeitados = S._preparar([_linha(document_type="Outro")])
        assert "tipo de documento" in rejeitados[0]["reason"]

    def test_usa_o_celular_quando_nao_ha_telefone(self):
        prontos, _ = S._preparar([_linha(phone="", mobile="11988887777")])
        assert prontos[0]["phone"] == "11988887777"

    def test_nacionalidade_vem_do_pais_do_DOCUMENTO(self):
        """A outra coluna do concorrente e endereco e vem furada: ha gente
        morando em Medellin marcada como "Brasil"."""
        prontos, _ = S._preparar([_linha(doc_country="Estados Unidos", nationality="Colombia")])
        assert prontos[0]["nationality"] == "Estados Unidos"

    def test_email_vira_minusculo(self):
        prontos, _ = S._preparar([_linha(email="FULANO@Exemplo.COM")])
        assert prontos[0]["email"] == "fulano@exemplo.com"


class TestValoresDeLixo:
    """O clube digita "1", "-" e "0" quando nao tem o dado. Aceitar isso
    criaria telefone e documento falsos no cadastro."""

    @pytest.mark.parametrize("lixo", ["1", "-", "--", "0", "N/A", "nao", "x", ""])
    def test_telefone_lixo_e_tratado_como_ausente(self, lixo):
        _, rejeitados = S._preparar([_linha(phone=lixo, mobile=lixo)])
        assert "telefone" in rejeitados[0]["reason"]

    def test_email_lixo_e_tratado_como_ausente(self):
        _, rejeitados = S._preparar([_linha(email="1")])
        assert "e-mail" in rejeitados[0]["reason"]


class TestCamposObrigatorios:
    @pytest.mark.parametrize("campo,texto", [
        ("name", "nome"),
        ("email", "e-mail"),
        ("document_number", "documento"),
    ])
    def test_campo_ausente_e_reportado_com_o_motivo(self, campo, texto):
        _, rejeitados = S._preparar([_linha(**{campo: ""})])
        assert texto in rejeitados[0]["reason"]

    def test_email_malformado_e_recusado(self):
        _, rejeitados = S._preparar([_linha(email="fulano-arroba-exemplo")])
        assert "inválido" in rejeitados[0]["reason"]

    def test_varios_campos_faltando_aparecem_juntos(self):
        """O clube precisa saber TUDO que falta de uma vez, senao corrige um
        campo e o registro cai de novo na proxima importacao."""
        _, rejeitados = S._preparar([_linha(email="", phone="", mobile="", document_number="")])
        motivo = rejeitados[0]["reason"]
        assert "e-mail" in motivo and "telefone" in motivo and "documento" in motivo

    def test_registro_sem_nome_ainda_e_identificavel(self):
        _, rejeitados = S._preparar([_linha(name="", source_id="286")])
        assert rejeitados[0]["source_id"] == "286"
        assert rejeitados[0]["name"] == "(sem nome)"


class TestDuplicidadeNoArquivo:
    def test_email_repetido_no_proprio_arquivo(self):
        """Sem isso o INSERT em lote falharia inteiro pela chave unica."""
        prontos, rejeitados = S._preparar([
            _linha(source_id="1", document_number="111"),
            _linha(source_id="2", document_number="222"),
        ])
        assert len(prontos) == 1
        assert "repetido" in rejeitados[0]["reason"]

    def test_documento_repetido_no_proprio_arquivo(self):
        prontos, rejeitados = S._preparar([
            _linha(source_id="1", email="a@x.com"),
            _linha(source_id="2", email="b@x.com"),
        ])
        assert len(prontos) == 1
        assert "documento repetido" in rejeitados[0]["reason"]

    def test_documento_com_pontuacao_conta_como_o_mesmo(self):
        """"123.456-78" e "12345678" sao o mesmo documento."""
        prontos, rejeitados = S._preparar([
            _linha(source_id="1", email="a@x.com", document_number="123.456-78"),
            _linha(source_id="2", email="b@x.com", document_number="12345678"),
        ])
        assert len(prontos) == 1
        assert len(rejeitados) == 1

    def test_vale_o_primeiro_registro(self):
        prontos, _ = S._preparar([
            _linha(source_id="1", name="Primeiro", document_number="111"),
            _linha(source_id="2", name="Segundo", document_number="222"),
        ])
        assert prontos[0]["name"] == "Primeiro"


class TestArquivoVazio:
    def test_lista_vazia_nao_quebra(self):
        assert S._preparar([]) == ([], [])
