"""
VALIDAÇÃO DE DOCUMENTO — regra compartilhada com o frontend
(espelho de frontend/src/utils/documentos.js — mudou aqui, mude lá).

POR QUE ISSO EXISTE (operação, não estilo): o documento é o que identifica quem
recebeu prêmio em dinheiro — é o comprovante do clube. O dono cadastrou "um
monte de 0" e o sistema aceitou; na hora de prestar contas, o recibo não vale
nada. O frontend avisa cedo, no formulário; ESTA é a validação que vale, porque
a API também é chamada pela importação de jogadores, pelo replay do modo
offline e por qualquer cliente fora do navegador.

------------------------------------------------------------------------
INTERFACE PÚBLICA
------------------------------------------------------------------------
validar_documento(tipo, numero) -> ResultadoDocumento(
    valido, codigo, chave_motivo, motivo, normalizado, aviso)
  - `motivo` já vem em português, pronto para virar detail do HTTP 400
    ("O CPF informado não é válido — confira os dígitos.").
  - `codigo` é estável para lógica/teste ('REPETIDO', 'DIGITO_VERIFICADOR'...).
  - `chave_motivo` é a mesma chave i18n usada no frontend.
  - `normalizado` é o valor que deve ser GRAVADO (só dígitos, ou alfanumérico
    em maiúsculas). Guardar normalizado é o que faz a unicidade por documento
    funcionar — senão "529.982.247-25" e "52998224725" viram dois jogadores.

TIPOS_DOCUMENTO   — catálogo dos tipos novos (valor, país, rótulo, exemplo).
TIPOS_LEGADO      — tipos antigos ainda presentes no banco.
TIPOS_ACEITOS     — tudo que a API deve aceitar em document_type.
eh_tipo_legado(tipo)
normalizar_documento(tipo, numero)
formatar_documento(tipo, numero)  — máscara de exibição (opcional).

------------------------------------------------------------------------
REGRAS POR TIPO
------------------------------------------------------------------------
  cpf            (Brasil)   11 dígitos + os dois dígitos verificadores reais
  dni            (Peru)     exatamente 8 dígitos
  cedula         (Colômbia) 6 a 10 dígitos
  passport       (qualquer) alfanumérico, 6 a 12
  driver_license (qualquer) regra básica que já existia: alfanumérico 5 a 20

REGRA GERAL, ANTES DE QUALQUER OUTRA: recusa dígitos todos iguais
(00000000000, 11111111111) e sequência trivial (12345678, 1234567890).
A ORDEM IMPORTA: 111.111.111-11 PASSA no algoritmo de dígito verificador do
CPF. Se a checagem de repetidos viesse depois, o caso do cliente continuaria
entrando no banco.

------------------------------------------------------------------------
LEGADO — por que 'national_id' não é validado
------------------------------------------------------------------------
Existem 11 jogadores gravados com document_type 'national_id' (tipo genérico
demais: cobria CPF, DNI e cédula ao mesmo tempo) e um deles com documento
inválido. Se 'national_id' passasse a ter regra estrita, qualquer PATCH nesse
jogador (corrigir telefone) e qualquer rotina que reenvie o cadastro passaria a
dar 400, e o clube travava no balcão por causa de cadastro antigo. Então
'national_id' continua ACEITO como legado, só exige não-vazio, e devolve
`aviso`. O deploy também não é atômico: por um tempo o frontend antigo ainda
manda 'national_id', e o backend novo precisa aceitar.

O banco tem CHECK players_document_type_check restrito aos três tipos antigos;
a migração aditiva db/migrations/database_migration_document_types.sql amplia o
CHECK mantendo os antigos. A migração vem antes do deploy, mas o cadastro no
balcão NÃO depende dessa ordem: se o CHECK antigo recusar o tipo novo, quem
grava troca pelo tipo legado e o jogador entra assim mesmo — ver
`tipo_para_banco_antigo` / `erro_de_tipo_recusado` no fim deste módulo.
"""

from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

# --- catálogo de tipos ------------------------------------------------------

TIPOS_DOCUMENTO: List[Dict[str, object]] = [
    {
        "valor": "cpf",
        "pais": "BR",
        "chave_rotulo": "documents.typeCpf",
        "rotulo": "CPF (Brasil)",
        "exemplo": "123.456.789-09",
        "legado": False,
    },
    {
        "valor": "dni",
        "pais": "PE",
        "chave_rotulo": "documents.typeDni",
        "rotulo": "DNI (Peru)",
        "exemplo": "12345678",
        "legado": False,
    },
    {
        "valor": "cedula",
        "pais": "CO",
        "chave_rotulo": "documents.typeCedula",
        "rotulo": "Cédula de Ciudadanía (Colômbia)",
        "exemplo": "1020304050",
        "legado": False,
    },
    {
        "valor": "passport",
        "pais": None,
        "chave_rotulo": "documents.typePassport",
        "rotulo": "Passaporte",
        "exemplo": "AB123456",
        "legado": False,
    },
    {
        "valor": "driver_license",
        "pais": None,
        "chave_rotulo": "documents.typeDriverLicense",
        "rotulo": "Carteira de motorista",
        "exemplo": "12345678900",
        "legado": False,
    },
]

