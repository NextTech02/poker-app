from typing import List, Optional
from datetime import datetime, timezone

from app.database import supabase
from app.utils.erros import conflito, nao_encontrado, recusado, sem_permissao
from app.services.cash_day_service import CashDayService
from app.models.chip_consignment import (
    ConsignmentRelease,
    ConsignmentResponse,
    SaleCreate,
    SaleResponse,
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class ChipConsignmentService:

    # ================================================
    # Helpers
    # ================================================

    @staticmethod
    def _staff_for_user(auth_user_id: str) -> Optional[dict]:
        resp = supabase.table("staff").select("id, name, active") \
            .eq("auth_user_id", auth_user_id).execute()
        return resp.data[0] if resp.data else None

    @staticmethod
    def _build(item: dict, with_sales: bool = False) -> ConsignmentResponse:
        sangi = item.pop("staff", None) or {}
        released = float(item.get("released_amount") or 0)
        sold = float(item.get("total_sold") or 0)
        sales = []
        if with_sales:
            sales = ChipConsignmentService.get_sales(item["id"])
        return ConsignmentResponse(
            id=item["id"],
            sangi_staff_id=item["sangi_staff_id"],
            sangi_name=sangi.get("name"),
            stage_id=item.get("stage_id"),
            cash_day_id=item.get("cash_day_id"),
            released_amount=released,
            total_sold=sold,
            remaining=released - sold,
            divergence=(float(item["divergence"]) if item.get("divergence") is not None else None),
            status=item.get("status", "open"),
            opened_at=item["opened_at"],
            reconciled_at=item.get("reconciled_at"),
            notes=item.get("notes"),
            created_at=item["created_at"],
            sales=sales,
        )

    # ================================================
    # Release (cashier opens a consignment)
    # ================================================

    @staticmethod
    def release(data: ConsignmentRelease, cash_day_id: Optional[str], opened_by: str) -> ConsignmentResponse:
        # A consignação é do DIA de cash. O sangeur é papel do cash: ele circula
        # pelas mesas vendendo fichas, enquanto no torneio a venda acontece no
        # caixa, com o jogador indo até lá.
        dia = data.cash_day_id or cash_day_id
        if not dia:
            raise recusado(
                "dia_nao_aberto",
                "Abra o dia de operação antes de liberar fichas para a sangeur.",
            )
        # Liberar ficha para um dia fechado é criar dinheiro fora do que já foi
        # conferido — o abate daquele dia já aconteceu.
        CashDayService.require_open_day(dia)

        # Validate sangi staff exists, is active, and is classified as a sangi.
        # A sangi (chip seller on consignment) is distinct from a cashbox/caixa:
        # only staff whose permission group grants the `sangi` key can receive
        # a consignment. Enforced here so the rule holds even on direct API calls.
        staff = supabase.table("staff").select("id, active, permission_groups(permissions)") \
            .eq("id", data.sangi_staff_id).execute()
        if not staff.data:
            raise nao_encontrado(
                "sangeur_nao_encontrado", "Sangeur (funcionário) não encontrada."
            )
        staff_row = staff.data[0]
        if not staff_row.get("active", True):
            raise recusado("funcionario_inativo", "Funcionário inativo.")
        group = staff_row.get("permission_groups") or {}
        if "sangi" not in (group.get("permissions") or []):
            raise recusado(
                "funcionario_nao_e_sangeur",
                "Este funcionário não está classificado como Sangeur.",
            )

        # Uma consignação aberta por sangeur POR DIA.
        open_existing = supabase.table("chip_consignments").select("id") \
            .eq("sangi_staff_id", data.sangi_staff_id) \
            .eq("cash_day_id", dia) \
            .eq("status", "open").execute()
        if open_existing.data:
            # 409 e não 400: nada de errado no pedido, ele só briga com a
            # consignação que já está aberta — o caminho é abater aquela, não
            # corrigir este pedido.
            raise conflito(
                "consignacao_aberta_existente",
                "Esta sangeur já tem uma consignação aberta hoje. Faça o abate antes de liberar outra.",
                consignment_id=open_existing.data[0].get("id"),
            )

        insert = {
            "sangi_staff_id": data.sangi_staff_id,
            "cash_day_id": dia,
            "released_amount": data.released_amount,
            "status": "open",
            "opened_by": opened_by,
            "notes": data.notes,
        }
        resp = supabase.table("chip_consignments").insert(insert).execute()
        return ChipConsignmentService.get(resp.data[0]["id"])

    # ================================================
    # Queries
    # ================================================

    @staticmethod
    def get(consignment_id: str, with_sales: bool = True) -> ConsignmentResponse:
        resp = supabase.table("chip_consignments") \
            .select("*, staff(name)") \
            .eq("id", consignment_id).execute()
        if not resp.data:
            raise nao_encontrado(
                "consignacao_nao_encontrada", "Consignação não encontrada."
            )
        return ChipConsignmentService._build(resp.data[0], with_sales=with_sales)

    @staticmethod
    def list(cash_day_id: Optional[str] = None, sangi_staff_id: Optional[str] = None,
             status_filter: Optional[str] = None) -> List[ConsignmentResponse]:
        query = supabase.table("chip_consignments").select("*, staff(name)")
        if cash_day_id:
            query = query.eq("cash_day_id", cash_day_id)
        if sangi_staff_id:
            query = query.eq("sangi_staff_id", sangi_staff_id)
        if status_filter:
            query = query.eq("status", status_filter)
        resp = query.order("created_at", desc=True).execute()
        return [ChipConsignmentService._build(i, with_sales=False) for i in (resp.data or [])]

    @staticmethod
    def get_my_open(auth_user_id: str, cash_day_id: Optional[str] = None) -> Optional[ConsignmentResponse]:
        """For the sangi: the open consignment assigned to them."""
        staff = ChipConsignmentService._staff_for_user(auth_user_id)
        if not staff:
            return None
        query = supabase.table("chip_consignments").select("*, staff(name)") \
            .eq("sangi_staff_id", staff["id"]).eq("status", "open")
        if cash_day_id:
            query = query.eq("cash_day_id", cash_day_id)
        resp = query.order("created_at", desc=True).execute()
        if not resp.data:
            return None
        return ChipConsignmentService._build(resp.data[0], with_sales=True)

    @staticmethod
    def get_sales(consignment_id: str) -> List[SaleResponse]:
        resp = supabase.table("chip_consignment_sales") \
            .select("*, players(name), cash_tables(table_number)") \
            .eq("consignment_id", consignment_id) \
            .order("created_at", desc=True).execute()
        out = []
        for linha in (resp.data or []):
            mesa = linha.pop("cash_tables", None) or {}
            out.append(ChipConsignmentService._venda(
                linha, table_number=mesa.get("table_number")))
        return out

    # ================================================
    # Sale (sangi registers a sale)
    # ================================================

    @staticmethod
    def register_sale(consignment_id: str, data: SaleCreate, sold_by: str,
                      acting_auth_user_id: Optional[str] = None,
                      restrict_to_self: bool = False) -> SaleResponse:
        cons = supabase.table("chip_consignments").select("*") \
            .eq("id", consignment_id).execute()
        if not cons.data:
            raise nao_encontrado(
                "consignacao_nao_encontrada", "Consignação não encontrada."
            )
        c = cons.data[0]
        if c["status"] != "open":
            raise conflito(
                "consignacao_ja_reconciliada",
                "Consignação já reconciliada; não aceita novas vendas.",
            )

        # When the caller is the sangi, ensure they only sell on their own consignment
        if restrict_to_self and acting_auth_user_id:
            staff = ChipConsignmentService._staff_for_user(acting_auth_user_id)
            if not staff or staff["id"] != c["sangi_staff_id"]:
                raise sem_permissao(
                    "consignacao_de_outro_sangeur",
                    "Você só pode registrar vendas da sua própria consignação.",
                )

        # Duplo clique e retry não podem virar duas vendas — e aqui isso custaria
        # fichas de verdade, porque a venda debita a consignação E lança dinheiro
        # no dia.
        if data.client_mutation_id:
            ja = supabase.table("chip_consignment_sales").select("*, players(name)") \
                .eq("client_mutation_id", data.client_mutation_id).limit(1).execute()
            if ja.data:
                return ChipConsignmentService._venda(ja.data[0])

        # Buyer must be a registered player
        player = supabase.table("players").select("id, name") \
            .eq("id", data.buyer_player_id).execute()
        if not player.data:
            raise nao_encontrado(
                "comprador_nao_encontrado", "Comprador (jogador) não encontrado."
            )

        # A mesa precisa ser do MESMO dia da consignação: vender fichas do dia
        # de ontem numa mesa de hoje misturaria dois fechamentos.
        mesa = supabase.table("cash_tables").select("id, cash_day_id, table_number, status") \
            .eq("id", data.table_id).limit(1).execute()
        if not mesa.data:
            raise nao_encontrado("mesa_nao_encontrada", "Mesa não encontrada.")
        mesa = mesa.data[0]
        if c.get("cash_day_id") and mesa["cash_day_id"] != c["cash_day_id"]:
            raise recusado(
                "mesa_de_outro_dia",
                "Esta mesa não é do dia desta consignação.",
            )
        if mesa.get("status") == "closed":
            raise conflito("mesa_ja_fechada", "Esta mesa já foi fechada.")

        # O comprador tem de estar SENTADO nessa mesa. É o que diz em qual
        # sessão o dinheiro entra — sem isso o resultado da noite do jogador
        # sairia errado, e ninguém saberia de quem era a ficha.
        sessao = supabase.table("cash_player_sessions").select("id") \
            .eq("table_id", data.table_id) \
            .eq("player_id", data.buyer_player_id) \
            .eq("status", "active").limit(1).execute()
        if not sessao.data:
            raise recusado(
                "jogador_nao_esta_na_mesa",
                "Este jogador não está sentado nesta mesa.",
                player_id=data.buyer_player_id, table_id=data.table_id,
            )
        player_session_id = sessao.data[0]["id"]

        # Optional guard: don't let sales exceed what was released
        new_total = float(c.get("total_sold") or 0) + data.amount
        if new_total > float(c["released_amount"]) + 0.001:
            # Os dois valores vão como DADO além da frase: a tela formata na
            # moeda do clube (o "R$" embutido chega errado no Peru e na
            # Colômbia) e consegue mostrar quanto ainda cabe nesta venda.
            raise recusado(
                "venda_excede_o_liberado",
                (f"Venda excede o valor liberado. Liberado: R$ {float(c['released_amount']):.2f}, "
                 f"já vendido: R$ {float(c.get('total_sold') or 0):.2f}."),
                liberado=float(c["released_amount"]),
                vendido=float(c.get("total_sold") or 0),
            )

        insert = {
            "consignment_id": consignment_id,
            "amount": data.amount,
            "buyer_player_id": data.buyer_player_id,
            "sold_by": sold_by,
            "table_id": data.table_id,
            "client_mutation_id": data.client_mutation_id,
            "notes": data.notes,
        }
        # The app-layer check above is a friendly fast-path, but it is not
        # atomic. The DB trigger chip_consignment_apply_sale enforces the cap
        # under concurrency and raises if this sale would oversell. Translate
        # that into a clean 400 (instead of a 500) for the race loser.
        try:
            resp = supabase.table("chip_consignment_sales").insert(insert).execute()
        except Exception as exc:
            msg = str(exc)
            if "excede o valor liberado" in msg or "reconciliada" in msg:
                raise recusado(
                    "venda_excede_o_liberado",
                    "Venda excede o valor liberado para esta consignação.",
                )
            raise
        sale = resp.data[0]

        # ── O dinheiro do DIA ────────────────────────────────────────────────
        # A venda vira um `rebuy` do jogador naquela mesa. Sem isto o sangeur
        # vende R$ 500 em fichas e o dia não enxerga esse dinheiro: o total de
        # buy-ins fica curto, a sessão do jogador mostra um resultado que não é
        # o dele, e o fechamento do dia não fecha.
        #
        # `rebuy` e não `buy_in` porque neste módulo o buy-in é o ato de SENTAR
        # (é ele que valida o mínimo da mesa e cria a sessão). Quem já está
        # sentado e compra mais fichas está recomprando.
        #
        # `consignment_id` é o que faz o trigger NÃO espelhar isto numa gaveta:
        # o dinheiro está com o sangeur, e quem o controla é a consignação.
        try:
            tx = supabase.table("cash_transactions").insert({
                "cash_day_id": mesa["cash_day_id"],
                "table_id": data.table_id,
                "player_session_id": player_session_id,
                "player_id": data.buyer_player_id,
                "type": "rebuy",
                "amount": data.amount,
                "consignment_id": consignment_id,
                "created_by": sold_by,
                "status": "active",
                "notes": data.notes,
                "organization_id": c.get("organization_id"),
            }).execute()
            sale["cash_transaction_id"] = tx.data[0]["id"]
            supabase.table("chip_consignment_sales") \
                .update({"cash_transaction_id": tx.data[0]["id"]}) \
                .eq("id", sale["id"]).execute()
        except Exception:
            # A venda já debitou a consignação (o trigger do banco soma o
            # `total_sold` no INSERT). Deixá-la de pé sem o lançamento no dia
            # criaria fichas vendidas que o dia não conhece — a divergência
            # apareceria só no abate, sem ninguém saber de onde veio.
            supabase.table("chip_consignment_sales").delete().eq("id", sale["id"]).execute()
            raise

        return ChipConsignmentService._venda(
            sale, buyer_name=player.data[0].get("name"),
            table_number=mesa.get("table_number"),
        )

    @staticmethod
    def _venda(linha: dict, buyer_name: Optional[str] = None,
               table_number: Optional[int] = None) -> SaleResponse:
        """Monta a resposta de uma venda. Usado pela gravação e pela releitura
        do `client_mutation_id` repetido, para os dois caminhos devolverem
        exatamente a mesma coisa."""
        jogador = linha.pop("players", None) or {}
        return SaleResponse(
            id=linha["id"],
            consignment_id=linha["consignment_id"],
            amount=float(linha["amount"]),
            buyer_player_id=linha["buyer_player_id"],
            buyer_player_name=buyer_name or jogador.get("name"),
            sold_by=linha.get("sold_by"),
            table_id=linha.get("table_id"),
            table_number=table_number,
            cash_transaction_id=linha.get("cash_transaction_id"),
            notes=linha.get("notes"),
            created_at=linha["created_at"],
        )

    @staticmethod
    def delete_sale(consignment_id: str, sale_id: str) -> None:
        cons = supabase.table("chip_consignments").select("status") \
            .eq("id", consignment_id).execute()
        if not cons.data:
            raise nao_encontrado(
                "consignacao_nao_encontrada", "Consignação não encontrada."
            )
        if cons.data[0]["status"] != "open":
            raise conflito(
                "consignacao_ja_reconciliada",
                "Consignação reconciliada; vendas não podem ser alteradas.",
            )
        supabase.table("chip_consignment_sales").delete() \
            .eq("id", sale_id).eq("consignment_id", consignment_id).execute()

    # ================================================
    # Reconcile (cashier closes / abate)
    # ================================================

    @staticmethod
    def reconcile(consignment_id: str, reconciled_by: str, notes: Optional[str] = None) -> ConsignmentResponse:
        cons = supabase.table("chip_consignments").select("*") \
            .eq("id", consignment_id).execute()
        if not cons.data:
            raise nao_encontrado(
                "consignacao_nao_encontrada", "Consignação não encontrada."
            )
        c = cons.data[0]
        if c["status"] == "reconciled":
            raise conflito(
                "consignacao_ja_reconciliada", "Consignação já reconciliada."
            )

        released = float(c["released_amount"])
        sold = float(c.get("total_sold") or 0)
        divergence = released - sold  # >0 = faltou vender/repor; deve ser 0 quando tudo certo

        update = {
            "status": "reconciled",
            "divergence": divergence,
            "reconciled_by": reconciled_by,
            "reconciled_at": _now(),
            "updated_at": _now(),
        }
        if notes:
            update["notes"] = notes
        supabase.table("chip_consignments").update(update).eq("id", consignment_id).execute()
        return ChipConsignmentService.get(consignment_id)
