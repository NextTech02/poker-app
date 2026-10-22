"""FIADO DA CASA: a conta-corrente do jogador com o clube.

ONDE MORAM AS REGRAS: no banco (database_migration_fiado_fase0.sql). Limite,
vencido, abatimento, estorno e espelho na gaveta acontecem nos triggers do
mesmo INSERT/UPDATE — o que este serviço faz é (1) pré-checar para dar a
recusa com nome antes de esbarrar no banco, (2) traduzir `REGRA_FIADO:*` na
recusa que a tela entende e (3) escolher o CLIENTE certo:

  - leituras e operação de caixa (recebimento) vão como o USUÁRIO (`supabase`,
    RLS da organização);
  - gestão (habilitar, limite, baixa, estorno de recebimento, configuração) vai
    pelo service role (`supabase_admin`), DEPOIS do `require_permission
    ("fiado.manage")` no router. O banco recusa essas escritas vindas do
    usuário — sem isso, qualquer funcionário perdoaria dívida pelo navegador.
    Pelo service role não há RLS: toda consulta aqui filtra a organização à
    mão, e `updated_by`/`created_by` vão explícitos (o log de atividade
    registraria "Sistema").

COMPATÍVEL COM DEPLOY ANTES DA MIGRAÇÃO: sem as tabelas, a conta de todo
jogador é "sem fiado" (saldo 0) e o resto do caixa segue como sempre.
"""
import logging
import re
from datetime import datetime, timezone
from typing import Dict, Iterable, List, Optional

from app.database import supabase
from app.database.supabase_client import supabase_admin
from app.models.house_credit import (
    HouseCreditAccount,
    HouseCreditAccountUpdate,
    HouseCreditBalance,
    HouseCreditDebtor,
    HouseCreditDebtors,
    HouseCreditEntry,
    HouseCreditMovement,
    HouseCreditPaymentCreate,
    HouseCreditSettings,
    HouseCreditSettingsUpdate,
    HouseCreditUnderOffset,
)
from app.utils.erros import ErroDeNegocio

logger = logging.getLogger(__name__)

PERMISSAO_GESTAO = "fiado.manage"
PAYMENT_SOURCE = "house_credit"

# code → (frase de reserva em português, status). A tela traduz por
# `errors.<code>`; a frase vale para log e para código que a tela não conhece.
_RECUSAS = {
    "fiado_nao_habilitado": ("Este jogador não tem fiado liberado.", 400),
    "limite_de_fiado_excedido": ("O valor passa do limite de fiado do jogador.", 400),
    "fiado_vencido": ("O jogador tem fiado vencido. Receba antes de vender de novo.", 400),
    "valor_maior_que_a_divida": ("O valor é maior que a dívida do jogador.", 400),
    "estorno_de_fiado_ja_quitado": (
        "Esta venda fiada já foi paga (no todo ou em parte) e não pode ser estornada.", 409),
    "caixa_fechado": ("Abra o seu caixa antes de receber.", 400),
    "caixa_de_outra_organizacao": ("Esta gaveta não é deste clube.", 403),
    "recebimento_so_no_cash_ou_bar": ("O fiado é recebido na gaveta do cash ou do bar.", 400),
    "operacao_restrita_ao_gerente": ("Só o gerente pode fazer esta operação.", 403),
    "recebimento_nao_encontrado": ("Recebimento não encontrado.", 404),
    "estorno_deve_ser_do_valor_inteiro": ("O estorno é sempre do recebimento inteiro.", 400),
    "estorno_fora_da_sessao_do_caixa": (
        "Só dá para estornar enquanto a gaveta que recebeu estiver aberta, na mesma sessão.", 409),
    "lancamento_so_pelo_caixa": ("Este lançamento só nasce de uma operação de caixa.", 403),
    "lancamento_incoerente": ("Lançamento de fiado incoerente com a venda.", 400),
    "extrato_imutavel": ("O extrato do fiado não pode ser alterado.", 403),
    "saldo_so_pelo_extrato": ("O saldo do fiado só muda por lançamento.", 403),
    "conta_imutavel": ("A conta de fiado não muda de jogador.", 403),
    "lancamento_imutavel": ("Lançamento com fiado não pode ser alterado; estorne e lance de novo.", 409),
    "cash_out_com_abatimento_nao_cancelavel": (
        "Cash-out com abatimento de fiado não pode ser estornado.", 409),
    "estorno_nao_se_desfaz": ("Um estorno de fiado não pode ser desfeito.", 409),
}