TIPOS_LEGADO: List[Dict[str, object]] = [
    {
        "valor": "national_id",
        "pais": None,
        "chave_rotulo": "documents.typeLegacyNationalId",
        "rotulo": "Documento de identidade (cadastro antigo)",
        "exemplo": "",
        "legado": True,
    },
]

TIPOS_NOVOS: Tuple[str, ...] = tuple(str(t["valor"]) for t in TIPOS_DOCUMENTO)
TIPOS_LEGADO_VALORES: Tuple[str, ...] = tuple(str(t["valor"]) for t in TIPOS_LEGADO)
# O que a API aceita em document_type: os novos + os antigos (deploy não é atômico).
TIPOS_ACEITOS: Tuple[str, ...] = TIPOS_NOVOS + TIPOS_LEGADO_VALORES

AVISO_LEGADO = "Cadastro antigo: escolha o tipo de documento do país quando puder."


def eh_tipo_legado(tipo: Optional[str]) -> bool:
    return tipo in TIPOS_LEGADO_VALORES


# --- deploy fora de ordem: banco ainda sem a migração dos tipos -------------
# O CHECK players_document_type_check só aceita estes três até a migração
# db/migrations/database_migration_document_types.sql rodar. Como o formulário
# do balcão abre com 'cpf', gravar antes da migração estouraria no Postgres e o
# cadastro de jogador pararia com a fila esperando. Quem grava usa as duas
# funções abaixo para tentar de novo com o tipo genérico, que o banco antigo
# aceita: o cadastro entra (o NÚMERO é o que vale no recibo) e a tela mostra o
# aviso de cadastro antigo, convidando a escolher o tipo do país depois.
TIPOS_ACEITOS_SEM_MIGRACAO: Tuple[str, ...] = ("passport", "national_id", "driver_license")
TIPO_LEGADO_PADRAO = "national_id"


def erro_de_tipo_recusado(exc: Exception) -> bool:
    """A falha é o CHECK do document_type (migração ainda não aplicada)?"""
    return "players_document_type_check" in str(exc)


def tipo_para_banco_antigo(tipo: Optional[str]) -> Optional[str]:
    """Tipo equivalente que o banco SEM a migração aceita.

    None quando não há o que trocar — o banco antigo já aceitaria esse tipo.
    """
    if not tipo or tipo in TIPOS_ACEITOS_SEM_MIGRACAO:
        return None
    return TIPO_LEGADO_PADRAO


# --- limpeza / normalização -------------------------------------------------

TIPOS_NUMERICOS: Tuple[str, ...] = ("cpf", "dni", "cedula")


def _e_digito(c: str) -> bool:
    """Dígito ASCII, e só. `str.isdigit()` também aceita dígito Unicode que
    `int()` não converte (o expoente '²', por exemplo): o caractere passava
    pela limpeza e estourava ValueError lá na frente — 500 no lugar de um 400
    com a frase de tela. O espelho em JS usa /\\d/, que já é só ASCII."""
    return "0" <= c <= "9"


def _so_digitos(valor) -> str:
    return "".join(c for c in str(valor if valor is not None else "") if _e_digito(c))


def _alfanumerico(valor) -> str:
    texto = str(valor if valor is not None else "").upper()
    return "".join(c for c in texto if _e_digito(c) or ("A" <= c <= "Z"))


def normalizar_documento(tipo: Optional[str], numero) -> str:
    """Valor limpo, do jeito que deve ser gravado no banco."""
    if tipo in TIPOS_NUMERICOS:
        return _so_digitos(numero)
    return _alfanumerico(numero)


# --- regra geral: lixo óbvio ------------------------------------------------


def _todos_iguais(valor: str) -> bool:
    # 00000000000, 11111111111, AAAAAA.
    return len(valor) > 1 and len(set(valor)) == 1


def _sequencia_trivial(valor: str) -> bool:
    # 12345678, 87654321, 1234567890 (o zero fecha a volta).
    if len(valor) < 4 or not all(_e_digito(c) for c in valor):
        return False

    def passo(a: str, b: str) -> int:
        return (int(b) - int(a) + 10) % 10

    primeiro = passo(valor[0], valor[1])
    if primeiro not in (1, 9):
        return False
    return all(passo(valor[i], valor[i + 1]) == primeiro for i in range(1, len(valor) - 1))


