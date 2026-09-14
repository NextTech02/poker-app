"""Códigos de recuperação do segundo fator.

O QUE ELES SÃO, E O QUE NÃO SÃO

Quem perde o celular perde a conta. O Supabase não oferece códigos de
recuperação prontos — o MFA nativo dele cobre enroll/challenge/verify, e mais
nada. Isto aqui é nosso.

Um código de recuperação **não vira `aal2`**. Só o `mfa.verify` do Supabase
promove a sessão, e ele exige o aparelho. O que o código faz é REMOVER o fator,
devolvendo a conta ao estado de senha para a pessoa cadastrar um aparelho novo.

Isso significa que um código vale exatamente o mesmo que o celular. Três
consequências, todas implementadas aqui:

1. **Gerar códigos exige `aal2`.** Sem isso o 2FA seria decorativo: quem roubou
   só a senha geraria um código e o usaria para desligar o segundo fator.
2. **O banco guarda só o HASH.** O texto puro existe uma vez, na resposta da
   geração, e nunca mais — nem no banco, nem no log.
3. **Um código serve uma vez**, e o uso fica registrado com IP.

A tabela `mfa_recovery_codes` tem RLS ligado e NENHUMA política para
`authenticated`: quem a lê é este serviço, com a service_role. Se o usuário
pudesse ler a própria linha, um código roubado do navegador teria o valor do
aparelho — e, pior, ele estaria em `aal1` no momento em que precisa do código,
justamente o estado que a política restritiva barra.
"""
import hashlib
import hmac
import logging
import secrets
from datetime import datetime, timezone
from typing import List, Optional

import httpx

from app.config import get_settings
from app.database.supabase_client import supabase_admin
from app.utils.erros import ErroDeNegocio, recusado, sem_permissao

logger = logging.getLogger(__name__)
settings = get_settings()

QUANTIDADE_DE_CODIGOS = 8
# Alfabeto sem 0/O/1/I/L: estes códigos são LIDOS de um papel, muitas vezes por
# quem está com pressa. Confundir zero com O custaria uma tentativa das poucas
# que existem.
ALFABETO = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
TAMANHO = 10          # ~49 bits de entropia por código
TENTATIVAS_MAXIMAS = 5


def _hash(codigo: str) -> str:
    """SHA-256 do código normalizado.

    Sem `salt` por linha de propósito: o código já é aleatório e longo, então
    não há dicionário a proteger — e um hash determinístico é o que permite
    procurar a linha por igualdade em vez de varrer e comparar uma a uma.
    """
    return hashlib.sha256(codigo.strip().upper().replace("-", "").encode()).hexdigest()


def _novo_codigo() -> str:
    """Um código no formato ABCDE-FGHIJ. O hífen é só para a leitura."""
    bruto = "".join(secrets.choice(ALFABETO) for _ in range(TAMANHO))
    return f"{bruto[:5]}-{bruto[5:]}"


