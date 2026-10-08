import logging
from typing import List, Optional, Tuple
from collections import Counter
from app.database import supabase
# Recusa com CODIGO (a tela traduz pelo `code`); herda de ValueError, entao o
# `except ValueError` do router continua valendo.
from app.utils.erros import ErroDeNegocio
from app.models.stage import (
    StageCreate,
    StageUpdate,
    Stage,
    StageSummary,
    StageDeleteImpact,
    validar_datas_da_etapa,
)

logger = logging.getLogger("uvicorn.error")

# Mensagem da recusa de exclusão. O router a transforma em 409.
MSG_ETAPA_COM_MOVIMENTO = (
    "Esta etapa tem movimento financeiro e não pode ser excluída"
)


class StageService:
    @staticmethod
    def create_stage(stage_data: StageCreate) -> Stage:
        """Create a new stage"""
        # Regras de data cobradas AQUI (e não num model_validator do Pydantic):
        # assim o erro sobe como ValueError e o router responde 400 com o texto
        # em português, do mesmo jeito que a edição.
        validar_datas_da_etapa(stage_data.start_date, stage_data.end_date)

        data = stage_data.model_dump()

        # Convert dates to ISO format strings if present
        if data.get('start_date'):
            data['start_date'] = data['start_date'].isoformat()
        if data.get('end_date'):
            data['end_date'] = data['end_date'].isoformat()

        response = supabase.table("stages").insert(data).execute()
        return Stage(**response.data[0])

    @staticmethod
    def get_stage(stage_id: str) -> Optional[Stage]:
        """Get a specific stage by ID"""
        response = supabase.table("stages").select("*").eq("id", stage_id).execute()
        if response.data:
            return Stage(**response.data[0])
        return None

    @staticmethod
    def get_stages(status: Optional[str] = None) -> List[StageSummary]:
        """All stages with tournament_count. Single round-trip via the
        `get_stage_summaries` RPC; falls back to the batched query path if the
        RPC isn't deployed yet."""
        statuses = [s.strip() for s in status.split(",")] if status else None
        try:
            resp = supabase.rpc("get_stage_summaries", {"p_statuses": statuses}).execute()
            return [StageSummary(**row) for row in (resp.data or [])]
        except Exception as exc:
            logger.warning("get_stage_summaries RPC unavailable, using batched fallback: %s", exc)
            return StageService._get_stages_batched(status)

    @staticmethod
    def _get_stages_batched(status: Optional[str] = None) -> List[StageSummary]:
        """Get all stages with tournament count, optionally filtered by status"""
        query = supabase.table("stages").select("*")

        if status:
            # Handle multiple statuses separated by comma
            status_list = [s.strip() for s in status.split(",")]
            if len(status_list) == 1:
                query = query.eq("status", status_list[0])
            else:
                query = query.in_("status", status_list)

        stages = query.order("created_at", desc=True).execute().data or []
        if not stages:
            return []

        # Tournament counts in ONE round-trip instead of one COUNT per stage
        # (N+1). Fetch the stage_id of every tournament in these stages and tally
        # them in memory with a Counter (hash map, O(n)).
        stage_ids = [s["id"] for s in stages]
        tournament_rows = (
            supabase.table("tournaments")
            .select("stage_id")
            .in_("stage_id", stage_ids)
            .execute()
            .data
            or []
        )
        counts = Counter(r["stage_id"] for r in tournament_rows if r.get("stage_id"))

        return [
            StageSummary(**stage_data, tournament_count=counts.get(stage_data["id"], 0))
            for stage_data in stages
        ]

    @staticmethod
    def update_stage(stage_id: str, stage_data: StageUpdate) -> Optional[Stage]:
        """Update a stage"""
        data = stage_data.model_dump(exclude_unset=True)

        # As regras de data valem sobre o RESULTADO da edição, não sobre o
        # corpo do PATCH: mandar só `end_date` precisa ser comparado com o
        # início que já está gravado. Por isso a etapa é lida antes.
        atual = StageService.get_stage(stage_id)
        if not atual:
            return None
        inicio = data["start_date"] if "start_date" in data else atual.start_date
        fim = data["end_date"] if "end_date" in data else atual.end_date
        # Etapa antiga gravada sem data nenhuma continua sendo lida e operada
        # normalmente, mas na hora de EDITAR pedimos a data que faltou — é o
        # único momento em que dá para pedir sem travar o resto.
        validar_datas_da_etapa(inicio, fim)

        # Convert dates to ISO format strings if present
        if 'start_date' in data and data['start_date']:
            data['start_date'] = data['start_date'].isoformat()
        if 'end_date' in data and data['end_date']:
            data['end_date'] = data['end_date'].isoformat()

        response = (
            supabase.table("stages")
            .update(data)
            .eq("id", stage_id)
            .execute()
        )

        if response.data:
            return Stage(**response.data[0])
        return None

    @staticmethod
    def archive_stage(stage_id: str) -> Optional[Stage]:
        """Arquiva a etapa em vez de apagá-la: status 'cancelled'.

        É a saída oferecida quando a exclusão é recusada. Não passa por
        `update_stage` de propósito — uma etapa antiga SEM data de início
        precisa poder ser tirada da frente sem que alguém invente uma data
        para ela só para conseguir arquivar.
        """
        response = (
            supabase.table("stages")
            .update({"status": "cancelled"})
            .eq("id", stage_id)
            .execute()
        )
        if response.data:
            return Stage(**response.data[0])
        return None

    @staticmethod
    def _contar(tabela: str, stage_id: str, coluna_valor: Optional[str] = None) -> Tuple[int, float]:
        """Quantas linhas desta tabela morrem com a etapa (e quanto dinheiro).

        Cada tabela vai num try próprio: uma instalação pode não ter rodado
        ainda a migração que cria `other_revenues` ou `chip_consignments`, e o
        aviso de exclusão não pode ser a coisa que quebra a tela.
        """
        try:
            linhas = (
                supabase.table(tabela)
                .select("*")
                .eq("stage_id", stage_id)
                .execute()
                .data
                or []
            )
        except Exception as exc:  # tabela ausente / sem permissão
            logger.warning("Impacto de exclusão: %s indisponível (%s)", tabela, exc)
            return 0, 0.0
        total = 0.0
        if coluna_valor:
            total = sum(float(linha.get(coluna_valor) or 0) for linha in linhas)
        return len(linhas), total

    @staticmethod
    def _contar_meios_de_entrada(stage_id: str) -> int:
        """Quantos meios de entrada morrem com a etapa.

        A lista é do TORNEIO (`buy_types.tournament_id`): contar por `stage_id`
        só enxergaria o legado da época em que ela era da etapa, e o aviso
        diria zero para toda etapa criada depois. Por isso passa pelos torneios
        da etapa — e soma o legado, que ainda existe no banco.
        """
        try:
            torneios = (
                supabase.table("tournaments")
                .select("id")
                .eq("stage_id", stage_id)
                .execute()
                .data
                or []
            )
            encontrados = set()
            ids = [t["id"] for t in torneios]
            if ids:
                do_torneio = (
                    supabase.table("buy_types")
                    .select("id")
                    .in_("tournament_id", ids)
                    .execute()
                    .data
                    or []
                )
                encontrados.update(l["id"] for l in do_torneio)
            legados = (
                supabase.table("buy_types")
                .select("id")
                .eq("stage_id", stage_id)
                .execute()
                .data
                or []
            )
            encontrados.update(l["id"] for l in legados)
            return len(encontrados)
        except Exception as exc:  # tabela ausente / sem permissão
            logger.warning("Impacto de exclusão: buy_types indisponível (%s)", exc)
            return 0

    @staticmethod
    def get_delete_impact(stage_id: str) -> Optional[StageDeleteImpact]:
        """Resumo do estrago que a exclusão desta etapa causaria."""
        etapa = StageService.get_stage(stage_id)
        if not etapa:
            return None

        sangrias, sangrias_valor = StageService._contar("sangria_transactions", stage_id, "amount")
        despesas, despesas_valor = StageService._contar("expenses", stage_id, "amount")
        receitas, receitas_valor = StageService._contar("other_revenues", stage_id, "amount")
        pagamentos, pagamentos_valor = StageService._contar("staff_payments", stage_id, "amount")
        consignacoes, _ = StageService._contar("chip_consignments", stage_id)
        caixas, _ = StageService._contar("cashboxes", stage_id)
        tipos_de_buy = StageService._contar_meios_de_entrada(stage_id)
        torneios, _ = StageService._contar("tournaments", stage_id)

        saldo = recebido = 0.0
        try:
            caixa = (
                supabase.table("stage_cash_register")
                .select("*")
                .eq("stage_id", stage_id)
                .execute()
                .data
                or []
            )
            if caixa:
                saldo = float(caixa[0].get("current_balance") or 0)
                recebido = float(caixa[0].get("total_received") or 0)
        except Exception as exc:
            logger.warning("Impacto de exclusão: stage_cash_register indisponível (%s)", exc)

        # O que caracteriza "tem dinheiro no meio". Tipos de buy e caixas
        # vazios são CONFIGURAÇÃO (recriável) e sozinhos não bloqueiam; já
        # `total_received` pega qualquer venda que a etapa tenha registrado,
        # mesmo que o saldo tenha sido zerado por sangria.
        bloqueado = bool(
            sangrias or despesas or receitas or pagamentos or consignacoes
            or saldo or recebido
        )

        return StageDeleteImpact(
            stage_id=stage_id,
            stage_name=etapa.name,
            tournaments=torneios,
            sangrias=sangrias, sangrias_amount=sangrias_valor,
            expenses=despesas, expenses_amount=despesas_valor,
            other_revenues=receitas, other_revenues_amount=receitas_valor,
            staff_payments=pagamentos, staff_payments_amount=pagamentos_valor,
            chip_consignments=consignacoes,
            cashboxes=caixas,
            buy_types=tipos_de_buy,
            cash_balance=saldo,
            cash_total_received=recebido,
            blocked=bloqueado,
        )

    @staticmethod
    def delete_stage(stage_id: str) -> bool:
        """Apaga a etapa — só quando não há contabilidade para perder.

        As FKs são ON DELETE CASCADE: um DELETE aqui leva junto sangrias,
        despesas, outras receitas, pagamentos de funcionário, caixas, tipos de
        buy e consignações. Dinheiro apagado não volta, e não existe tela de
        desfazer, então a recusa é do serviço (a tela pode ser contornada; a
        fila offline e o cliente HTTP direto não passam por ela). Quem quer
        tirar a etapa da frente arquiva: `archive_stage`.
        """
        impacto = StageService.get_delete_impact(stage_id)
        if impacto is None:
            return False
        if impacto.blocked:
            raise ErroDeNegocio(
                "etapa_com_movimento_financeiro", MSG_ETAPA_COM_MOVIMENTO, status=409
            )
        response = supabase.table("stages").delete().eq("id", stage_id).execute()
        return len(response.data) > 0
