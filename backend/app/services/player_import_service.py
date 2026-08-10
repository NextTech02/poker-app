"""Importação de jogadores vindos de outro sistema (ex.: Poker Web).

O concorrente não expõe API — o clube exporta uma planilha e traz para cá. O
navegador só lê o arquivo e manda linhas normalizadas; TODA a decisão (o que é
válido, o que já existe, o que cabe no plano) acontece aqui, porque o cliente
não é fonte confiável para nada disso.

Regra combinada com o usuário: importa apenas o registro COMPLETO. Quem estiver
sem e-mail, telefone ou documento é devolvido numa lista com o motivo, para o
clube corrigir na origem e reimportar — reimportar é seguro, o que já entrou é
pulado.
"""
from typing import Dict, List, Optional, Tuple
import re
import unicodedata

from app.database.supabase_client import supabase


# ── Normalizações ────────────────────────────────────────────────────────────

# O Poker Web usa nomes livres de documento; o nosso banco tem CHECK com três
# valores. RG/CPF/cédula são todos documento nacional de identidade.
_DOC_MAP = {
    "rg": "national_id",
    "cpf": "national_id",
    "cnpj": "national_id",
    "cedula": "national_id",
    "cedula de ciudadania": "national_id",
    "dni": "national_id",
    "ine": "national_id",
    "identidad": "national_id",
    "national_id": "national_id",
    "passaporte": "passport",
    "pasaporte": "passport",
    "passport": "passport",
    "cnh": "driver_license",
    "licencia": "driver_license",
    "driver_license": "driver_license",
    "habilitacao": "driver_license",
}

# Valores que o clube digita para "não tenho" e que não são dado de verdade.
_LIXO = {"", "-", "--", "0", "1", "n/a", "na", "nao", "não", "none", "null", "sem", "x", "xx"}

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s.]+\.[^@\s]+$")


def _sem_acento(v: str) -> str:
    return "".join(
        c for c in unicodedata.normalize("NFD", v) if unicodedata.category(c) != "Mn"
    )


def _limpo(v) -> str:
    """Texto aparado, com espaços internos colapsados ('Adam  Louis' -> 'Adam Louis')."""
    if v is None:
        return ""
    return re.sub(r"\s+", " ", str(v)).strip()


def _util(v) -> str:
    """Vazio quando o valor é um marcador de 'não informado'."""
    v = _limpo(v)
    return "" if _sem_acento(v).lower() in _LIXO else v


def _doc_tipo(v: str) -> Optional[str]:
    chave = _sem_acento(_limpo(v)).lower()
    return _DOC_MAP.get(chave)


def _data_iso(v: str) -> Optional[str]:
    """'DD/MM/AAAA' (formato do export) -> 'AAAA-MM-DD'. Aceita ISO também."""
    v = _limpo(v)
    if not v:
        return None
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", v)
    if m:
        d, mes, a = m.groups()
        try:
            if not (1 <= int(mes) <= 12 and 1 <= int(d) <= 31):
                return None
        except ValueError:
            return None
        return f"{a}-{int(mes):02d}-{int(d):02d}"
    if re.match(r"^\d{4}-\d{2}-\d{2}$", v):
        return v
    return None


def _chave_doc(tipo: str, numero: str) -> str:
    # Só dígitos/letras: o mesmo documento vem com e sem pontuação.
    return f"{tipo}#{re.sub(r'[^0-9A-Za-z]', '', numero).lower()}"