class MfaService:

    # ============================================================
    # Consulta
    # ============================================================

    @staticmethod
    def _fatores_verificados(auth_user_id: str) -> List[dict]:
        """Os fatores da pessoa, lidos do GoTrue com a service_role."""
        base = settings.supabase_url
        chave = settings.supabase_service_key
        try:
            r = httpx.get(
                f"{base}/auth/v1/admin/users/{auth_user_id}/factors",
                headers={"apikey": chave, "Authorization": f"Bearer {chave}"},
                timeout=15,
            )
            if r.status_code >= 400:
                logger.warning("GoTrue recusou a listagem de fatores: %s", r.text[:200])
                return []
            corpo = r.json()
            fatores = corpo if isinstance(corpo, list) else (corpo.get("factors") or [])
            return [f for f in fatores if f.get("status") == "verified"]
        except Exception:
            logger.exception("falha ao listar fatores de %s", auth_user_id)
            return []

    @staticmethod
    def status(auth_user_id: str) -> dict:
        fatores = MfaService._fatores_verificados(auth_user_id)
        restantes = supabase_admin.table("mfa_recovery_codes").select("id") \
            .eq("user_id", auth_user_id).is_("used_at", "null").execute()
        return {
            "enabled": bool(fatores),
            "factors": [
                {"id": f.get("id"), "friendly_name": f.get("friendly_name"),
                 "factor_type": f.get("factor_type")}
                for f in fatores
            ],
            "recovery_codes_remaining": len(restantes.data or []),
        }

    # ============================================================
    # Gerar os códigos
    # ============================================================

    @staticmethod
    def gerar_codigos(auth_user_id: str, aal: Optional[str]) -> List[str]:
        """Gera (e substitui) os códigos. Devolve o texto puro UMA vez.

        Exige `aal2`. Sem essa trava o segundo fator não protegeria nada: quem
        tivesse só a senha geraria um código e o usaria para desligar o 2FA.
        """
        if aal != "aal2":
            raise sem_permissao(
                "segundo_fator_necessario",
                "Confirme o código do seu aplicativo autenticador antes de gerar "
                "novos códigos de recuperação.",
            )

        if not MfaService._fatores_verificados(auth_user_id):
            raise recusado(
                "sem_segundo_fator",
                "Ative a verificação em duas etapas antes de gerar códigos de recuperação.",
            )

        # Os antigos morrem: gerar uma lista nova invalida a anterior, senão um
        # papel velho continuaria abrindo a conta.
        supabase_admin.table("mfa_recovery_codes").delete() \
            .eq("user_id", auth_user_id).execute()

        codigos = [_novo_codigo() for _ in range(QUANTIDADE_DE_CODIGOS)]
        supabase_admin.table("mfa_recovery_codes").insert([
            {"user_id": auth_user_id, "code_hash": _hash(c)} for c in codigos
        ]).execute()

        logger.info("códigos de recuperação gerados para %s", auth_user_id)
        return codigos

    # ============================================================
    # Usar um código
    # ============================================================

    @staticmethod
    def recuperar(auth_user_id: str, codigo: str, ip: Optional[str] = None) -> dict:
        """Consome um código e REMOVE o segundo fator da conta.

        Depois disto a pessoa entra só com a senha (a política do banco só exige
        o segundo fator de quem tem fator cadastrado) e deve cadastrar um
        aparelho novo.
        """
        linhas = supabase_admin.table("mfa_recovery_codes") \
            .select("id, code_hash, used_at") \
            .eq("user_id", auth_user_id).execute().data or []

        if not linhas:
            raise recusado(
                "sem_codigos_de_recuperacao",
                "Esta conta não tem códigos de recuperação. Peça a um administrador "
                "do clube para remover a verificação em duas etapas.",
            )

        # Limite de tentativas: sem ele, 49 bits de entropia não impedem alguém
        # de tentar à vontade com a senha em mãos.
        usados = [l for l in linhas if l.get("used_at")]
        if len(usados) >= TENTATIVAS_MAXIMAS and all(l.get("used_at") for l in linhas):
            raise recusado(
                "codigos_esgotados",
                "Todos os códigos de recuperação já foram usados.",
            )

        alvo = _hash(codigo)
        # `compare_digest` e não `==`: comparação de string vaza, pelo tempo, o
        # quanto do valor bateu. Aqui a diferença é teórica (o alvo já é hash),
        # mas o hábito é o que evita o caso em que não é.
        achado = next(
            (l for l in linhas
             if not l.get("used_at") and hmac.compare_digest(l["code_hash"], alvo)),
            None,
        )
        if not achado:
            logger.warning("código de recuperação inválido para %s", auth_user_id)
            raise recusado(
                "codigo_de_recuperacao_invalido",
                "Código de recuperação inválido ou já utilizado.",
            )

        # Marca ANTES de remover o fator: se a remoção falhar, o código já está
        # gasto e a pessoa tenta outro. O contrário — remover o fator e não
        # conseguir marcar — deixaria um código válido depois de usado.
        supabase_admin.table("mfa_recovery_codes").update({
            "used_at": datetime.now(timezone.utc).isoformat(),
            "used_ip": ip,
        }).eq("id", achado["id"]).execute()

        removidos = MfaService._remover_fatores(auth_user_id)
        logger.info("recuperação de 2FA usada por %s — %d fator(es) removido(s)",
                    auth_user_id, removidos)
        return {"removed_factors": removidos,
                "recovery_codes_remaining": len(
                    [l for l in linhas if not l.get("used_at")]) - 1}

    @staticmethod
    def _remover_fatores(auth_user_id: str) -> int:
        base = settings.supabase_url
        chave = settings.supabase_service_key
        cabecalhos = {"apikey": chave, "Authorization": f"Bearer {chave}"}
        removidos = 0
        for f in MfaService._fatores_verificados(auth_user_id):
            try:
                r = httpx.delete(
                    f"{base}/auth/v1/admin/users/{auth_user_id}/factors/{f['id']}",
                    headers=cabecalhos, timeout=15,
                )
                if r.status_code < 400:
                    removidos += 1
                else:
                    logger.error("GoTrue recusou remover o fator %s: %s",
                                 f.get("id"), r.text[:200])
            except Exception:
                logger.exception("falha ao remover o fator %s", f.get("id"))

        if removidos == 0:
            raise ErroDeNegocio(
                "falha_ao_remover_segundo_fator",
                "Não foi possível remover a verificação em duas etapas. "
                "Tente de novo em instantes.",
                status=503,
            )
        return removidos
