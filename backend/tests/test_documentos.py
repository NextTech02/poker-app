"""
Testes de mesa dos validadores de documento (backend — é a validação que vale).

POR QUE IMPORTA NA OPERAÇÃO: o documento é o comprovante de quem levou prêmio
em dinheiro. O dono do clube cadastrou "um monte de 0" e o sistema aceitou —
existe 1 jogador assim no banco. Ao mesmo tempo, os 11 cadastros antigos
(document_type 'national_id') NÃO podem passar a dar erro, senão o balcão trava
para vender a um cliente já cadastrado.
"""

import pytest

from app.utils.documentos import (
    TIPOS_ACEITOS,
    TIPOS_DOCUMENTO,
    TIPOS_LEGADO,
    cpf_valido,
    eh_tipo_legado,
    formatar_documento,
    normalizar_documento,
    validar_documento,
)

CPF_VALIDO = "52998224725"
CPF_VALIDO_2 = "11144477735"


class TestCPF:
    def test_aceita_cpf_valido_com_e_sem_mascara(self):
        assert validar_documento("cpf", CPF_VALIDO).valido
        assert validar_documento("cpf", "529.982.247-25").valido
        assert validar_documento("cpf", CPF_VALIDO_2).valido

    def test_grava_so_os_digitos(self):
        # O normalizado é o que vai para o banco: sem isso, "529.982.247-25" e
        # "52998224725" viram dois jogadores diferentes.
        assert validar_documento("cpf", "529.982.247-25").normalizado == CPF_VALIDO

    def test_recusa_cpf_com_digito_trocado(self):
        r = validar_documento("cpf", "52998224726")
        assert not r.valido
        assert r.codigo == "DIGITO_VERIFICADOR"
        assert r.motivo == "O CPF informado não é válido — confira os dígitos."
        assert r.chave_motivo == "documents.errorCpfInvalid"

    @pytest.mark.parametrize("numero", ["5299822472", "529982247250"])
    def test_recusa_quantidade_errada_de_digitos(self, numero):
        assert validar_documento("cpf", numero).codigo == "FORMATO"

    def test_cpf_valido_e_o_algoritmo_puro(self):
        assert cpf_valido("529.982.247-25") is True
        assert cpf_valido("52998224726") is False
        assert cpf_valido("") is False


class TestRegraGeralLixoObvio:
    def test_recusa_um_monte_de_zero(self):
        # Este é o caso que o dono do clube conseguiu cadastrar de verdade.
        r = validar_documento("cpf", "00000000000")
        assert not r.valido
        assert r.codigo == "REPETIDO"

    def test_recusa_todos_uns_apesar_do_digito_verificador_fechar(self):
        # 111.111.111-11 PASSA no algoritmo do CPF. Se a checagem de repetidos
        # rodasse depois do DV, o caso do cliente continuaria entrando.
        assert validar_documento("cpf", "11111111111").codigo == "REPETIDO"

    def test_recusa_repetido_em_dni_e_cedula(self):
        assert validar_documento("dni", "00000000").codigo == "REPETIDO"
        assert validar_documento("cedula", "9999999").codigo == "REPETIDO"

    @pytest.mark.parametrize(
        "tipo,numero", [("dni", "12345678"), ("dni", "87654321"), ("cedula", "1234567890")]
    )
    def test_recusa_sequencia_trivial(self, tipo, numero):
        assert validar_documento(tipo, numero).codigo == "SEQUENCIAL"

    def test_nao_confunde_documento_legitimo_com_sequencia(self):
        assert validar_documento("dni", "10234567").valido
        assert validar_documento("cpf", CPF_VALIDO).valido

    @pytest.mark.parametrize("numero", ["", "   ", "...-", None])
    def test_recusa_vazio(self, numero):
        assert validar_documento("cpf", numero).codigo == "VAZIO"


class TestDNIPeru:
    def test_aceita_oito_digitos(self):
        assert validar_documento("dni", "46829135").valido

    def test_recusa_sete_digitos(self):
        r = validar_documento("dni", "4682913")
        assert not r.valido
        assert r.codigo == "FORMATO"
        assert r.motivo == "O DNI do Peru deve ter 8 dígitos."

    def test_recusa_nove_digitos(self):
        assert not validar_documento("dni", "468291357").valido

    def test_recusa_letra(self):
        # A letra é descartada na limpeza; sobram 7 dígitos e cai no formato.
        assert validar_documento("dni", "4682913A").codigo == "FORMATO"


class TestCedulaColombia:
    @pytest.mark.parametrize("numero", ["102030", "1020304050"])
    def test_aceita_os_limites_6_e_10(self, numero):
        assert validar_documento("cedula", numero).valido

    def test_recusa_cinco_digitos(self):
        assert validar_documento("cedula", "10203").codigo == "FORMATO"

    def test_recusa_onze_digitos(self):
        r = validar_documento("cedula", "10203040506")
        assert r.codigo == "FORMATO"
        assert r.motivo == "A cédula da Colômbia deve ter de 6 a 10 dígitos."


