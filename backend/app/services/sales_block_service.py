"""Bloqueio de vendas por DIA e por ETAPA.

Encerrado o registro tardio, o diretor precisa que o Caixa PARE de vender
aquele dia. Desabilitar o botão na tela não basta: a fila offline e qualquer
chamada direta à API continuariam passando. Por isso a trava mora aqui, ao lado
da exigência de caixa aberto (`CashboxService.require_open_cashbox_*`), que é o
ponto por onde toda venda já passa.

Bloqueio efetivo = dia bloqueado OU etapa bloqueada. O DIA é a trava fina
(encerrou o Dia 1A e o 1B da mesma etapa continua vendendo); a ETAPA é a
chave-mestra ("fecha tudo agora").
"""
import logging
from typing import Optional

from app.database import supabase

logger = logging.getLogger(__name__)

# Entradas: são as únicas vendas que a trava barra. Prêmio é SAÍDA de caixa e
# continua podendo ser pago com as vendas encerradas — é justamente o que o
# clube faz depois de fechar o registro.
TIPOS_DE_VENDA = ("buy_in", "rebuy", "addon")

# Sinais de "a coluna ainda não existe neste banco" (migração pendente). Serve
# só para escolher o nível do log: migração pendente é rotina no dia do deploy,
# falha de infraestrutura é anomalia que alguém precisa ver.
_SINAIS_DE_COLUNA_AUSENTE = (
    "undefined_column",
    "42703",
    "does not exist",
    "não existe",
    "could not find",
)


def _falta_a_coluna_de_bloqueio(erro: Exception) -> bool:
    """A consulta falhou porque o banco ainda não tem as colunas da trava?"""
    partes = [str(erro)]
    for atributo in ("code", "message", "details", "hint"):
        valor = getattr(erro, atributo, None)
        if valor:
            partes.append(str(valor))
    blob = " ".join(partes).lower()
    if "sales_blocked" not in blob and "42703" not in blob:
        return False
    return any(sinal in blob for sinal in _SINAIS_DE_COLUNA_AUSENTE)


def seguir_sem_a_trava(erro: Exception, onde: str) -> None:
    """Consulta da trava falhou: registra no log e DEIXA A VENDA SEGUIR.

    UMA política só, igual para o DIA e para a ETAPA — antes cada consulta
    fazia uma coisa diferente com o mesmo risco, dentro do mesmo pedido.

    Por que passar em vez de recusar, pensando em quem está no balcão:

    1. A trava é controle SECUNDÁRIO. O diretor já desliga o botão na tela; esta
       consulta é a rede embaixo. Ela fica DESLIGADA na quase totalidade das
       noites, e mesmo assim rodava em TODA venda.
    2. Recusar transformava qualquer soluço de 3 s do PostgREST — ou um erro de
       RLS numa organização — em "o Caixa parou de vender" para o clube inteiro,
       com a fila no balcão e sem contorno possível para o operador.
    3. Se o banco está mesmo fora, a venda não entra de qualquer jeito: o INSERT
       logo em seguida também falha. Recusar aqui não protege dinheiro nenhum;
       só troca a mensagem de erro.
    4. O custo de passar é, no pior caso, UMA venda a mais num dia que o diretor
       acabou de encerrar — corrigível pelo estorno. O custo de recusar é a noite
       inteira parada.

    Não é silêncio: falha de infraestrutura sai como ERROR no log, com o lugar,
    para dar de auditar depois.
    """
    if _falta_a_coluna_de_bloqueio(erro):
        logger.info("Trava de vendas ignorada em %s: migração ainda não aplicada", onde)
        return
    logger.error(
        "Trava de vendas NÃO verificada em %s (a venda seguiu): %s", onde, erro
    )


