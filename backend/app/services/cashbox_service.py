from typing import List, Optional, Tuple
from datetime import datetime, timezone
from app.database import supabase
from app.utils.erros import ErroDeNegocio
from app.models.cashbox import (
    CashboxResponse,
    CashboxSessionResponse,
    CashboxTransactionResponse,
    CashboxSummary,
    CashboxAggregatedSummary,
    CashboxSessionReport,
    CashboxDemonstrativo,
    CashboxStatus,
    CashboxTransactionType,
)

# Permission keys
PERMISSION_OPERATE = "cashbox.operate"
PERMISSION_ADMIN = "cashbox.admin"
LEGACY_OPERATE_PERMISSIONS = ("cashier", "cashier_players")
LEGACY_ADMIN_PERMISSIONS = ("financial", "general_cash", "employees")


# Signed-amount sign by movement type
# `cash_buy_in` é a compra de fichas na mesa (entra na gaveta); `cash_out` é a
# devolução na saída do jogador (sai da gaveta). Rake e jackpot de cash não
# entram aqui: saem do pote, em fichas, e já estão na gaveta como a diferença
# entre os dois — lançá-los contaria o mesmo dinheiro duas vezes.
_INFLOW_TYPES = {"buy_in", "rebuy", "addon", "supply", "cash_buy_in"}
# `refund` é o estorno de uma venda cancelada: o dinheiro SAI da gaveta e volta
# para o jogador, igual a um prêmio pago.
_OUTFLOW_TYPES = {"prize", "sangria", "refund", "cash_out"}


def _signed(amount: float, tx_type: str) -> float:
    if tx_type in _INFLOW_TYPES:
        return abs(amount)
    if tx_type in _OUTFLOW_TYPES:
        return -abs(amount)
    return amount  # adjustment: caller decides the sign via `amount` itself


def _eh_estorno(tx: dict) -> bool:
    """True para o lançamento que DEVOLVE o dinheiro de uma venda cancelada.

    Ele aparece de duas formas na base:
      - `type='refund'` — o tipo próprio criado junto com o cancelamento de
        venda (database_migration_cancel_sale.sql);
      - `type='adjustment'` COM `transaction_id` preenchido — como o backend
        gravava antes desse tipo existir, e como ele volta a gravar se, no dia
        do deploy, a migração ainda não tiver sido aplicada.

    O ajuste de FECHAMENTO (diferença entre o esperado e o contado) NUNCA tem
    transaction_id, e é o único que precisa ficar de fora do saldo esperado.
    Tratar os dois como a mesma coisa é o que fazia o relatório da sessão
    acusar o operador de furto por um cancelamento feito pelo admin: a venda
    continuava somando no esperado e a devolução era descartada da conta.
    """
    if tx.get("type") == "refund":
        return True
    return tx.get("type") == "adjustment" and (
        tx.get("transaction_id") is not None
        or tx.get("cash_transaction_id") is not None
    )


def _instante(valor) -> Optional[datetime]:
    """Lê o timestamp que vem do Postgres como datetime com fuso.

    Serve só para responder uma pergunta: o lançamento entrou antes ou depois
    do fechamento da sessão? Quando o valor não vem (linha antiga, consulta que
    não pediu a coluna) devolve None e quem chama trata como "não dá para
    afirmar que foi depois" — o relatório fica como sempre foi.
    """
    if not valor:
        return None
    if isinstance(valor, datetime):
        dt = valor
    else:
        texto = str(valor).strip().replace("Z", "+00:00")
        try:
            dt = datetime.fromisoformat(texto)
        except ValueError:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _estorno_apos_fechamento(tx: dict, fechada_em: Optional[datetime]) -> bool:
    """True para o estorno que entrou no ledger DEPOIS do caixa ser fechado.

    Só o estorno é datado desse jeito: todo o resto (suprimento, sangria,
    venda, prêmio, ajuste de contagem) exige caixa ABERTO, então nunca cai numa
    sessão fechada. O estorno cai, porque ele é amarrado à sessão que registrou
    a VENDA — e o admin costuma cancelar a venda no dia seguinte.
    """
    if fechada_em is None:
        return False
    quando = _instante(tx.get("created_at"))
    return quando is not None and quando > fechada_em