class TestPassaporte:
    def test_aceita_letras_junto_com_numeros(self):
        assert validar_documento("passport", "AB123456").valido

    def test_normaliza_para_maiusculas(self):
        # O mesmo passaporte não pode virar dois cadastros por causa da caixa.
        assert validar_documento("passport", "ab123456").normalizado == "AB123456"

    @pytest.mark.parametrize("numero", ["A12345", "AB1234567890"])
    def test_aceita_os_limites_6_e_12(self, numero):
        assert validar_documento("passport", numero).valido

    @pytest.mark.parametrize("numero", ["AB123", "AB12345678901"])
    def test_recusa_fora_do_tamanho(self, numero):
        assert validar_documento("passport", numero).codigo == "FORMATO"

    @pytest.mark.parametrize("numero", ["AAAAAA", "000000"])
    def test_recusa_todos_os_caracteres_iguais(self, numero):
        assert validar_documento("passport", numero).codigo == "REPETIDO"


class TestCarteiraDeMotorista:
    @pytest.mark.parametrize("numero", ["12345678900", "ABC1234"])
    def test_aceita_alfanumerico_de_5_a_20(self, numero):
        assert validar_documento("driver_license", numero).valido

    def test_recusa_curto_demais(self):
        assert validar_documento("driver_license", "AB12").codigo == "FORMATO"


class TestTipoLegado:
    def test_aceita_o_documento_invalido_que_ja_esta_no_banco(self):
        # Um dos 11 cadastros antigos tem dígitos todos iguais. Se isso virasse
        # 400, ninguém editava o telefone dele nem vendia entrada para ele.
        r = validar_documento("national_id", "00000000000")
        assert r.valido
        assert r.aviso

    @pytest.mark.parametrize("numero", ["12.345.678-9", "X1"])
    def test_aceita_qualquer_formato_antigo(self, numero):
        assert validar_documento("national_id", numero).valido

    def test_ainda_exige_algum_numero(self):
        assert validar_documento("national_id", "").codigo == "VAZIO"

    def test_eh_tipo_legado_marca_so_o_tipo_antigo(self):
        assert eh_tipo_legado("national_id") is True
        assert eh_tipo_legado("cpf") is False

    def test_api_continua_aceitando_o_tipo_antigo(self):
        # O deploy não é atômico: o frontend antigo ainda manda 'national_id'.
        assert "national_id" in TIPOS_ACEITOS


class TestTipoDesconhecido:
    def test_pede_para_escolher_o_tipo(self):
        r = validar_documento("rg", "123456")
        assert not r.valido
        assert r.codigo == "TIPO_DESCONHECIDO"

    def test_tipo_nulo_tambem_e_recusado(self):
        assert validar_documento(None, "123456").codigo == "TIPO_DESCONHECIDO"


class TestEntradaExotica:
    """Caractere estranho tem de virar 400 com frase de tela, nunca 500.

    `str.isdigit()` é True para dígito Unicode que `int()` não converte (o
    expoente '²'): ele passava pela limpeza e estourava ValueError lá dentro —
    o balcão via "erro no servidor" em vez de "confira o número". O espelho em
    JS usa /\\d/ (só ASCII) e nunca teve o problema.
    """

    @pytest.mark.parametrize("numero", ["1234567890²", "²²²²²²²²²²²", "５２９９８２２４７２５"])
    def test_digito_unicode_nao_estoura(self, numero):
        r = validar_documento("cpf", numero)
        assert not r.valido
        assert r.motivo

    def test_digito_unicode_e_descartado_na_normalizacao(self):
        assert normalizar_documento("cpf", "5299822472²5") == CPF_VALIDO
        assert normalizar_documento("passport", "AB12²34") == "AB1234"

    def test_documento_valido_com_sujeira_unicode_no_meio_passa(self):
        assert validar_documento("cpf", "529.982.247-2²5").valido


class TestCatalogo:
    def test_oferece_os_cinco_tipos_novos(self):
        assert [t["valor"] for t in TIPOS_DOCUMENTO] == [
            "cpf",
            "dni",
            "cedula",
            "passport",
            "driver_license",
        ]

    def test_rotulos_dizem_o_pais_onde_ha_mais_de_um_formato(self):
        por_valor = {t["valor"]: t for t in TIPOS_DOCUMENTO}
        assert por_valor["cpf"]["pais"] == "BR"
        assert por_valor["dni"]["pais"] == "PE"
        assert por_valor["cedula"]["pais"] == "CO"
        assert por_valor["passport"]["pais"] is None
        for tipo in TIPOS_DOCUMENTO:
            assert tipo["rotulo"]
            assert str(tipo["chave_rotulo"]).startswith("documents.")

    def test_catalogo_bate_com_o_frontend(self):
        # Mesmos valores dos dois lados: o select do navegador não pode mandar
        # um tipo que a API rejeita.
        assert set(TIPOS_ACEITOS) == {
            "cpf",
            "dni",
            "cedula",
            "passport",
            "driver_license",
            "national_id",
        }
        assert [t["valor"] for t in TIPOS_LEGADO] == ["national_id"]


class TestNormalizacaoEMascara:
    def test_normaliza_numericos_so_com_digitos(self):
        assert normalizar_documento("cpf", "529.982.247-25") == CPF_VALIDO
        assert normalizar_documento("cedula", "1.020.304") == "1020304"

    def test_formata_cpf_completo_e_devolve_o_resto_limpo(self):
        assert formatar_documento("cpf", CPF_VALIDO) == "529.982.247-25"
        assert formatar_documento("cpf", "5299") == "5299"
        assert formatar_documento("passport", "ab123456") == "AB123456"