_REGRA = re.compile(r"REGRA_FIADO:(\w+)((?:\s+\w+=\S+)*)")
# Valores são números ou datas; o resto (aspas e chaves do JSON do PostgREST
# grudadas no fim) fica de fora.
_PAR = re.compile(r"(\w+)=(-?[\w.:+-]+)")


def _numero_ou_texto(valor: str):
    try:
        return round(float(valor), 2)
    except ValueError:
        return valor


def recusa_do_banco(exc: Exception) -> Optional[ErroDeNegocio]:
    """`REGRA_FIADO:<code> k=v ...` → ErroDeNegocio com os números nomeados.
    None quando o erro não é uma regra do fiado."""
    achado = _REGRA.search(str(exc))
    if not achado:
        return None
    code = achado.group(1)
    dados = {k: _numero_ou_texto(v) for k, v in _PAR.findall(achado.group(2) or "")}
    frase, status = _RECUSAS.get(code, ("Operação de fiado recusada.", 400))
    return ErroDeNegocio(code, frase, status=status, **dados)


def _levantar_traduzido(exc: Exception):
    erro = recusa_do_banco(exc)
    if erro:
        raise erro from exc
    # Mesma recusa de gaveta do cash (estorno de recebimento sem dinheiro).
    from app.services.cash_transaction_service import _traduzir_erro_do_banco
    _traduzir_erro_do_banco(exc)


def _agora() -> str:
    return datetime.now(timezone.utc).isoformat()