# --- CPF: dígitos verificadores de verdade ----------------------------------


def _digito_cpf(base: str) -> int:
    peso = len(base) + 1
    soma = sum(int(d) * (peso - i) for i, d in enumerate(base))
    resto = (soma * 10) % 11
    return 0 if resto == 10 else resto


def cpf_valido(numero) -> bool:
    """Algoritmo puro do CPF, sem mensagem — útil para relatórios e migrações."""
    d = _so_digitos(numero)
    if len(d) != 11 or _todos_iguais(d):
        return False
    return _digito_cpf(d[:9]) == int(d[9]) and _digito_cpf(d[:10]) == int(d[10])


# --- resultado --------------------------------------------------------------


@dataclass(frozen=True)
class ResultadoDocumento:
    valido: bool
    normalizado: str
    codigo: Optional[str] = None
    chave_motivo: Optional[str] = None
    motivo: Optional[str] = None
    aviso: Optional[str] = None


def _erro(codigo: str, chave: str, motivo: str, normalizado: str) -> ResultadoDocumento:
    return ResultadoDocumento(
        valido=False,
        normalizado=normalizado,
        codigo=codigo,
        chave_motivo=chave,
        motivo=motivo,
    )


def _regra_cpf(v: str):
    if len(v) != 11:
        return ("FORMATO", "documents.errorCpfLength", "O CPF deve ter 11 dígitos.")
    if not cpf_valido(v):
        return (
            "DIGITO_VERIFICADOR",
            "documents.errorCpfInvalid",
            "O CPF informado não é válido — confira os dígitos.",
        )
    return None


def _regra_dni(v: str):
    if len(v) != 8:
        return ("FORMATO", "documents.errorDniLength", "O DNI do Peru deve ter 8 dígitos.")
    return None


def _regra_cedula(v: str):
    if not 6 <= len(v) <= 10:
        return (
            "FORMATO",
            "documents.errorCedulaLength",
            "A cédula da Colômbia deve ter de 6 a 10 dígitos.",
        )
    return None


def _regra_passaporte(v: str):
    if not 6 <= len(v) <= 12:
        return (
            "FORMATO",
            "documents.errorPassportLength",
            "O passaporte deve ter de 6 a 12 caracteres (letras e números).",
        )
    return None


def _regra_cnh(v: str):
    if not 5 <= len(v) <= 20:
        return (
            "FORMATO",
            "documents.errorDriverLicenseLength",
            "A carteira de motorista deve ter de 5 a 20 caracteres.",
        )
    return None


_REGRAS = {
    "cpf": _regra_cpf,
    "dni": _regra_dni,
    "cedula": _regra_cedula,
    "passport": _regra_passaporte,
    "driver_license": _regra_cnh,
}


def validar_documento(tipo: Optional[str], numero) -> ResultadoDocumento:
    """Valida um documento. Ver contrato no topo do módulo."""
    normalizado = normalizar_documento(tipo, numero)

    if not normalizado:
        return _erro(
            "VAZIO", "documents.errorRequired", "Informe o número do documento.", ""
        )

    # Tipo antigo e genérico: não bloqueia nada (ver bloco LEGADO no topo).
    if eh_tipo_legado(tipo):
        return ResultadoDocumento(
            valido=True, normalizado=normalizado, aviso=AVISO_LEGADO
        )

    regra = _REGRAS.get(tipo or "")
    if regra is None:
        return _erro(
            "TIPO_DESCONHECIDO",
            "documents.errorUnknownType",
            "Selecione o tipo de documento.",
            normalizado,
        )

    # ORDEM PROPOSITAL: lixo óbvio ANTES do dígito verificador, senão
    # 111.111.111-11 passaria (ele fecha a conta do DV).
    if _todos_iguais(normalizado):
        return _erro(
            "REPETIDO",
            "documents.errorRepeated",
            "Documento com todos os caracteres iguais não é aceito — confira o número.",
            normalizado,
        )
    if _sequencia_trivial(normalizado):
        return _erro(
            "SEQUENCIAL",
            "documents.errorSequential",
            "Documento em sequência (12345678) não é aceito — confira o número.",
            normalizado,
        )

    falha = regra(normalizado)
    if falha:
        return _erro(falha[0], falha[1], falha[2], normalizado)

    return ResultadoDocumento(valido=True, normalizado=normalizado)


# --- máscara de exibição (opcional) -----------------------------------------


def formatar_documento(tipo: Optional[str], numero) -> str:
    """Máscara só para exibir (recibo/relatório). No banco vai o normalizado."""
    normalizado = normalizar_documento(tipo, numero)
    if tipo == "cpf" and len(normalizado) == 11:
        return f"{normalizado[:3]}.{normalizado[3:6]}.{normalizado[6:9]}-{normalizado[9:]}"
    return normalizado