class CashboxService:

    # ============================================================
    # Permission helpers
    # ============================================================

    @staticmethod
    def _staff_permissions(auth_user_id: str) -> Tuple[Optional[str], List[str], bool]:
        """Return (staff_id, permissions, is_platform_admin).

        Sem registro em `staff` NÃO significa mais super-admin: isso era um
        fail-open que dava poder total no módulo de caixa a qualquer conta
        autenticada sem staff (e ignorava até a allowlist). Agora só os IDs
        explicitamente listados em SUPER_ADMIN_USER_IDS passam; o resto fica
        sem acesso. Num SaaS isso é obrigatório — uma conta de um cliente sem
        staff jamais pode virar admin.
        """
        resp = supabase.table("staff").select(
            "id, active, permission_groups(permissions)"
        ).eq("auth_user_id", auth_user_id).execute()

        if not resp.data:
            from app.config import get_settings
            is_platform_admin = auth_user_id in get_settings().super_admin_ids
            return None, [], is_platform_admin

        row = resp.data[0]
        if not row.get("active"):
            return row["id"], [], False

        group = row.get("permission_groups") or {}
        perms = group.get("permissions") or []
        return row["id"], perms, False

    @staticmethod
    def _has(perms: List[str], key: str, legacy_keys: Tuple[str, ...] = ()) -> bool:
        if key in perms:
            return True
        return any(k in perms for k in legacy_keys)

    @staticmethod
    def can_admin(auth_user_id: str) -> bool:
        _, perms, is_super = CashboxService._staff_permissions(auth_user_id)
        if is_super:
            return True
        return CashboxService._has(perms, PERMISSION_ADMIN, LEGACY_ADMIN_PERMISSIONS)

    @staticmethod
    def can_operate(auth_user_id: str) -> bool:
        _, perms, is_super = CashboxService._staff_permissions(auth_user_id)
        if is_super:
            return True
        return (
            CashboxService._has(perms, PERMISSION_OPERATE, LEGACY_OPERATE_PERMISSIONS)
            or CashboxService._has(perms, PERMISSION_ADMIN, LEGACY_ADMIN_PERMISSIONS)
        )

    # ============================================================
    # Lookup helpers
    # ============================================================

    @staticmethod
    def get_staff_id_for_user(auth_user_id: str) -> Optional[str]:
        resp = supabase.table("staff").select("id").eq("auth_user_id", auth_user_id).execute()
        return resp.data[0]["id"] if resp.data else None

    @staticmethod
    def _get_or_create(
        staff_id: str,
        stage_id: Optional[str] = None,
        cash_day_id: Optional[str] = None,
    ) -> dict:
        """A gaveta do operador numa ÂNCORA: a etapa (torneio) ou o dia (cash).

        Exatamente uma das duas — é o que o CHECK `cashboxes_ancora_unica`
        garante no banco. No cash a operação é diária, então a gaveta abre e
        fecha por dia e a conferência já sai no recorte que o clube usa.
        """
        if bool(stage_id) == bool(cash_day_id):
            raise ErroDeNegocio(
                "ancora_de_caixa_invalida",
                "O caixa precisa pertencer a uma etapa OU a um dia de cash game.",
            )
        coluna = "stage_id" if stage_id else "cash_day_id"
        valor = stage_id or cash_day_id

        existing = supabase.table("cashboxes").select("*") \
            .eq("staff_id", staff_id).eq(coluna, valor).execute()
        if existing.data:
            return existing.data[0]

        inserted = supabase.table("cashboxes").insert({
            "staff_id": staff_id,
            coluna: valor,
            "status": "closed",
            "current_balance": 0.0,
        }).execute()
        return inserted.data[0]

    @staticmethod
    def get_or_create_for_cash_day(staff_id: str, cash_day_id: str) -> dict:
        """Gaveta do operador no dia de cash. Idempotente."""
        return CashboxService._get_or_create(staff_id, cash_day_id=cash_day_id)

    @staticmethod
    def auto_create_for_staff(staff_id: str, stage_ids: Optional[List[str]] = None) -> List[CashboxResponse]:
        """Ensure the staff has a cashbox in every active stage (or in the
        supplied list). Idempotent. Called from staff_service after create or
        permission change."""
        if stage_ids is None:
            stages = supabase.table("stages").select("id").execute()
            stage_ids = [s["id"] for s in (stages.data or [])]

        results: List[dict] = []
        for sid in stage_ids:
            results.append(CashboxService._get_or_create(staff_id, sid))
        return [CashboxService._enrich(c) for c in results]

    @staticmethod
    def create_for_staff(staff_id: str, stage_id: Optional[str]) -> CashboxResponse:
        """Manually ensure a cashbox exists for a staff member in a stage
        (idempotent). Used by the admin 'Novo Caixa' action."""
        if not stage_id:
            raise ErroDeNegocio("etapa_nao_selecionada", "Selecione uma etapa")
        staff = supabase.table("staff").select("id").eq("id", staff_id).execute()
        if not staff.data:
            raise ErroDeNegocio("funcionario_nao_encontrado", "Funcionário não encontrado", status=404)
        row = CashboxService._get_or_create(staff_id, stage_id)
        return CashboxService._enrich(row)

    @staticmethod
    def find_active_for_operator(auth_user_id: str, stage_id: str) -> Optional[dict]:
        """Return the operator's currently-open cashbox in this stage, or None."""
        staff_id = CashboxService.get_staff_id_for_user(auth_user_id)
        if not staff_id:
            return None
        resp = supabase.table("cashboxes").select("*") \
            .eq("staff_id", staff_id).eq("stage_id", stage_id) \
            .eq("status", "open").execute()
        return resp.data[0] if resp.data else None

    @staticmethod
    def find_active_for_operator_cash_day(auth_user_id: str, cash_day_id: str) -> Optional[dict]:
        """A gaveta ABERTA do operador neste dia de cash, ou None."""
        staff_id = CashboxService.get_staff_id_for_user(auth_user_id)
        if not staff_id:
            return None
        resp = supabase.table("cashboxes").select("*") \
            .eq("staff_id", staff_id).eq("cash_day_id", cash_day_id) \
            .eq("status", "open").execute()
        return resp.data[0] if resp.data else None

    @staticmethod
    def require_open_cashbox_for_cash_day(
        auth_user_id: str, cash_day_id: str
    ) -> Optional[dict]:
        """Irmã de `require_open_cashbox` para o cash game.

        Mesmo contrato: devolve a gaveta aberta, ou levanta. Super-admin de
        plataforma (sem linha em staff) passa direto, como no torneio — senão
        o fluxo de teste do dono do sistema pararia no primeiro clique.
        """
        staff_id, _, is_super = CashboxService._staff_permissions(auth_user_id)
        if is_super:
            return None
        if not staff_id:
            raise ErroDeNegocio(
                "sem_vinculo_de_funcionario",
                "Sua conta não está vinculada a um funcionário.",
                status=403,
            )
        caixa = CashboxService.find_active_for_operator_cash_day(auth_user_id, cash_day_id)
        if not caixa:
            raise ErroDeNegocio(
                "caixa_fechado",
                "Abra o seu caixa antes de movimentar dinheiro.",
            )
        return caixa

    @staticmethod
    def require_open_cashbox_for_tournament(auth_user_id: str, tournament_id: str) -> Optional[dict]:
        """Same as `require_open_cashbox`, but derives the stage from the
        tournament. Used by transaction-creating services that don't see the
        X-Stage-ID header directly."""
        # Super-admin bypass first to avoid hitting the DB for stage lookup
        _, _, is_super = CashboxService._staff_permissions(auth_user_id)
        if is_super:
            return None
        t = supabase.table("tournaments").select("stage_id").eq("id", tournament_id).execute()
        if not t.data:
            raise ErroDeNegocio("torneio_nao_encontrado", "Torneio não encontrado", status=404)
        return CashboxService.require_open_cashbox(auth_user_id, t.data[0].get("stage_id"))

    @staticmethod
    def require_open_cashbox(auth_user_id: str, stage_id: Optional[str]) -> Optional[dict]:
        """Validation hook used by transaction-producing services. Returns the
        open cashbox dict on success; raises ValueError otherwise. If the user
        is a legacy super-admin (no staff row), returns None and skips the
        requirement (so admin testing flows still work)."""
        staff_id, _, is_super = CashboxService._staff_permissions(auth_user_id)
        if is_super:
            return None
        if not staff_id:
            raise ErroDeNegocio("sem_cadastro_de_funcionario", "Usuário não tem cadastro de funcionário")
        if not stage_id:
            raise ErroDeNegocio("etapa_nao_selecionada", "Selecione uma etapa antes de registrar operações no caixa")
        cb = supabase.table("cashboxes").select("*") \
            .eq("staff_id", staff_id).eq("stage_id", stage_id) \
            .eq("status", "open").execute()
        if not cb.data:
            raise ErroDeNegocio(
                "caixa_fechado", "Abra seu caixa antes de registrar operações"
            )
        return cb.data[0]

    # ============================================================
    # Read
    # ============================================================

    @staticmethod
    def _enrich_many(items: List[dict]) -> List[CashboxResponse]:
        """Batch-enrich a list of cashboxes with O(1) extra queries.

        Per-item _enrich issues 2 lookups (staff + stage) per cashbox; for a
        list that is 1 + 2N round-trips to a remote Postgres. Here we resolve
        all staff/stage names in 2 `in_` queries and feed them as maps.
        """
        if not items:
            return []

        staff_ids = {i["staff_id"] for i in items if i.get("staff_id")}
        stage_ids = {i["stage_id"] for i in items if i.get("stage_id")}

        staff_map: dict = {}
        if staff_ids:
            r = supabase.table("staff").select("id, name, email").in_("id", list(staff_ids)).execute()
            staff_map = {s["id"]: s for s in (r.data or [])}

        stage_map: dict = {}
        if stage_ids:
            r = supabase.table("stages").select("id, name").in_("id", list(stage_ids)).execute()
            stage_map = {s["id"]: s.get("name") for s in (r.data or [])}

        return [CashboxService._enrich(i, staff_map, stage_map) for i in items]

    @staticmethod
    def _enrich(
        item: dict,
        staff_map: Optional[dict] = None,
        stage_map: Optional[dict] = None,
    ) -> CashboxResponse:
        staff_name = None
        staff_email = None
        stage_name = None

        staff_id = item.get("staff_id")
        stage_id = item.get("stage_id")

        if staff_id:
            if staff_map is not None:
                s = staff_map.get(staff_id)
                if s:
                    staff_name = s.get("name")
                    staff_email = s.get("email")
            else:
                s = supabase.table("staff").select("name, email").eq("id", staff_id).execute()
                if s.data:
                    staff_name = s.data[0].get("name")
                    staff_email = s.data[0].get("email")

        if stage_id:
            if stage_map is not None:
                stage_name = stage_map.get(stage_id)
            else:
                st = supabase.table("stages").select("name").eq("id", stage_id).execute()
                if st.data:
                    stage_name = st.data[0].get("name")

        return CashboxResponse(
            **item,
            staff_name=staff_name,
            staff_email=staff_email,
            stage_name=stage_name,
        )

    @staticmethod
    def list_cashboxes(
        auth_user_id: str,
        stage_id: Optional[str] = None,
        status: Optional[str] = None,
    ) -> List[CashboxResponse]:
        is_admin = CashboxService.can_admin(auth_user_id)

        query = supabase.table("cashboxes").select("*")
        if stage_id:
            query = query.eq("stage_id", stage_id)
        if status:
            query = query.eq("status", status)
        if not is_admin:
            staff_id = CashboxService.get_staff_id_for_user(auth_user_id)
            if not staff_id:
                return []
            query = query.eq("staff_id", staff_id)

        resp = query.order("created_at", desc=True).execute()
        return CashboxService._enrich_many(resp.data or [])

    @staticmethod
    def get_my_current(
        auth_user_id: str,
        stage_id: Optional[str] = None,
        cash_day_id: Optional[str] = None,
    ) -> Optional[CashboxResponse]:
        """Caixa do operador requisitante na âncora atual (qualquer status).

        A âncora é a etapa (torneio) ou o dia (cash game) — é uma gaveta só, no
        mesmo balcão, e o que muda é o período que ela cobre.
        """
        staff_id = CashboxService.get_staff_id_for_user(auth_user_id)
        if not staff_id:
            return None
        coluna = "cash_day_id" if cash_day_id else "stage_id"
        valor = cash_day_id or stage_id
        resp = supabase.table("cashboxes").select("*") \
            .eq("staff_id", staff_id).eq(coluna, valor).execute()
        if not resp.data:
            # Auto-create on-demand for staff that gained permission after migration
            row = CashboxService._get_or_create(
                staff_id,
                stage_id=None if cash_day_id else stage_id,
                cash_day_id=cash_day_id,
            )
            return CashboxService._enrich(row)
        return CashboxService._enrich(resp.data[0])

    @staticmethod
    def get_cashbox(cashbox_id: str) -> Optional[CashboxResponse]:
        resp = supabase.table("cashboxes").select("*").eq("id", cashbox_id).execute()
        if not resp.data:
            return None
        return CashboxService._enrich(resp.data[0])

    # ============================================================
    # Sessions: open & close
    # ============================================================

    @staticmethod
    def open_session(
        cashbox_id: str,
        auth_user_id: str,
        initial_balance: float,
        notes: Optional[str],
    ) -> CashboxSessionResponse:
        cb = supabase.table("cashboxes").select("*").eq("id", cashbox_id).execute()
        if not cb.data:
            raise ErroDeNegocio("caixa_nao_encontrado", "Caixa não encontrado", status=404)
        cb_row = cb.data[0]

        if cb_row["status"] == "open":
            # 409: o pedido está correto, o que ele quer já existe. A tela usa
            # isso para mandar o operador CONTINUAR na sessão aberta em vez de
            # oferecer "tentar de novo", que abriria a mesma discussão de novo.
            raise ErroDeNegocio("caixa_ja_aberto", "Caixa já está aberto", status=409)
        if cb_row["status"] == "archived":
            raise ErroDeNegocio(
                "caixa_arquivado", "Caixa arquivado não pode ser aberto"
            )

        # Permission: operate own cashbox OR admin to open another's
        is_admin = CashboxService.can_admin(auth_user_id)
        own_staff_id = CashboxService.get_staff_id_for_user(auth_user_id)
        if not is_admin and own_staff_id != cb_row["staff_id"]:
            raise ErroDeNegocio(
                "sem_permissao_abrir_caixa",
                "Sem permissão para abrir este caixa",
                status=403,
            )

        now = datetime.now(timezone.utc).isoformat()
        session_insert = supabase.table("cashbox_sessions").insert({
            "cashbox_id": cashbox_id,
            "opened_at": now,
            "opened_by": auth_user_id,
            "initial_balance": initial_balance,
            "notes": notes,
        }).execute()
        session_row = session_insert.data[0]

        supabase.table("cashboxes").update({
            "status": "open",
            "current_session_id": session_row["id"],
            "current_balance": initial_balance,
            "last_opened_at": now,
            "updated_at": now,
        }).eq("id", cashbox_id).execute()

        # Record the initial balance as a `supply` movement so the ledger
        # explains the opening balance.
        if initial_balance > 0:
            supabase.table("cashbox_transactions").insert({
                "cashbox_id": cashbox_id,
                "session_id": session_row["id"],
                "type": "supply",
                "amount": initial_balance,
                "signed_amount": initial_balance,
                "performed_by": auth_user_id,
                "notes": "Saldo inicial da abertura",
            }).execute()
            # The balance trigger will double-count if we let it: balance was
            # already set to initial_balance above. Re-sync.
            supabase.table("cashboxes").update({
                "current_balance": initial_balance,
            }).eq("id", cashbox_id).execute()

        return CashboxSessionResponse(**session_row)

    @staticmethod
    def close_session(
        cashbox_id: str,
        auth_user_id: str,
        actual_final_balance: float,
        notes: Optional[str],
    ) -> CashboxSessionResponse:
        cb = supabase.table("cashboxes").select("*").eq("id", cashbox_id).execute()
        if not cb.data:
            raise ErroDeNegocio("caixa_nao_encontrado", "Caixa não encontrado", status=404)
        cb_row = cb.data[0]

        if cb_row["status"] != "open":
            raise ErroDeNegocio("caixa_nao_esta_aberto", "Caixa não está aberto")

        is_admin = CashboxService.can_admin(auth_user_id)
        own_staff_id = CashboxService.get_staff_id_for_user(auth_user_id)
        if not is_admin and own_staff_id != cb_row["staff_id"]:
            raise ErroDeNegocio(
                "sem_permissao_fechar_caixa",
                "Sem permissão para fechar este caixa",
                status=403,
            )

        session_id = cb_row.get("current_session_id")
        if not session_id:
            raise ErroDeNegocio(
                "caixa_aberto_sem_sessao",
                "Caixa aberto sem sessão registrada — contate o admin",
            )

        expected = float(cb_row["current_balance"])
        diff = round(actual_final_balance - expected, 2)
        now = datetime.now(timezone.utc).isoformat()

        # If there is a diff, append an adjustment movement BEFORE closing so
        # the cashbox balance ends up equal to the counted amount.
        if diff != 0:
            supabase.table("cashbox_transactions").insert({
                "cashbox_id": cashbox_id,
                "session_id": session_id,
                "type": "adjustment",
                "amount": abs(diff),
                "signed_amount": diff,
                "performed_by": auth_user_id,
                "notes": f"Ajuste de fechamento: esperado R$ {expected:.2f}, contado R$ {actual_final_balance:.2f}",
            }).execute()

        # Close the session
        supabase.table("cashbox_sessions").update({
            "closed_at": now,
            "closed_by": auth_user_id,
            "expected_final_balance": expected,
            "actual_final_balance": actual_final_balance,
            "difference": diff,
            "notes": notes,
        }).eq("id", session_id).execute()

        # Close the cashbox
        supabase.table("cashboxes").update({
            "status": "closed",
            "current_session_id": None,
            "last_closed_at": now,
            "updated_at": now,
        }).eq("id", cashbox_id).execute()

        refreshed = supabase.table("cashbox_sessions").select("*").eq("id", session_id).execute()
        return CashboxSessionResponse(**refreshed.data[0])

    # ============================================================
    # Movements (admin only): supply & sangria
    # ============================================================

    @staticmethod
    def _record_admin_movement(
        cashbox_id: str,
        auth_user_id: str,
        tx_type: str,
        amount: float,
        notes: Optional[str],
    ) -> CashboxTransactionResponse:
        if not CashboxService.can_admin(auth_user_id):
            raise ErroDeNegocio(
                "sem_permissao_movimentar_caixa",
                "Sem permissão para esta operação",
                status=403,
            )

        cb = supabase.table("cashboxes").select("*").eq("id", cashbox_id).execute()
        if not cb.data:
            raise ErroDeNegocio("caixa_nao_encontrado", "Caixa não encontrado", status=404)
        cb_row = cb.data[0]

        if cb_row["status"] != "open":
            raise ErroDeNegocio(
                "caixa_precisa_estar_aberto",
                "Caixa precisa estar aberto para receber movimentações",
            )

        if tx_type == "sangria" and amount > float(cb_row["current_balance"]):
            # O saldo vai como NÚMERO, além da frase: a tela formata na moeda e
            # no idioma do clube (o R$ embutido na frase chega errado no Peru e
            # na Colômbia) e ainda consegue sugerir o valor máximo possível.
            raise ErroDeNegocio(
                "saldo_insuficiente_no_caixa",
                f"Saldo insuficiente — disponível R$ {float(cb_row['current_balance']):.2f}",
                disponivel=float(cb_row["current_balance"]),
                solicitado=float(amount),
            )

        signed = _signed(amount, tx_type)
        insert = supabase.table("cashbox_transactions").insert({
            "cashbox_id": cashbox_id,
            "session_id": cb_row.get("current_session_id"),
            "type": tx_type,
            "amount": amount,
            "signed_amount": signed,
            "performed_by": auth_user_id,
            "notes": notes,
        }).execute()
        return CashboxTransactionResponse(**insert.data[0])

    @staticmethod
    def register_supply(
        cashbox_id: str, auth_user_id: str, amount: float, notes: Optional[str]
    ) -> CashboxTransactionResponse:
        return CashboxService._record_admin_movement(
            cashbox_id, auth_user_id, "supply", amount, notes
        )

    @staticmethod
    def register_sangria(
        cashbox_id: str, auth_user_id: str, amount: float, notes: Optional[str]
    ) -> CashboxTransactionResponse:
        return CashboxService._record_admin_movement(
            cashbox_id, auth_user_id, "sangria", amount, notes
        )

    # ============================================================
    # History queries
    # ============================================================

    @staticmethod
    def list_sessions(cashbox_id: str) -> List[CashboxSessionResponse]:
        resp = supabase.table("cashbox_sessions").select("*") \
            .eq("cashbox_id", cashbox_id).order("opened_at", desc=True).execute()
        return [CashboxSessionResponse(**s) for s in (resp.data or [])]

    @staticmethod
    def list_transactions(
        cashbox_id: str,
        session_id: Optional[str] = None,
    ) -> List[CashboxTransactionResponse]:
        query = supabase.table("cashbox_transactions").select("*") \
            .eq("cashbox_id", cashbox_id)
        if session_id:
            query = query.eq("session_id", session_id)
        resp = query.order("created_at", desc=True).execute()
        return [CashboxTransactionResponse(**t) for t in (resp.data or [])]

    # ============================================================
    # Summaries / demonstrativo
    # ============================================================

    @staticmethod
    def get_summary(
        cashbox_id: str,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
    ) -> CashboxSummary:
        cb = supabase.table("cashboxes").select("*").eq("id", cashbox_id).execute()
        if not cb.data:
            raise ErroDeNegocio("caixa_nao_encontrado", "Caixa não encontrado", status=404)
        cb_row = cb.data[0]

        tx_query = supabase.table("cashbox_transactions").select("*").eq("cashbox_id", cashbox_id)
        if date_from:
            tx_query = tx_query.gte("created_at", date_from)
        if date_to:
            tx_query = tx_query.lte("created_at", date_to)
        txs = tx_query.execute().data or []

        # Initial balance: last opening's initial_balance for "current" period;
        # for filtered ranges, fall back to 0 (period-only view).
        initial = 0.0
        if not date_from and not date_to and cb_row.get("current_session_id"):
            s = supabase.table("cashbox_sessions").select("initial_balance") \
                .eq("id", cb_row["current_session_id"]).execute()
            if s.data:
                initial = float(s.data[0].get("initial_balance") or 0)

        agg = CashboxSummary(
            cashbox_id=cashbox_id,
            status=cb_row["status"],
            initial_balance=initial,
            current_balance=float(cb_row["current_balance"]),
        )

        for t in txs:
            t_type = t["type"]
            amt = float(t["amount"])
            if t_type == "supply":
                agg.total_supply += amt
            elif t_type == "sangria":
                agg.total_sangria += amt
            elif t_type == "buy_in":
                agg.total_buy_ins += amt
                agg.buy_in_count += 1
            elif t_type == "rebuy":
                agg.total_rebuys += amt
                agg.rebuy_count += 1
            elif t_type == "addon":
                agg.total_addons += amt
                agg.addon_count += 1
            elif t_type == "prize":
                agg.total_prizes_paid += amt
                agg.prize_count += 1
            elif t_type == "cash_buy_in":
                agg.total_cash_buy_ins += amt
                agg.cash_buy_in_count += 1
            elif t_type == "cash_out":
                agg.total_cash_outs += amt
                agg.cash_out_count += 1
            elif _eh_estorno(t):
                # Venda cancelada: o dinheiro saiu da gaveta de verdade.
                agg.total_refunds += abs(float(t["signed_amount"]))
                agg.refund_count += 1
            elif t_type == "adjustment":
                agg.total_adjustments += float(t["signed_amount"])

        # ── Saldo esperado ────────────────────────────────────────────────
        # Vem do LEDGER (soma dos `signed_amount`), e não da soma dos campos de
        # exibição acima. Os campos são para a tela; o esperado é dinheiro.
        #
        # Somar campo a campo custou dois bugs:
        #   1. o saldo de abertura era contado DUAS vezes — `open_session` o
        #      grava na sessão (`initial_balance`) E no ledger como `supply`;
        #   2. um tipo NOVO no ledger sumia da conta em silêncio, enquanto o
        #      trigger já o tinha somado em `current_balance`. Foi a armadilha
        #      que os movimentos de cash game encontraram.
        #
        # `signed_amount` é a MESMA fonte que o trigger usa para manter
        # `current_balance`, então esperado e contado passam a ser comparáveis
        # por construção, e um tipo novo entra sozinho.
        movimentos = txs
        sessao_atual = cb_row.get("current_session_id")
        if sessao_atual and not date_from and not date_to:
            # Sem recorte de datas a conferência é da SESSÃO ABERTA: a gaveta
            # que o operador tem na mão agora. `open_session` REDEFINE o saldo
            # a cada abertura em vez de acumular, então incluir as sessões
            # anteriores daria um número que nunca bate com o que está lá.
            movimentos = [t for t in txs if t.get("session_id") == sessao_atual]

        agg.expected_balance = round(
            sum(
                float(t["signed_amount"])
                for t in movimentos
                # O ajuste de FECHAMENTO fica de fora: ele existe justamente
                # para igualar o saldo ao contado, e incluí-lo faria o esperado
                # ser sempre igual ao contado — a diferença sumiria da tela.
                # (O estorno de venda cancelada NÃO é ajuste: é saída real e
                # continua na conta — ver _eh_estorno.)
                if not (t.get("type") == "adjustment" and not _eh_estorno(t))
            ),
            2,
        )

        # Enrich names
        if cb_row.get("staff_id"):
            s = supabase.table("staff").select("name").eq("id", cb_row["staff_id"]).execute()
            if s.data:
                agg.staff_name = s.data[0].get("name")
        if cb_row.get("stage_id"):
            st = supabase.table("stages").select("name").eq("id", cb_row["stage_id"]).execute()
            if st.data:
                agg.stage_name = st.data[0].get("name")
        if cb_row.get("cash_day_id"):
            agg.cash_day_id = cb_row["cash_day_id"]
            cd = supabase.table("cash_days").select("business_date, label") \
                .eq("id", cb_row["cash_day_id"]).execute()
            if cd.data:
                agg.cash_day_label = (
                    cd.data[0].get("label") or str(cd.data[0].get("business_date") or "")
                )

        return agg

    @staticmethod
    def get_aggregated_summary(
        stage_id: Optional[str] = None,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
    ) -> CashboxAggregatedSummary:
        query = supabase.table("cashboxes").select("id")
        if stage_id:
            query = query.eq("stage_id", stage_id)
        ids = [c["id"] for c in (query.execute().data or [])]

        out = CashboxAggregatedSummary()
        for cid in ids:
            s = CashboxService.get_summary(cid, date_from, date_to)
            out.cashboxes.append(s)
            out.grand_total_balance += s.current_balance
            out.grand_total_buy_ins += s.total_buy_ins + s.total_rebuys + s.total_addons
            out.grand_total_prizes += s.total_prizes_paid
            out.grand_total_supply += s.total_supply
            out.grand_total_sangria += s.total_sangria
            out.grand_total_cash_buy_ins += s.total_cash_buy_ins
            out.grand_total_cash_outs += s.total_cash_outs
        return out

    @staticmethod
    def get_demonstrativo(
        stage_id: Optional[str] = None,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
        staff_id: Optional[str] = None,
        cash_day_id: Optional[str] = None,
    ) -> CashboxDemonstrativo:
        """Session-based reconciliation report. Each cashbox_session is one
        open→close cycle that reconciles on its own. Filterable by stage,
        period (session opened_at) and employee."""
        # 1. Cashboxes in scope
        cbq = supabase.table("cashboxes").select(
            "id, staff_id, stage_id, cash_day_id, status, current_balance"
        )
        if stage_id:
            cbq = cbq.eq("stage_id", stage_id)
        if cash_day_id:
            cbq = cbq.eq("cash_day_id", cash_day_id)
        if staff_id:
            cbq = cbq.eq("staff_id", staff_id)
        cashboxes = cbq.execute().data or []
        cb_by_id = {c["id"]: c for c in cashboxes}
        cb_ids = list(cb_by_id.keys())

        out = CashboxDemonstrativo()
        if not cb_ids:
            return out

        # 2. Sessions for these cashboxes within the period (by opened_at)
        sq = supabase.table("cashbox_sessions").select("*").in_("cashbox_id", cb_ids)
        if date_from:
            sq = sq.gte("opened_at", date_from)
        if date_to:
            sq = sq.lte("opened_at", date_to)
        sessions = sq.order("opened_at", desc=True).execute().data or []
        if not sessions:
            return out

        # 3. Transactions grouped by session (single query)
        session_ids = [s["id"] for s in sessions]
        tx_by_session: dict = {}
        # `transaction_id` vem junto de propósito: é ele que separa o estorno de
        # uma venda cancelada do ajuste de contagem do fechamento (_eh_estorno).
        # `created_at` também: é por ele que se sabe se o estorno entrou antes
        # ou depois do fechamento da sessão (o de depois não altera o
        # fechamento — ver _compute_session_report).
        txs = supabase.table("cashbox_transactions").select(
            "session_id, type, amount, signed_amount, transaction_id, "
            "cash_transaction_id, created_at"
        ).in_("session_id", session_ids).execute().data or []
        for tx in txs:
            tx_by_session.setdefault(tx["session_id"], []).append(tx)

        # 4. Name lookups (batch)
        staff_ids = list({c["staff_id"] for c in cashboxes if c.get("staff_id")})
        staff_names: dict = {}
        if staff_ids:
            srows = supabase.table("staff").select("id, name").in_("id", staff_ids).execute().data or []
            staff_names = {r["id"]: r.get("name") for r in srows}
        stage_ids = list({c["stage_id"] for c in cashboxes if c.get("stage_id")})
        stage_names: dict = {}
        if stage_ids:
            strows = supabase.table("stages").select("id, name").in_("id", stage_ids).execute().data or []
            stage_names = {r["id"]: r.get("name") for r in strows}
        day_ids = list({c["cash_day_id"] for c in cashboxes if c.get("cash_day_id")})
        day_labels: dict = {}
        if day_ids:
            drows = supabase.table("cash_days").select("id, business_date, label") \
                .in_("id", day_ids).execute().data or []
            day_labels = {
                r["id"]: (r.get("label") or str(r.get("business_date") or ""))
                for r in drows
            }

        # 5. Build per-session rows
        for s in sessions:
            cb = cb_by_id.get(s["cashbox_id"], {})
            report = CashboxService._compute_session_report(
                s,
                cb,
                tx_by_session.get(s["id"], []),
                staff_name=staff_names.get(cb.get("staff_id")),
                stage_name=stage_names.get(cb.get("stage_id")),
                cash_day_label=day_labels.get(cb.get("cash_day_id")),
            )
            out.sessions.append(report)

            out.grand_initial += report.initial_balance
            out.grand_supply += report.total_supply
            out.grand_sangria += report.total_sangria
            out.grand_buy_ins += report.total_buy_ins + report.total_rebuys + report.total_addons
            out.grand_prizes += report.total_prizes_paid
            out.grand_cash_buy_ins += report.total_cash_buy_ins
            out.grand_cash_outs += report.total_cash_outs
            out.grand_refunds += report.total_refunds
            out.grand_refunds_after_close += report.total_refunds_after_close
            out.grand_adjustments += report.total_adjustments
            out.grand_expected += report.expected_balance
            if report.actual_balance is not None:
                out.grand_actual += report.actual_balance
            if report.difference is not None:
                out.grand_difference += report.difference
            if report.is_open:
                out.open_session_count += 1

        for field in ("grand_initial", "grand_supply", "grand_sangria", "grand_buy_ins",
                      "grand_prizes", "grand_cash_buy_ins", "grand_cash_outs",
                      "grand_refunds", "grand_refunds_after_close",
                      "grand_adjustments",
                      "grand_expected", "grand_actual", "grand_difference"):
            setattr(out, field, round(getattr(out, field), 2))

        return out

    @staticmethod
    def _compute_session_report(
        session: dict,
        cashbox: Optional[dict],
        transactions: List[dict],
        staff_name: Optional[str] = None,
        stage_name: Optional[str] = None,
        cash_day_label: Optional[str] = None,
    ) -> CashboxSessionReport:
        """Pure reconciliation of one session from its transactions. No DB access.

        Within a session the running balance equals SUM(signed_amount); the
        opening balance is recorded both as `initial_balance` and as a `supply`
        movement, and closing differences are booked as an `adjustment`
        movement. So:
          - additional supplies = total supply - opening balance
          - expected = SUM(signed) EXCLUDING adjustments  (== expected_final_balance)
          - difference = actual counted - expected         (== session.difference)

        Só o ajuste de FECHAMENTO sai do esperado. O estorno de venda cancelada
        (`refund`, ou o `adjustment` com transaction_id gravado pelo backend
        antigo) é dinheiro que saiu da gaveta e PERMANECE no esperado — ver
        _eh_estorno.

        SESSÃO FECHADA É RESULTADO CONGELADO. O operador contou a gaveta,
        assinou o fechamento e foi embora; aquilo virou documento. Como o
        estorno de uma venda cancelada é amarrado à sessão que registrou a
        VENDA, ele cai numa sessão já fechada quando o admin cancela no dia
        seguinte — e recalcular o esperado com ele derrubava o esperado sem
        mexer no contado nem na diferença, que ficam gravados na linha da
        sessão. O conferente via `contado - esperado != diferença`: três
        números que não fecham e nenhuma pista de qual valia. Agora o estorno
        posterior fica FORA da conta do fechamento e aparece à parte
        (total_refunds_after_close), que é a verdade da operação: aquele
        dinheiro saiu do caixa geral pela mão do admin, não da gaveta do
        operador naquela noite.
        """
        cashbox = cashbox or {}
        initial = float(session.get("initial_balance") or 0)
        is_open = session.get("closed_at") is None
        fechada_em = None if is_open else _instante(session.get("closed_at"))

        supply = sangria = buy_ins = rebuys = addons = prizes = adjustments = 0.0
        refunds = refunds_after = 0.0
        cash_buy_ins = cash_outs = 0.0
        buy_in_count = rebuy_count = addon_count = prize_count = refund_count = 0
        cash_buy_in_count = cash_out_count = 0
        refund_after_count = 0
        signed_total = 0.0
        for tx in transactions:
            if _eh_estorno(tx) and _estorno_apos_fechamento(tx, fechada_em):
                # Fica fora de signed_total: o fechamento desta sessão já
                # aconteceu e não muda retroativamente.
                refunds_after += abs(float(tx["signed_amount"]))
                refund_after_count += 1
                continue
            amt = float(tx["amount"])
            signed_total += float(tx["signed_amount"])
            ttype = tx["type"]
            if ttype == "supply":
                supply += amt
            elif ttype == "sangria":
                sangria += amt
            elif ttype == "buy_in":
                buy_ins += amt; buy_in_count += 1
            elif ttype == "rebuy":
                rebuys += amt; rebuy_count += 1
            elif ttype == "addon":
                addons += amt; addon_count += 1
            elif ttype == "prize":
                prizes += amt; prize_count += 1
            elif ttype == "cash_buy_in":
                cash_buy_ins += amt; cash_buy_in_count += 1
            elif ttype == "cash_out":
                cash_outs += amt; cash_out_count += 1
            elif _eh_estorno(tx):
                refunds += abs(float(tx["signed_amount"])); refund_count += 1
            elif ttype == "adjustment":
                adjustments += float(tx["signed_amount"])

        extra_supply = round(supply - initial, 2)
        if extra_supply < 0:
            extra_supply = 0.0

        expected = round(signed_total - adjustments, 2)
        if is_open:
            actual = float(cashbox.get("current_balance") or 0)
            difference = round(actual - expected, 2)
        else:
            # O esperado do fechamento é o que ficou gravado na sessão — é o
            # número contra o qual o operador foi conferido. Recalcular daria
            # um valor que não bate com a diferença gravada. Sessão antiga sem
            # o campo cai no cálculo, que é a melhor reconstituição possível.
            congelado = session.get("expected_final_balance")
            if congelado is not None:
                expected = round(float(congelado), 2)
            actual = (
                float(session["actual_final_balance"])
                if session.get("actual_final_balance") is not None
                else None
            )
            difference = (
                float(session["difference"]) if session.get("difference") is not None else None
            )

        return CashboxSessionReport(
            session_id=session["id"],
            cashbox_id=session["cashbox_id"],
            staff_name=staff_name,
            stage_name=stage_name,
            cash_day_label=cash_day_label,
            opened_at=session["opened_at"],
            closed_at=session.get("closed_at"),
            is_open=is_open,
            initial_balance=initial,
            total_supply=extra_supply,
            total_sangria=sangria,
            total_buy_ins=buy_ins,
            buy_in_count=buy_in_count,
            total_rebuys=rebuys,
            rebuy_count=rebuy_count,
            total_addons=addons,
            addon_count=addon_count,
            total_prizes_paid=prizes,
            prize_count=prize_count,
            total_cash_buy_ins=round(cash_buy_ins, 2),
            cash_buy_in_count=cash_buy_in_count,
            total_cash_outs=round(cash_outs, 2),
            cash_out_count=cash_out_count,
            total_refunds=round(refunds, 2),
            refund_count=refund_count,
            total_refunds_after_close=round(refunds_after, 2),
            refund_after_close_count=refund_after_count,
            total_adjustments=adjustments,
            expected_balance=expected,
            actual_balance=actual,
            difference=difference,
        )