def _data(valor) -> Optional[datetime]:
    if isinstance(valor, datetime):
        return valor if valor.tzinfo else valor.replace(tzinfo=timezone.utc)
    if not valor:
        return None
    try:
        d = datetime.fromisoformat(str(valor).replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def mais_antiga_em_aberto(lancamentos: Iterable[dict]) -> Optional[datetime]:
    """Data da dívida mais antiga ainda não coberta, pelo FIFO.

    Os pagamentos quitam as dívidas mais antigas primeiro: soma tudo o que
    baixou o saldo e percorre as cargas em ordem; a primeira cuja soma acumulada
    passa do total baixado é a que está em aberto. Mesma conta da função
    `house_credit_oldest_open` do banco (que trava venda nova por vencido).
    """
    linhas = list(lancamentos)
    baixado = sum(float(l["amount"]) for l in linhas if float(l.get("signed_amount") or 0) < 0)
    cargas = sorted(
        (l for l in linhas if float(l.get("signed_amount") or 0) > 0),
        key=lambda l: (str(l.get("created_at")), str(l.get("id"))),
    )
    acumulado = 0.0
    for carga in cargas:
        acumulado += float(carga["amount"])
        if acumulado > baixado + 0.004:
            return _data(carga.get("created_at"))
    return None


class HouseCreditService:

    _tabelas_ok: Optional[bool] = None

    # ============================================================
    # Guarda de migração
    # ============================================================

    @staticmethod
    def migrado() -> bool:
        """As tabelas do fiado existem? Cacheia só o SIM: enquanto a migração
        não chegou, cada chamada confere de novo (barato) e passa a valer assim
        que for aplicada, sem reiniciar o backend."""
        if HouseCreditService._tabelas_ok:
            return True
        try:
            supabase.table("house_credit_accounts").select("id").limit(1).execute()
            HouseCreditService._tabelas_ok = True
            return True
        except Exception:
            logger.warning("house_credit_accounts indisponível; fiado desligado até a migração")
            return False

    # ============================================================
    # Configuração
    # ============================================================

    @staticmethod
    def get_settings(organization_id: Optional[str] = None) -> HouseCreditSettings:
        if not HouseCreditService.migrado():
            return HouseCreditSettings()
        query = supabase.table("house_credit_settings").select("due_days, block_overdue, default_limit")
        if organization_id:
            query = query.eq("organization_id", organization_id)
        linhas = query.limit(1).execute().data or []
        if not linhas:
            return HouseCreditSettings()
        l = linhas[0]
        return HouseCreditSettings(
            due_days=int(l.get("due_days") or 30),
            block_overdue=bool(l.get("block_overdue", True)),
            default_limit=float(l.get("default_limit") or 0),
        )

    @staticmethod
    def update_settings(
        data: HouseCreditSettingsUpdate, auth_user_id: str, organization_id: str
    ) -> HouseCreditSettings:
        HouseCreditService._exigir_migracao()
        payload = {
            "organization_id": organization_id,
            "due_days": data.due_days,
            "block_overdue": data.block_overdue,
            "default_limit": data.default_limit,
            "updated_by": auth_user_id,
        }
        supabase_admin.table("house_credit_settings").upsert(
            payload, on_conflict="organization_id"
        ).execute()
        return HouseCreditService.get_settings(organization_id)

    # ============================================================
    # Conta
    # ============================================================

    @staticmethod
    def get_account(player_id: str, organization_id: Optional[str] = None) -> HouseCreditAccount:
        cfg = HouseCreditService.get_settings(organization_id)
        if not HouseCreditService.migrado():
            return HouseCreditAccount(player_id=player_id, due_days=cfg.due_days)
        query = supabase.table("house_credit_accounts").select("*").eq("player_id", player_id)
        if organization_id:
            query = query.eq("organization_id", organization_id)
        linhas = query.limit(1).execute().data or []
        if not linhas:
            return HouseCreditAccount(player_id=player_id, due_days=cfg.due_days)
        conta = linhas[0]
        lancs = []
        if float(conta.get("balance") or 0) > 0:
            lancs = supabase.table("house_credit_entries") \
                .select("id, amount, signed_amount, created_at") \
                .eq("account_id", conta["id"]).execute().data or []
        return HouseCreditService._retrato(conta, lancs, cfg)

    @staticmethod
    def _retrato(conta: dict, lancamentos: List[dict], cfg: HouseCreditSettings) -> HouseCreditAccount:
        saldo = round(float(conta.get("balance") or 0), 2)
        limite = round(float(conta.get("credit_limit") or 0), 2)
        habilitada = bool(conta.get("enabled"))
        desde = mais_antiga_em_aberto(lancamentos) if saldo > 0 else None
        dias = (datetime.now(timezone.utc) - desde).days if desde else None
        vencido = dias is not None and dias > cfg.due_days
        bloqueado = vencido and cfg.block_overdue
        return HouseCreditAccount(
            player_id=conta["player_id"],
            exists=True,
            account_id=conta["id"],
            enabled=habilitada,
            credit_limit=limite,
            balance=saldo,
            available=round(max(limite - saldo, 0), 2) if habilitada and not bloqueado else 0.0,
            oldest_open_at=desde,
            days_open=dias,
            overdue=vencido,
            blocked=bloqueado,
            due_days=cfg.due_days,
            notes=conta.get("notes"),
            updated_at=conta.get("updated_at"),
        )

    @staticmethod
    def saldo_devedor(player_id: Optional[str], organization_id: Optional[str] = None) -> float:
        """Quanto o jogador deve agora. 0 sem conta, sem jogador ou sem migração."""
        if not player_id or not HouseCreditService.migrado():
            return 0.0
        query = supabase.table("house_credit_accounts").select("balance").eq("player_id", player_id)
        if organization_id:
            query = query.eq("organization_id", organization_id)
        linhas = query.limit(1).execute().data or []
        return round(float(linhas[0].get("balance") or 0), 2) if linhas else 0.0

    @staticmethod
    def exigir_disponivel(player_id: str, valor: float, organization_id: Optional[str] = None) -> None:
        """Pré-checagem da venda no fiado, para a recusa sair com nome e
        números. A trava que resiste a duas vendas simultâneas é a do banco
        (FOR UPDATE na conta)."""
        HouseCreditService._exigir_migracao()
        conta = HouseCreditService.get_account(player_id, organization_id)
        if not conta.exists or not conta.enabled:
            raise _recusa("fiado_nao_habilitado")
        if conta.blocked:
            raise _recusa(
                "fiado_vencido",
                desde=conta.oldest_open_at.date().isoformat() if conta.oldest_open_at else None,
            )
        if valor > conta.available + 0.004:
            raise _recusa(
                "limite_de_fiado_excedido",
                disponivel=conta.available, solicitado=round(valor, 2),
            )

    @staticmethod
    def upsert_account(
        player_id: str, data: HouseCreditAccountUpdate, auth_user_id: str, organization_id: str
    ) -> HouseCreditAccount:
        """Habilitar/limite/desligar. O jogador é conferido COMO O USUÁRIO (RLS):
        id de outro clube não é encontrado, e o service role não escreve nada."""
        HouseCreditService._exigir_migracao()
        jogador = supabase.table("players").select("id").eq("id", player_id).limit(1).execute()
        if not jogador.data:
            raise ErroDeNegocio("jogador_nao_encontrado", "Jogador não encontrado", status=404)

        existente = supabase_admin.table("house_credit_accounts").select("id, enabled") \
            .eq("organization_id", organization_id).eq("player_id", player_id) \
            .limit(1).execute().data or []
        payload = {
            "enabled": data.enabled,
            "credit_limit": data.credit_limit,
            "notes": data.notes,
            "updated_by": auth_user_id,
        }
        if data.enabled and not (existente and existente[0].get("enabled")):
            payload["enabled_at"] = _agora()
        if existente:
            supabase_admin.table("house_credit_accounts").update(payload) \
                .eq("id", existente[0]["id"]).execute()
        else:
            supabase_admin.table("house_credit_accounts").insert({
                **payload, "organization_id": organization_id, "player_id": player_id,
            }).execute()
        return HouseCreditService.get_account(player_id, organization_id)

    @staticmethod
    def balances(player_ids: List[str], organization_id: Optional[str] = None) -> List[HouseCreditBalance]:
        """Badges das listas: só quem TEM conta volta. Uma consulta para as
        contas e uma para os lançamentos dos devedores — nunca uma por jogador."""
        ids = [p for p in dict.fromkeys(player_ids) if p]
        if not ids or not HouseCreditService.migrado():
            return []
        cfg = HouseCreditService.get_settings(organization_id)
        query = supabase.table("house_credit_accounts").select("*").in_("player_id", ids)
        if organization_id:
            query = query.eq("organization_id", organization_id)
        contas = query.execute().data or []
        lancs = HouseCreditService._lancamentos_dos_devedores(contas)
        saida = []
        for conta in contas:
            r = HouseCreditService._retrato(conta, lancs.get(conta["id"], []), cfg)
            saida.append(HouseCreditBalance(
                player_id=r.player_id, enabled=r.enabled, balance=r.balance,
                available=r.available, overdue=r.overdue,
            ))
        return saida

    @staticmethod
    def _lancamentos_dos_devedores(contas: List[dict]) -> Dict[str, List[dict]]:
        devedoras = [c["id"] for c in contas if float(c.get("balance") or 0) > 0]
        if not devedoras:
            return {}
        linhas = supabase.table("house_credit_entries") \
            .select("id, account_id, amount, signed_amount, created_at") \
            .in_("account_id", devedoras).execute().data or []
        por_conta: Dict[str, List[dict]] = {}
        for l in linhas:
            por_conta.setdefault(l["account_id"], []).append(l)
        return por_conta

    # ============================================================
    # Extrato e devedores
    # ============================================================

    @staticmethod
    def entries(player_id: str, organization_id: Optional[str] = None, limit: int = 200) -> List[HouseCreditEntry]:
        if not HouseCreditService.migrado():
            return []
        query = supabase.table("house_credit_entries").select("*").eq("player_id", player_id)
        if organization_id:
            query = query.eq("organization_id", organization_id)
        linhas = query.order("created_at", desc=True).limit(limit).execute().data or []
        return HouseCreditService._enriquecer(linhas)

    @staticmethod
    def _enriquecer(linhas: List[dict]) -> List[HouseCreditEntry]:
        if not linhas:
            return []
        autores = list({l["created_by"] for l in linhas if l.get("created_by")})
        nomes = {}
        if autores:
            staff = supabase.table("staff").select("auth_user_id, name") \
                .in_("auth_user_id", autores).execute().data or []
            nomes = {s["auth_user_id"]: s.get("name") for s in staff}
        estornados = {l["reverses_entry_id"] for l in linhas
                      if l.get("type") == "payment_reversal" and l.get("reverses_entry_id")}
        # O estorno pode ser de um recebimento fora da página carregada: confere
        # os recebimentos visíveis numa consulta só.
        recebimentos = [l["id"] for l in linhas if l.get("type") == "payment" and l["id"] not in estornados]
        if recebimentos:
            extra = supabase.table("house_credit_entries").select("reverses_entry_id") \
                .eq("type", "payment_reversal").in_("reverses_entry_id", recebimentos) \
                .execute().data or []
            estornados |= {e["reverses_entry_id"] for e in extra}
        campos = set(HouseCreditEntry.model_fields)
        return [
            HouseCreditEntry(
                **{k: v for k, v in l.items() if k in campos},
                created_by_name=nomes.get(l.get("created_by")),
                reversed=l["id"] in estornados,
            )
            for l in linhas
        ]

    @staticmethod
    def debtors(organization_id: Optional[str] = None) -> HouseCreditDebtors:
        cfg = HouseCreditService.get_settings(organization_id)
        if not HouseCreditService.migrado():
            return HouseCreditDebtors(rows=[], due_days=cfg.due_days)
        query = supabase.table("house_credit_accounts").select("*").gt("balance", 0)
        if organization_id:
            query = query.eq("organization_id", organization_id)
        contas = query.execute().data or []
        if not contas:
            return HouseCreditDebtors(rows=[], due_days=cfg.due_days)
        lancs = HouseCreditService._lancamentos_dos_devedores(contas)
        jogadores = supabase.table("players").select("id, name, nickname, phone") \
            .in_("id", [c["player_id"] for c in contas]).execute().data or []
        por_id = {j["id"]: j for j in jogadores}
        linhas = []
        for conta in contas:
            r = HouseCreditService._retrato(conta, lancs.get(conta["id"], []), cfg)
            j = por_id.get(conta["player_id"], {})
            linhas.append(HouseCreditDebtor(
                player_id=r.player_id, player_name=j.get("name"), nickname=j.get("nickname"),
                phone=j.get("phone"), enabled=r.enabled, credit_limit=r.credit_limit,
                balance=r.balance, oldest_open_at=r.oldest_open_at, days_open=r.days_open,
                overdue=r.overdue,
            ))
        # Os mais antigos primeiro: é a ordem da cobrança.
        linhas.sort(key=lambda d: (-(d.days_open or 0), -d.balance))
        return HouseCreditDebtors(
            rows=linhas,
            total_open=round(sum(d.balance for d in linhas), 2),
            total_overdue=round(sum(d.balance for d in linhas if d.overdue), 2),
            count=len(linhas),
            overdue_count=sum(1 for d in linhas if d.overdue),
            due_days=cfg.due_days,
        )

    @staticmethod
    def under_offsets(
        organization_id: Optional[str] = None,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
        limit: int = 200,
    ) -> List[HouseCreditUnderOffset]:
        if not HouseCreditService.migrado():
            return []
        query = supabase.table("cash_transactions") \
            .select("id, created_at, player_id, created_by, amount, debt_offset_expected, debt_settled_amount, debt_offset_reason") \
            .eq("type", "cash_out").not_.is_("debt_offset_expected", "null")
        if organization_id:
            query = query.eq("organization_id", organization_id)
        if date_from:
            query = query.gte("created_at", date_from)
        if date_to:
            query = query.lte("created_at", date_to)
        linhas = query.order("created_at", desc=True).limit(limit * 3).execute().data or []
        abaixo = [
            l for l in linhas
            if float(l.get("debt_settled_amount") or 0) + 0.004 < float(l.get("debt_offset_expected") or 0)
        ][:limit]
        if not abaixo:
            return []
        jogadores = supabase.table("players").select("id, name, nickname") \
            .in_("id", list({l["player_id"] for l in abaixo if l.get("player_id")})).execute().data or []
        nomes_j = {j["id"]: (j.get("nickname") or j.get("name")) for j in jogadores}
        autores = list({l["created_by"] for l in abaixo if l.get("created_by")})
        nomes_s = {}
        if autores:
            staff = supabase.table("staff").select("auth_user_id, name").in_("auth_user_id", autores).execute().data or []
            nomes_s = {s["auth_user_id"]: s.get("name") for s in staff}
        return [
            HouseCreditUnderOffset(
                cash_transaction_id=l["id"], created_at=l["created_at"], player_id=l.get("player_id"),
                player_name=nomes_j.get(l.get("player_id")), operator_name=nomes_s.get(l.get("created_by")),
                chips_amount=float(l["amount"]), expected=float(l.get("debt_offset_expected") or 0),
                settled=float(l.get("debt_settled_amount") or 0), reason=l.get("debt_offset_reason"),
            )
            for l in abaixo
        ]

    @staticmethod
    def summarize(
        organization_id: Optional[str] = None,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
    ) -> dict:
        """Os números do fiado para o DRE.

        `house_credit_write_offs` é do PERÍODO (baixas são perda do mês em que o
        clube desistiu da dívida). `house_credit_open`/`_overdue` são de AGORA:
        o recebível não tem período.
        """
        zerado = {"house_credit_write_offs": 0.0, "house_credit_open": 0.0, "house_credit_overdue": 0.0}
        if not HouseCreditService.migrado():
            return zerado
        try:
            baixas = supabase.table("house_credit_entries").select("amount").eq("type", "write_off")
            if organization_id:
                baixas = baixas.eq("organization_id", organization_id)
            if start_date:
                baixas = baixas.gte("created_at", start_date)
            if end_date:
                fim = datetime.fromisoformat(end_date[:10]).replace(hour=23, minute=59, second=59)
                baixas = baixas.lte("created_at", fim.isoformat())
            perdido = sum(float(b["amount"]) for b in (baixas.execute().data or []))
            devedores = HouseCreditService.debtors(organization_id)
        except Exception:
            logger.exception("fiado: falha ao somar o DRE; segue zerado")
            return zerado
        return {
            "house_credit_write_offs": round(perdido, 2),
            "house_credit_open": devedores.total_open,
            "house_credit_overdue": devedores.total_overdue,
        }

    # ============================================================
    # Recebimento (operação de caixa, como o usuário)
    # ============================================================

    @staticmethod
    def receive_payment(
        player_id: str, data: HouseCreditPaymentCreate, auth_user_id: str, organization_id: Optional[str]
    ) -> HouseCreditMovement:
        HouseCreditService._exigir_migracao()
        from app.services.cashbox_service import CashboxService

        repetido = HouseCreditService._por_cmid(data.client_mutation_id)
        if repetido:
            return HouseCreditService._movimento(repetido, organization_id)

        if data.cash_day_id:
            caixa = CashboxService.require_open_cashbox_for_cash_day(auth_user_id, data.cash_day_id)
        else:
            caixa = CashboxService.require_open_cashbox_for_bar_shift(auth_user_id, data.bar_shift_id)
        if not caixa:
            # Super-admin passa pelos require_open_* sem gaveta. Aqui não dá:
            # o recebimento é dinheiro entrando, e precisa de uma gaveta onde
            # cair — senão a dívida baixa e o dinheiro some.
            raise _recusa("caixa_fechado")

        devido = HouseCreditService.saldo_devedor(player_id, organization_id)
        if data.amount > devido + 0.004:
            raise _recusa(
                "valor_maior_que_a_divida", devido=devido, solicitado=round(data.amount, 2)
            )

        payload = {
            "player_id": player_id,
            "type": "payment",
            "amount": round(data.amount, 2),
            "payment_method": data.payment_method,
            "cashbox_id": caixa["id"],
            "client_mutation_id": data.client_mutation_id,
            "notes": data.notes,
            "created_by": auth_user_id,
        }
        org = organization_id or caixa.get("organization_id")
        if org:
            payload["organization_id"] = org
        try:
            linha = supabase.table("house_credit_entries").insert(payload).execute().data[0]
        except Exception as exc:
            if data.client_mutation_id and ("duplicate key" in str(exc).lower() or "23505" in str(exc)):
                existente = HouseCreditService._por_cmid(data.client_mutation_id)
                if existente:
                    return HouseCreditService._movimento(existente, organization_id)
            _levantar_traduzido(exc)
        return HouseCreditService._movimento(linha, organization_id)

    # ============================================================
    # Gestão (service role, depois de fiado.manage)
    # ============================================================

    @staticmethod
    def write_off(
        player_id: str, amount: float, reason: str, auth_user_id: str, organization_id: str
    ) -> HouseCreditMovement:
        HouseCreditService._exigir_migracao()
        devido = HouseCreditService.saldo_devedor(player_id, organization_id)
        if amount > devido + 0.004:
            raise _recusa(
                "valor_maior_que_a_divida", devido=devido, solicitado=round(amount, 2)
            )
        try:
            linha = supabase_admin.table("house_credit_entries").insert({
                "organization_id": organization_id,
                "player_id": player_id,
                "type": "write_off",
                "amount": round(amount, 2),
                "reason": reason,
                "created_by": auth_user_id,
            }).execute().data[0]
        except Exception as exc:
            _levantar_traduzido(exc)
        return HouseCreditService._movimento(linha, organization_id)

    @staticmethod
    def reverse_payment(
        entry_id: str, reason: str, auth_user_id: str, organization_id: str
    ) -> HouseCreditMovement:
        HouseCreditService._exigir_migracao()
        # Como o usuário: recebimento de outro clube não é encontrado.
        achado = supabase.table("house_credit_entries").select("*").eq("id", entry_id) \
            .eq("type", "payment").limit(1).execute().data or []
        if not achado:
            raise _recusa("recebimento_nao_encontrado")
        original = achado[0]
        ja = supabase.table("house_credit_entries").select("*") \
            .eq("type", "payment_reversal").eq("reverses_entry_id", entry_id) \
            .limit(1).execute().data or []
        if ja:
            return HouseCreditService._movimento(ja[0], organization_id)
        try:
            linha = supabase_admin.table("house_credit_entries").insert({
                "organization_id": organization_id,
                "player_id": original["player_id"],
                "type": "payment_reversal",
                "amount": float(original["amount"]),
                "reverses_entry_id": entry_id,
                "cashbox_id": original.get("cashbox_id"),
                "reason": reason,
                "created_by": auth_user_id,
            }).execute().data[0]
        except Exception as exc:
            _levantar_traduzido(exc)
        return HouseCreditService._movimento(linha, organization_id)

    # ============================================================
    # Auxiliares
    # ============================================================

    @staticmethod
    def _exigir_migracao() -> None:
        if not HouseCreditService.migrado():
            raise ErroDeNegocio(
                "fiado_indisponivel",
                "O fiado ainda não está disponível neste clube.",
                status=503,
            )

    @staticmethod
    def _por_cmid(client_mutation_id: Optional[str]) -> Optional[dict]:
        if not client_mutation_id:
            return None
        linhas = supabase.table("house_credit_entries").select("*") \
            .eq("client_mutation_id", client_mutation_id).limit(1).execute().data or []
        return linhas[0] if linhas else None

    @staticmethod
    def _movimento(linha: dict, organization_id: Optional[str]) -> HouseCreditMovement:
        return HouseCreditMovement(
            entry=HouseCreditService._enriquecer([linha])[0],
            account=HouseCreditService.get_account(linha["player_id"], organization_id),
        )


def _recusa(code: str, **dados) -> ErroDeNegocio:
    """A recusa com a frase e o status do mapa — os mesmos da tradução do banco."""
    frase, status = _RECUSAS[code]
    return ErroDeNegocio(code, frase, status=status, **dados)