class PlayerImportService:
    """Analisa e grava um lote de jogadores importados."""

    CAMPOS = ("name", "email", "phone", "nationality", "document_type", "document_number")

    @staticmethod
    def _preparar(linhas: List[Dict]) -> Tuple[List[Dict], List[Dict]]:
        """Normaliza e separa o que é importável do que precisa de correção.

        Devolve (prontos, rejeitados). Cada rejeitado carrega o motivo, para a
        tela mostrar o que falta em cada linha.
        """
        prontos: List[Dict] = []
        rejeitados: List[Dict] = []

        vistos_email: Dict[str, int] = {}
        vistos_doc: Dict[str, int] = {}

        for linha in linhas:
            origem = _limpo(linha.get("source_id"))
            nome = _limpo(linha.get("name"))
            email = _util(linha.get("email")).lower()
            # O export tem Telefone e Celular; vale o que estiver preenchido.
            fone = _util(linha.get("phone")) or _util(linha.get("mobile"))
            # O país do DOCUMENTO manda. A outra coluna do Poker Web ("País") é
            # endereço e vem furada — no arquivo real há gente morando em
            # Medellín e Barranquilla marcada como "Brasil"/"Peru" (110 de 483
            # divergem). Usá-la daria nacionalidade errada a ~100 jogadores.
            nacionalidade = _util(linha.get("doc_country")) or _util(linha.get("nationality"))
            doc_num = _util(linha.get("document_number"))
            doc_tipo = _doc_tipo(linha.get("document_type") or "")

            faltando = []
            if not nome:
                faltando.append("nome")
            if not email:
                faltando.append("e-mail")
            elif not _EMAIL_RE.match(email):
                faltando.append("e-mail inválido")
            if not fone:
                faltando.append("telefone")
            if not nacionalidade:
                faltando.append("país")
            if not doc_num:
                faltando.append("documento")
            elif not doc_tipo:
                faltando.append(f"tipo de documento não reconhecido ({_limpo(linha.get('document_type'))})")

            if faltando:
                rejeitados.append({
                    "source_id": origem,
                    "name": nome or "(sem nome)",
                    "reason": ", ".join(faltando),
                })
                continue

            # Duplicidade DENTRO do próprio arquivo: vale o primeiro.
            ch_doc = _chave_doc(doc_tipo, doc_num)
            if email in vistos_email:
                rejeitados.append({"source_id": origem, "name": nome,
                                   "reason": f"e-mail repetido no arquivo ({email})"})
                continue
            if ch_doc in vistos_doc:
                rejeitados.append({"source_id": origem, "name": nome,
                                   "reason": f"documento repetido no arquivo ({doc_num})"})
                continue
            vistos_email[email] = 1
            vistos_doc[ch_doc] = 1

            prontos.append({
                "source_id": origem,
                "name": nome,
                "email": email,
                "phone": fone,
                "nationality": nacionalidade,
                "document_type": doc_tipo,
                "document_number": doc_num,
                "nickname": _util(linha.get("nickname")) or None,
                "birth_date": _data_iso(linha.get("birth_date") or ""),
                "_doc_key": ch_doc,
            })

        return prontos, rejeitados

    @staticmethod
    def _ja_existentes(organization_id: str) -> Tuple[set, set]:
        """E-mails e documentos já cadastrados NA ORGANIZAÇÃO (para não duplicar)."""
        emails, docs = set(), set()
        resp = (
            supabase.table("players")
            .select("email, document_type, document_number")
            .eq("organization_id", organization_id)
            .execute()
        )
        for p in resp.data or []:
            if p.get("email"):
                emails.add(str(p["email"]).strip().lower())
            if p.get("document_number"):
                docs.add(_chave_doc(p.get("document_type") or "", p["document_number"]))
        return emails, docs

    @staticmethod
    def analisar(organization_id: str, linhas: List[Dict]) -> Dict:
        """Prévia: diz o que vai entrar, o que já existe e o que falta corrigir.

        Não grava nada — é o que a tela mostra antes de o usuário confirmar.
        """
        prontos, rejeitados = PlayerImportService._preparar(linhas)
        emails, docs = PlayerImportService._ja_existentes(organization_id)

        novos, duplicados = [], []
        for p in prontos:
            if p["email"] in emails:
                duplicados.append({"source_id": p["source_id"], "name": p["name"],
                                   "reason": "já cadastrado (mesmo e-mail)"})
            elif p["_doc_key"] in docs:
                duplicados.append({"source_id": p["source_id"], "name": p["name"],
                                   "reason": "já cadastrado (mesmo documento)"})
            else:
                novos.append(p)

        # Limite do plano: avisar ANTES, e não estourar no meio da gravação.
        cabe, limite, atual = PlayerImportService._checar_limite(organization_id, len(novos))

        return {
            "total_lidos": len(linhas),
            "novos": len(novos),
            "ja_cadastrados": len(duplicados),
            "rejeitados": len(rejeitados),
            "cabe_no_plano": cabe,
            "limite_plano": limite,
            "jogadores_atuais": atual,
            "amostra": [
                {k: p[k] for k in ("name", "email", "phone", "nationality",
                                   "document_type", "document_number", "nickname", "birth_date")}
                for p in novos[:5]
            ],
            "lista_rejeitados": rejeitados,
            "lista_duplicados": duplicados,
        }

    @staticmethod
    def _checar_limite(organization_id: str, a_inserir: int) -> Tuple[bool, Optional[int], int]:
        """(cabe, limite, quantidade_atual). Limite nulo = plano ilimitado."""
        atual = 0
        try:
            r = (
                supabase.table("players")
                .select("id", count="exact")
                .eq("organization_id", organization_id)
                .limit(1)
                .execute()
            )
            atual = r.count or 0
        except Exception:
            pass

        limite = None
        try:
            r = supabase.rpc("org_limit", {"p_org": organization_id, "p_kind": "clients"}).execute()
            limite = r.data if isinstance(r.data, int) else None
        except Exception:
            limite = None

        cabe = True if limite is None else (atual + a_inserir) <= limite
        return cabe, limite, atual

    @staticmethod
    def importar(organization_id: str, linhas: List[Dict]) -> Dict:
        """Grava os jogadores novos. Devolve o mesmo resumo da prévia + inseridos."""
        prontos, rejeitados = PlayerImportService._preparar(linhas)
        emails, docs = PlayerImportService._ja_existentes(organization_id)

        novos, duplicados = [], []
        for p in prontos:
            if p["email"] in emails:
                duplicados.append({"source_id": p["source_id"], "name": p["name"],
                                   "reason": "já cadastrado (mesmo e-mail)"})
            elif p["_doc_key"] in docs:
                duplicados.append({"source_id": p["source_id"], "name": p["name"],
                                   "reason": "já cadastrado (mesmo documento)"})
            else:
                novos.append(p)

        cabe, limite, atual = PlayerImportService._checar_limite(organization_id, len(novos))
        if not cabe:
            raise ValueError(
                f"PLANO_LIMITE_CLIENTES: o plano permite {limite} jogador(es); "
                f"a organização já tem {atual} e a importação traria {len(novos)}."
            )

        inseridos, falhas = 0, []
        if novos:
            inseridos, falhas = PlayerImportService._inserir_em_lotes(organization_id, novos)

        return {
            "total_lidos": len(linhas),
            "importados": inseridos,
            "ja_cadastrados": len(duplicados),
            "rejeitados": len(rejeitados),
            "lista_rejeitados": rejeitados + falhas,
            "lista_duplicados": duplicados,
        }

    @staticmethod
    def _inserir_em_lotes(organization_id: str, novos: List[Dict], tamanho: int = 100):
        """Grava em blocos.

        Um INSERT por jogador seriam centenas de idas ao banco. Em bloco é uma
        ida por centena — mas se UMA linha do bloco falhar, o bloco inteiro é
        recusado. Por isso, ao falhar, o bloco é reprocessado linha a linha:
        assim o problema fica restrito a quem realmente tem defeito, e o resto
        entra.
        """
        inseridos = 0
        falhas: List[Dict] = []

        for i in range(0, len(novos), tamanho):
            bloco = novos[i:i + tamanho]
            payload = [
                {k: v for k, v in p.items() if k not in ("_doc_key", "source_id")}
                | {"organization_id": organization_id}
                for p in bloco
            ]
            try:
                resp = supabase.table("players").insert(payload).execute()
                inseridos += len(resp.data or payload)
            except Exception:
                for p in bloco:
                    um = {k: v for k, v in p.items() if k not in ("_doc_key", "source_id")}
                    um["organization_id"] = organization_id
                    try:
                        supabase.table("players").insert(um).execute()
                        inseridos += 1
                    except Exception as exc:
                        falhas.append({
                            "source_id": p.get("source_id", ""),
                            "name": p["name"],
                            "reason": PlayerImportService._motivo(exc),
                        })
        return inseridos, falhas

    @staticmethod
    def _motivo(exc: Exception) -> str:
        txt = str(exc)
        if "PLANO_LIMITE_CLIENTES" in txt:
            return "limite de jogadores do plano atingido"
        if "players_email_org_key" in txt:
            return "e-mail já cadastrado"
        if "players_document_org_key" in txt:
            return "documento já cadastrado"
        if "players_document_type_check" in txt:
            return "tipo de documento inválido"
        return "não foi possível gravar"