class SalesBlockService:
    @staticmethod
    def _bloqueio_do_dia(tournament_day_id: Optional[str], day_row: Optional[dict]) -> Optional[str]:
        """Devolve o MOTIVO se o dia estiver bloqueado, senão None.

        Motivo vazio vira uma string vazia, não None, para o chamador conseguir
        distinguir "bloqueado sem motivo informado" de "liberado".
        """
        row = day_row
        # O dia pode chegar embutido numa consulta com join (recompra/add-on),
        # e aí o PostgREST às vezes devolve lista em vez de objeto.
        if isinstance(row, list):
            row = row[0] if row else None
        if row is None:
            if not tournament_day_id:
                return None
            try:
                r = supabase.table("tournament_days").select("*").eq("id", tournament_day_id).execute()
            except Exception as exc:
                seguir_sem_a_trava(exc, f"dia {tournament_day_id}")
                return None
            row = r.data[0] if r.data else None
        if row and row.get("sales_blocked"):
            return row.get("sales_blocked_reason") or ""
        return None

    @staticmethod
    def _bloqueio_da_etapa(tournament_id: str) -> Optional[str]:
        """Motivo do bloqueio da etapa do torneio, ou None.

        Uma consulta só (com o join da etapa) porque isto roda em TODA venda —
        o gargalo desta aplicação é a cascata de chamadas, não o banco.

        A consulta CITA `sales_blocked`: num banco sem a migração ela falha, e
        aí o bloqueio é ignorado, para o backend novo conviver com o banco
        antigo — o deploy não é atômico com a migração (ver
        `seguir_sem_a_trava` para o que acontece nas demais falhas).
        """
        try:
            r = (
                supabase.table("tournaments")
                .select("stage_id, stages(sales_blocked, sales_blocked_reason)")
                .eq("id", tournament_id)
                .execute()
            )
        except Exception as exc:
            seguir_sem_a_trava(exc, f"etapa do torneio {tournament_id}")
            return None
        if not r.data:
            return None
        stage = r.data[0].get("stages") or {}
        if isinstance(stage, list):
            stage = stage[0] if stage else {}
        if stage.get("sales_blocked"):
            return stage.get("sales_blocked_reason") or ""
        return None

    @staticmethod
    def _exigir_dia_liberado(
        tournament_day_id: Optional[str], day_row: Optional[dict] = None
    ) -> None:
        motivo = SalesBlockService._bloqueio_do_dia(tournament_day_id, day_row)
        if motivo is not None:
            raise ValueError(
                f"Vendas bloqueadas para este dia: {motivo}" if motivo
                else "Vendas bloqueadas para este dia do torneio"
            )

    @staticmethod
    def _exigir_etapa_liberada(tournament_id: str) -> None:
        motivo = SalesBlockService._bloqueio_da_etapa(tournament_id)
        if motivo is not None:
            raise ValueError(
                f"Vendas bloqueadas para esta etapa: {motivo}" if motivo
                else "Vendas bloqueadas para esta etapa"
            )

    @staticmethod
    def assert_sales_allowed(
        tournament_id: str,
        tournament_day_id: Optional[str] = None,
        day_row: Optional[dict] = None,
    ) -> None:
        """Levanta ValueError quando a venda está bloqueada (dia OU etapa).

        `day_row` evita uma ida ao banco quando quem chama já leu o dia.

        ATENÇÃO: `TransactionService.create_transaction` depende desta chamada
        para a trava da ETAPA da venda avulsa — o router só checa o DIA (ver
        `assert_day_sales_allowed`). Tirar a chamada de lá desliga a
        chave-mestra do diretor no POST /transactions.
        """
        SalesBlockService._exigir_dia_liberado(tournament_day_id, day_row)
        SalesBlockService._exigir_etapa_liberada(tournament_id)

    @staticmethod
    def dia_da_venda(tournament_id: str, player_id: str) -> Optional[str]:
        """Descobre o DIA de uma venda avulsa (POST /transactions).

        Essa rota não recebe o dia no corpo, mas move caixa, prize pool e
        fidelidade pelos triggers — checar só a etapa deixaria o Dia 1A
        encerrado continuar vendendo por fora. Quem diz o dia é a inscrição do
        jogador no torneio.

        A ORDEM é obrigatória. Desde a inscrição por dia
        (database_migration_fix_player_unique_constraint.sql) o mesmo jogador
        tem UMA linha por dia — 1A e 1B do mesmo torneio. Sem `order`, o
        PostgREST devolve as linhas na ordem que o Postgres quiser, e a trava
        passava a sortear qual dia checar: ora barrava a venda do 1B porque o
        1A estava encerrado, ora deixava passar uma venda no dia bloqueado. Em
        pé de caixa, isso vira "às vezes deixa, às vezes não" — o pior tipo de
        bug para quem está com a fila na frente.

        A chave é `registered_at` crescente (a inscrição mais antiga), com o
        `id` como desempate para nunca haver empate. O objetivo é checar o dia
        da MESMA inscrição que `create_transaction` grava em
        `tournament_player_id`; para isso as duas consultas precisam ordenar
        igual (`registered_at`, depois `id`).
        """
        try:
            r = (
                supabase.table("tournament_players")
                .select("tournament_day_id")
                .eq("tournament_id", tournament_id)
                .eq("player_id", player_id)
                .order("registered_at")
                .order("id")
                .execute()
            )
        except Exception as exc:
            # Mesma política da consulta da trava (ver `seguir_sem_a_trava`):
            # a venda segue e a falha fica registrada. Sem a inscrição também
            # não há dia a checar — é o caso normal do buy-in de jogador novo.
            seguir_sem_a_trava(exc, f"dia da venda avulsa (torneio {tournament_id})")
            return None
        # Linha sem dia é inscrição anterior aos torneios multi-dia: ela não
        # tem dia a checar, então a busca continua na próxima (a trava da etapa
        # segue valendo para todas).
        for linha in (r.data or []):
            if linha.get("tournament_day_id"):
                return linha["tournament_day_id"]
        return None

    @staticmethod
    def assert_day_sales_allowed(
        tournament_id: str,
        player_id: str,
        tipo: Optional[str],
        tournament_day_id: Optional[str] = None,
    ) -> None:
        """Trava do DIA na venda avulsa (POST /transactions).

        Só o DIA. A trava da ETAPA fica com `create_transaction`, que já a roda
        para TODA venda (e não só as que entram por esta rota). Checar a etapa
        aqui também era a MESMA consulta duas vezes em cada venda registrada —
        e o gargalo desta aplicação é a cascata de chamadas, não o banco: numa
        noite de mil vendas, é mil idas ao banco a menos.

        Quem só tem o dia (inscrição, recompra, add-on) chama
        `assert_sales_allowed` direto — lá as duas travas valem.
        """
        if tipo not in TIPOS_DE_VENDA:
            return
        dia = tournament_day_id or SalesBlockService.dia_da_venda(tournament_id, player_id)
        SalesBlockService._exigir_dia_liberado(dia)

    @staticmethod
    def set_day_block(day_id: str, blocked: bool, reason: Optional[str], user_id: str) -> dict:
        """Liga/desliga o bloqueio de um dia. Explícito (não é toggle): com dois
        admins na tela, um toggle acabaria desbloqueando o que o outro bloqueou."""
        return SalesBlockService._set_block("tournament_days", day_id, blocked, reason, user_id)

    @staticmethod
    def set_stage_block(stage_id: str, blocked: bool, reason: Optional[str], user_id: str) -> dict:
        return SalesBlockService._set_block("stages", stage_id, blocked, reason, user_id)

    @staticmethod
    def _set_block(tabela: str, row_id: str, blocked: bool, reason: Optional[str], user_id: str) -> dict:
        from datetime import datetime, timezone

        payload = {
            "sales_blocked": bool(blocked),
            "sales_blocked_at": datetime.now(timezone.utc).isoformat() if blocked else None,
            "sales_blocked_by": user_id if blocked else None,
            "sales_blocked_reason": (reason or None) if blocked else None,
        }
        try:
            resp = supabase.table(tabela).update(payload).eq("id", row_id).execute()
        except Exception as exc:
            # Sem a migração aplicada a coluna não existe. Mensagem clara em vez
            # de 500 para o admin não achar que o sistema quebrou.
            raise ValueError(
                "Bloqueio de vendas indisponível: a migração do banco ainda não foi aplicada."
            ) from exc
        if not resp.data:
            raise ValueError("Registro não encontrado")
        return {
            "success": True,
            "sales_blocked": bool(blocked),
            "sales_blocked_reason": payload["sales_blocked_reason"],
        }
