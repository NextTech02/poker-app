"""Premiação por eliminação: registrar, desfazer, pagar e encerrar os KOs.

As contas moram em `ko_regras` (funções puras); aqui fica o que toca o banco.

Livro (migração `database_migration_knockouts.sql`):
- `tournament_knockouts`        uma linha por eliminação que vale prêmio
                                (ou por encerramento), com o bounty CONGELADO;
- `tournament_knockout_payouts` o que cada eliminador recebe (dinheiro e o que
                                soma no bounty dele) e se já foi pago;
- `tournament_mystery_envelopes` os envelopes do Mystery e qual KO sorteou cada um.

O registro do KO e o PAGAMENTO são passos separados: o floor registra na mesa
(funciona sem rede, entra na fila), o caixa paga (precisa de rede, do caixa
aberto e de saldo no caixa geral). A tela abre o pagamento logo em seguida
quando está online — "na hora", como o clube pediu.

`organization_id` vai EXPLÍCITO nas linhas novas, copiado do torneio: o replay
do modo offline roda com a service_role, onde `current_org_id()` é nulo.
"""
import random
from datetime import datetime, timezone
from decimal import Decimal
from typing import Dict, Iterable, List, Optional, Tuple

from app.database import supabase
from app.services import ko_regras
from app.utils.erros import ErroDeNegocio

# Sorteio dos envelopes com a entropia do sistema operacional, como o sorteio de
# assento (allocation_service): quem observa envelopes suficientes não consegue
# prever o próximo.
_sorteio = random.SystemRandom()

_COLUNAS_DO_TORNEIO = (
    "id, name, organization_id, has_qualifying, elimination_mode, ko_format, "
    "ko_percentage, ko_cash_share, ko_closed_at, mystery_started_at, mystery_day_id, "
    "mystery_pool, mystery_players_at_start"
)
_VIVOS = ("registered", "active", "winner")
_TIPOS_DE_ENTRADA = ["buy_in", "rebuy", "addon"]


def _agora() -> str:
    return datetime.now(timezone.utc).isoformat()


def _quando(valor) -> datetime:
    """Data do banco (texto ISO) comparável; vazio vira o início dos tempos."""
    if not valor:
        return datetime.min.replace(tzinfo=timezone.utc)
    if isinstance(valor, datetime):
        return valor if valor.tzinfo else valor.replace(tzinfo=timezone.utc)
    texto = str(valor).replace("Z", "+00:00")
    try:
        data = datetime.fromisoformat(texto)
    except ValueError:
        return datetime.min.replace(tzinfo=timezone.utc)
    return data if data.tzinfo else data.replace(tzinfo=timezone.utc)


def _org(torneio: dict) -> dict:
    org = (torneio or {}).get("organization_id")
    return {"organization_id": org} if org else {}


class KnockoutService:
    # ── Leitura ─────────────────────────────────────────────────────────────
    @staticmethod
    def config(tournament_id: Optional[str]) -> dict:
        """Configuração KO do torneio. Sem a coluna (migração pendente) ou sem
        o torneio, é um torneio comum: `ko_format = none`."""
        if not tournament_id:
            return {"ko_format": ko_regras.NENHUM}
        try:
            linhas = (
                supabase.table("tournaments").select(_COLUNAS_DO_TORNEIO)
                .eq("id", str(tournament_id)).execute().data or []
            )
        except Exception:
            return {"id": tournament_id, "ko_format": ko_regras.NENHUM}
        return linhas[0] if linhas else {"id": tournament_id, "ko_format": ko_regras.NENHUM}

    @staticmethod
    def _livro(tournament_id: str) -> Tuple[List[dict], List[dict], List[dict]]:
        vendas = (
            supabase.table("transactions")
            .select("id, tournament_player_id, type, amount, bounty_amount, status, created_at")
            .eq("tournament_id", str(tournament_id))
            .in_("type", _TIPOS_DE_ENTRADA)
            .execute().data or []
        )
        knockouts = (
            supabase.table("tournament_knockouts").select("*")
            .eq("tournament_id", str(tournament_id)).execute().data or []
        )
        payouts = (
            supabase.table("tournament_knockout_payouts").select("*")
            .eq("tournament_id", str(tournament_id)).execute().data or []
        )
        return vendas, knockouts, payouts

    @staticmethod
    def bounties(tournament_id: str) -> Dict[str, Decimal]:
        vendas, knockouts, payouts = KnockoutService._livro(tournament_id)
        return ko_regras.bounties_derivados(vendas, knockouts, payouts)

    @staticmethod
    def _nomes(player_ids: Iterable[Optional[str]]) -> Dict[str, str]:
        ids = sorted({str(p) for p in player_ids if p})
        if not ids:
            return {}
        linhas = supabase.table("players").select("id, name").in_("id", ids).execute().data or []
        return {str(l["id"]): l.get("name") or "" for l in linhas}

    # ── Eliminadores ────────────────────────────────────────────────────────
    @staticmethod
    def validar_eliminadores(tp: dict, eliminadores: Iterable[str], replay: bool = False) -> Dict[str, dict]:
        """Inscrições de quem eliminou: do mesmo torneio, vivas, distintas e
        diferentes da vítima. No replay offline o eliminador pode já ter caído
        depois — a eliminação aconteceu de verdade na mesa, então vale."""
        ids = sorted({str(e) for e in eliminadores if e})
        if not ids:
            return {}
        if str(tp["id"]) in ids:
            raise ErroDeNegocio(
                "eliminador_e_a_vitima", "Quem foi eliminado não pode ser o próprio eliminador.",
            )
        linhas = (
            supabase.table("tournament_players")
            .select("id, player_id, status, tournament_id, tournament_day_id")
            .in_("id", ids).execute().data or []
        )
        por_id = {str(l["id"]): l for l in linhas}
        faltando = [i for i in ids if i not in por_id]
        if faltando:
            raise ErroDeNegocio(
                "eliminador_nao_encontrado", "Eliminador não encontrado neste torneio.", status=404,
            )
        for linha in por_id.values():
            if str(linha.get("tournament_id")) != str(tp.get("tournament_id")):
                raise ErroDeNegocio(
                    "eliminador_de_outro_torneio", "O eliminador precisa estar neste torneio.",
                )
            if not replay and linha.get("status") not in _VIVOS:
                raise ErroDeNegocio(
                    "eliminador_nao_esta_ativo",
                    "O eliminador escolhido não está jogando (já foi eliminado ou estornado).",
                    status=409,
                )
        return por_id

    # ── Registrar ───────────────────────────────────────────────────────────
    @staticmethod
    def exige_eliminador(torneio: dict) -> bool:
        """KO fixo e PKO sempre; Mystery só depois de iniciada a fase."""
        fmt = ko_regras.formato(torneio)
        if fmt in ("ko", "pko"):
            return True
        return fmt == "mystery" and ko_regras.fase_mystery_iniciada(torneio)

    @staticmethod
    def registrar(
        tp: dict,
        torneio: dict,
        eliminadores: Iterable[str],
        sem_eliminador: bool,
        client_mutation_id: Optional[str],
        user_id: Optional[str],
        replay: bool = False,
        validados: Optional[Dict[str, dict]] = None,
    ) -> Optional[dict]:
        """Grava o KO de uma eliminação. None quando a eliminação não vale prêmio
        (torneio comum, ou Mystery antes da fase)."""
        fmt = ko_regras.formato(torneio)
        if fmt == ko_regras.NENHUM:
            return None
        if fmt == "mystery" and not ko_regras.fase_mystery_iniciada(torneio):
            return None

        if client_mutation_id:
            existente = (
                supabase.table("tournament_knockouts").select("*")
                .eq("client_mutation_id", client_mutation_id).execute().data or []
            )
            if existente:
                return KnockoutService._detalhar_knockout(existente[0])

        if torneio.get("ko_closed_at") and not replay:
            raise ErroDeNegocio(
                "ko_encerrado",
                "Os bounties deste torneio já foram encerrados. Desfaça o encerramento para registrar eliminações.",
                status=409,
            )

        lista = [] if sem_eliminador else sorted({str(e) for e in eliminadores if e})
        if validados is None:
            validados = KnockoutService.validar_eliminadores(tp, lista, replay=replay)

        envelope = None
        if fmt == "mystery":
            share = Decimal("100")
            if lista:
                envelope = KnockoutService._reservar_envelope(torneio)
                valor = ko_regras.dinheiro(envelope["value"]) if envelope else Decimal("0.00")
            else:
                valor = Decimal("0.00")  # sem autor não sorteia: o envelope fica para o campeão
        else:
            share = ko_regras.parte_dinheiro(torneio)
            valor = max(KnockoutService.bounties(tp["tournament_id"]).get(str(tp["id"]), Decimal("0")), Decimal("0"))

        linha = {
            **_org(torneio),
            "tournament_id": tp["tournament_id"],
            "tournament_day_id": tp.get("tournament_day_id"),
            "eliminated_tp_id": tp["id"],
            "eliminated_player_id": tp.get("player_id"),
            "kind": "elimination",
            "format": fmt,
            "bounty_value": float(valor),
            "cash_share": float(share),
            # Explícitos (não só o DEFAULT do banco): a ordem dos KOs decide o
            # que pode ser desfeito, e o estado precisa existir em toda leitura.
            "status": "active",
            "created_at": _agora(),
        }
        if client_mutation_id:
            linha["client_mutation_id"] = client_mutation_id
        if user_id:
            linha["created_by"] = user_id

        try:
            knockout = supabase.table("tournament_knockouts").insert(linha).execute().data[0]
        except Exception:
            if envelope:
                KnockoutService._devolver_envelope(envelope["id"])
            raise
        try:
            if envelope:
                supabase.table("tournament_mystery_envelopes").update(
                    {"drawn_knockout_id": knockout["id"]}
                ).eq("id", envelope["id"]).execute()
            KnockoutService._gravar_payouts(knockout, torneio, valor, share, lista, validados)
        except Exception:
            supabase.table("tournament_knockouts").delete().eq("id", knockout["id"]).execute()
            if envelope:
                KnockoutService._devolver_envelope(envelope["id"])
            raise
        return KnockoutService._detalhar_knockout(knockout)

    @staticmethod
    def _gravar_payouts(knockout: dict, torneio: dict, valor: Decimal, share: Decimal,
                        eliminadores: List[str], validados: Dict[str, dict]) -> List[dict]:
        partes = ko_regras.dividir_bounty(valor, share, eliminadores)
        if not partes:
            return []
        linhas = [
            {
                **_org(torneio),
                "tournament_id": knockout["tournament_id"],
                "knockout_id": knockout["id"],
                "eliminator_tp_id": p["eliminator_tp_id"],
                "eliminator_player_id": (validados.get(p["eliminator_tp_id"]) or {}).get("player_id"),
                "cash_amount": float(p["cash_amount"]),
                "added_to_bounty": float(p["added_to_bounty"]),
                "paid": False,
                "created_at": _agora(),
            }
            for p in partes
        ]
        return supabase.table("tournament_knockout_payouts").insert(linhas).execute().data or []

    # ── Mystery: envelopes ──────────────────────────────────────────────────
    @staticmethod
    def _reservar_envelope(torneio: dict) -> Optional[dict]:
        """Sorteia um envelope ainda fechado e o RESERVA com update condicional
        (outra eliminação ao mesmo tempo não pega o mesmo). None = acabaram."""
        for _ in range(5):
            livres = (
                supabase.table("tournament_mystery_envelopes").select("*")
                .eq("tournament_id", str(torneio["id"]))
                .is_("drawn_at", "null").execute().data or []
            )
            if not livres:
                return None
            escolhido = _sorteio.choice(livres)
            reservado = (
                supabase.table("tournament_mystery_envelopes")
                .update({"drawn_at": _agora()})
                .eq("id", escolhido["id"]).is_("drawn_at", "null").execute().data or []
            )
            if reservado:
                return reservado[0]
        raise ErroDeNegocio(
            "envelope_em_disputa", "Outra eliminação sorteou ao mesmo tempo. Tente de novo.", status=409,
        )

    @staticmethod
    def _devolver_envelope(envelope_id: str) -> None:
        supabase.table("tournament_mystery_envelopes").update(
            {"drawn_at": None, "drawn_knockout_id": None}
        ).eq("id", envelope_id).execute()

    # ── Desfazer / corrigir ─────────────────────────────────────────────────
    @staticmethod
    def _recusar_se_pago(payouts: List[dict]) -> None:
        if any(p.get("paid") for p in payouts):
            raise ErroDeNegocio(
                "ko_ja_pago",
                "Este KO já foi pago no caixa. Não dá para desfazer a eliminação.",
                status=409,
            )

    @staticmethod
    def _recusar_cadeia(knockout: dict, payouts: List[dict]) -> None:
        """O bounty que um eliminador GANHOU somando já foi entregue a outro
        quando ele caiu depois: desfazer agora mudaria um valor já congelado."""
        com_soma = [str(p["eliminator_tp_id"]) for p in payouts
                    if p.get("eliminator_tp_id") and ko_regras.dinheiro(p.get("added_to_bounty")) > 0]
        if not com_soma:
            return
        depois = (
            supabase.table("tournament_knockouts").select("id, eliminated_tp_id, status, created_at")
            .in_("eliminated_tp_id", com_soma).execute().data or []
        )
        inicio = _quando(knockout.get("created_at"))
        if any((k.get("status") or "active") == "active" and str(k.get("id")) != str(knockout.get("id"))
               # Empate de relógio (duas eliminações na mesma mão) conta como
               # "depois": na dúvida, recusa — desfazer errado muda dinheiro.
               and _quando(k.get("created_at")) >= inicio for k in depois):
            raise ErroDeNegocio(
                "ko_desfazer_bloqueado_cadeia",
                "Quem eliminou este jogador também já foi eliminado depois. "
                "Desfaça primeiro a eliminação mais recente.",
                status=409,
            )

    @staticmethod
    def desfazer(tp: dict, user_id: Optional[str] = None) -> Optional[dict]:
        """Desfaz o KO da eliminação mais recente desta inscrição (se houver).
        Devolve o que foi desfeito, para `reativar` em caso de falha depois."""
        kos = (
            supabase.table("tournament_knockouts").select("*")
            .eq("eliminated_tp_id", str(tp["id"])).eq("status", "active")
            .eq("kind", "elimination").execute().data or []
        )
        if not kos:
            return None
        knockout = max(kos, key=lambda k: _quando(k.get("created_at")))
        payouts = (
            supabase.table("tournament_knockout_payouts").select("*")
            .eq("knockout_id", knockout["id"]).execute().data or []
        )
        KnockoutService._recusar_se_pago(payouts)
        KnockoutService._recusar_cadeia(knockout, payouts)

        envelopes = (
            supabase.table("tournament_mystery_envelopes").select("id")
            .eq("drawn_knockout_id", knockout["id"]).execute().data or []
        )
        for env in envelopes:
            KnockoutService._devolver_envelope(env["id"])
        supabase.table("tournament_knockouts").update({
            "status": "undone", "undone_at": _agora(), "undone_by": user_id,
        }).eq("id", knockout["id"]).eq("status", "active").execute()
        return {"knockout_id": knockout["id"], "envelope_ids": [e["id"] for e in envelopes]}

    @staticmethod
    def reativar(desfeito: Optional[dict]) -> None:
        """Volta um KO desfeito (a reversão da eliminação falhou depois)."""
        if not desfeito:
            return
        supabase.table("tournament_knockouts").update({
            "status": "active", "undone_at": None, "undone_by": None,
        }).eq("id", desfeito["knockout_id"]).execute()
        for env_id in desfeito.get("envelope_ids") or []:
            supabase.table("tournament_mystery_envelopes").update({
                "drawn_at": _agora(), "drawn_knockout_id": desfeito["knockout_id"],
            }).eq("id", env_id).is_("drawn_at", "null").execute()

    @staticmethod
    def corrigir_eliminadores(tournament_id: str, knockout_id: str, eliminadores: Iterable[str],
                              sem_eliminador: bool = False) -> dict:
        """Troca quem eliminou (floor escolheu errado) enquanto nada foi pago."""
        kos = (
            supabase.table("tournament_knockouts").select("*")
            .eq("id", knockout_id).eq("tournament_id", str(tournament_id)).execute().data or []
        )
        if not kos or kos[0].get("kind") != "elimination" or kos[0].get("status") != "active":
            raise ErroDeNegocio("ko_nao_encontrado", "KO não encontrado.", status=404)
        knockout = kos[0]
        payouts = (
            supabase.table("tournament_knockout_payouts").select("*")
            .eq("knockout_id", knockout_id).execute().data or []
        )
        KnockoutService._recusar_se_pago(payouts)
        KnockoutService._recusar_cadeia(knockout, payouts)

        lista = [] if sem_eliminador else sorted({str(e) for e in eliminadores if e})
        if not lista and not sem_eliminador:
            raise ErroDeNegocio("eliminador_obrigatorio", "Informe quem eliminou o jogador.")
        vitima = (
            supabase.table("tournament_players").select("*")
            .eq("id", knockout["eliminated_tp_id"]).execute().data or []
        )
        if not vitima:
            raise ErroDeNegocio("ko_nao_encontrado", "KO não encontrado.", status=404)
        validados = KnockoutService.validar_eliminadores(vitima[0], lista, replay=True)
        torneio = KnockoutService.config(tournament_id)
        if knockout.get("format") == "mystery" and lista and not payouts:
            raise ErroDeNegocio(
                "ko_mystery_sem_envelope",
                "Esta eliminação foi registrada sem eliminador e não sorteou envelope.",
                status=409,
            )
        supabase.table("tournament_knockout_payouts").delete().eq("knockout_id", knockout_id).execute()
        KnockoutService._gravar_payouts(
            knockout, torneio, ko_regras.dinheiro(knockout.get("bounty_value")),
            Decimal(str(knockout.get("cash_share") or 100)), lista, validados,
        )
        return KnockoutService._detalhar_knockout(knockout)

    # ── Pagar ───────────────────────────────────────────────────────────────
    @staticmethod
    def pagar(tournament_id: str, payout_id: str, user_id: Optional[str], paid_by: Optional[str] = None) -> dict:
        """Paga UM prêmio de KO do caixa geral.

        Ordem pensada para nunca pagar duas vezes nem perder dinheiro:
        1. reserva o pagamento (update condicional paid=false→true);
        2. desconta o caixa geral de forma ATÔMICA (só com saldo);
        3. grava a transação de prêmio (type 'prize', prize_kind 'knockout').
        Se 2 ou 3 falhar, desfaz o que já foi feito.
        """
        from app.services.cash_register_service import CashRegisterService
        from app.services.cashbox_service import CashboxService

        linhas = (
            supabase.table("tournament_knockout_payouts").select("*")
            .eq("id", payout_id).eq("tournament_id", str(tournament_id)).execute().data or []
        )
        if not linhas:
            raise ErroDeNegocio("ko_pagamento_nao_encontrado", "Pagamento de KO não encontrado.", status=404)
        payout = linhas[0]
        if payout.get("paid"):
            raise ErroDeNegocio("premio_ja_pago", "Este prêmio já foi pago.", status=409)
        kos = (
            supabase.table("tournament_knockouts").select("*")
            .eq("id", payout["knockout_id"]).execute().data or []
        )
        if not kos or (kos[0].get("status") or "active") != "active":
            raise ErroDeNegocio("ko_desfeito", "Este KO foi desfeito e não pode ser pago.", status=409)
        knockout = kos[0]

        if user_id:
            CashboxService.require_open_cashbox_for_tournament(user_id, str(tournament_id))

        valor = ko_regras.dinheiro(payout.get("cash_amount"))
        geral = None
        if valor > 0:
            geral = CashRegisterService.get_general_cash()
            if Decimal(str(geral.current_balance)) < valor:
                raise ErroDeNegocio(
                    "saldo_insuficiente_no_caixa_geral",
                    f"Saldo insuficiente no caixa geral. Disponível: {float(geral.current_balance):.2f}, "
                    f"Solicitado: {float(valor):.2f}",
                    disponivel=float(geral.current_balance),
                    solicitado=float(valor),
                )

        reservado = (
            supabase.table("tournament_knockout_payouts").update({
                "paid": True, "paid_at": _agora(), "paid_by": paid_by, "paid_by_user": user_id,
            }).eq("id", payout_id).eq("paid", False).execute().data or []
        )
        if not reservado:
            raise ErroDeNegocio("premio_ja_pago", "Este prêmio já foi pago.", status=409)

        debitou = False
        try:
            transacao_id = None
            if valor > 0:
                saldo = supabase.rpc(
                    "debit_general_cash_register",
                    {"p_register_id": str(geral.id), "p_amount": float(valor)},
                ).execute().data
                if saldo is None or saldo == []:
                    raise ErroDeNegocio(
                        "saldo_insuficiente_no_caixa_geral",
                        "Saldo insuficiente no caixa geral.",
                        disponivel=float(geral.current_balance),
                        solicitado=float(valor),
                    )
                debitou = True
                nomes = KnockoutService._nomes([payout.get("eliminator_player_id"), knockout.get("eliminated_player_id")])
                vitima = nomes.get(str(knockout.get("eliminated_player_id")), "")
                tx = supabase.table("transactions").insert({
                    "tournament_id": str(tournament_id),
                    "player_id": payout.get("eliminator_player_id"),
                    "type": "prize",
                    "prize_kind": "knockout",
                    "amount": float(valor),
                    "payment_source": "cash",
                    "payment_method": "cash",
                    "created_by": user_id,
                    "notes": f"KO ({knockout.get('format')}): {vitima}".strip(),
                }).execute().data or []
                transacao_id = tx[0]["id"] if tx else None
            if transacao_id:
                supabase.table("tournament_knockout_payouts").update(
                    {"transaction_id": transacao_id}
                ).eq("id", payout_id).execute()
        except Exception:
            if debitou:
                supabase.rpc(
                    "credit_general_cash_register",
                    {"p_register_id": str(geral.id), "p_amount": float(valor)},
                ).execute()
            supabase.table("tournament_knockout_payouts").update({
                "paid": False, "paid_at": None, "paid_by": None, "paid_by_user": None,
            }).eq("id", payout_id).execute()
            raise
        return KnockoutService._detalhar_knockout(knockout)

    @staticmethod
    def pagar_lote(tournament_id: str, payout_ids: Iterable[str], user_id: Optional[str],
                   paid_by: Optional[str] = None) -> List[dict]:
        """Paga vários de uma vez (fim de nível, fila no caixa). Para no
        primeiro recusado: os anteriores ficam pagos e a tela recarrega."""
        return [KnockoutService.pagar(tournament_id, pid, user_id, paid_by) for pid in payout_ids]

    # ── Encerrar ────────────────────────────────────────────────────────────
    @staticmethod
    def encerrar(tournament_id: str, champion_tp_id: str, user_id: Optional[str] = None) -> dict:
        """Fecha os bounties: cada jogador ainda vivo recebe o próprio bounty
        (num acordo de mesa final, todos os vivos); bounties que ficaram em
        eliminados (add-on vendido depois de cair) e os sem autor vão ao campeão.
        No Mystery, o campeão leva os envelopes restantes. Depois disto, o pago
        em KO soma exatamente o pozo KO."""
        torneio = KnockoutService.config(tournament_id)
        fmt = ko_regras.formato(torneio)
        if fmt == ko_regras.NENHUM:
            raise ErroDeNegocio("torneio_sem_ko", "Este torneio não tem premiação por eliminação.")
        if torneio.get("ko_closed_at"):
            raise ErroDeNegocio("ko_ja_encerrado", "Os bounties deste torneio já foram encerrados.", status=409)
        campeao = (
            supabase.table("tournament_players").select("*")
            .eq("id", champion_tp_id).eq("tournament_id", str(tournament_id)).execute().data or []
        )
        if not campeao or campeao[0].get("status") not in _VIVOS:
            raise ErroDeNegocio(
                "campeao_invalido", "Escolha como campeão um jogador que ainda está no torneio.",
            )
        campeao = campeao[0]

        def fechar(kind: str, vitima: Optional[dict], valor: Decimal, recebe: dict) -> None:
            if valor <= 0:
                return
            knockout = supabase.table("tournament_knockouts").insert({
                **_org(torneio),
                "tournament_id": str(tournament_id),
                "tournament_day_id": (vitima or recebe).get("tournament_day_id"),
                "eliminated_tp_id": (vitima or {}).get("id"),
                "eliminated_player_id": (vitima or {}).get("player_id"),
                "kind": kind,
                "format": fmt,
                "bounty_value": float(valor),
                "cash_share": 100,
                "status": "active",
                "created_at": _agora(),
                **({"created_by": user_id} if user_id else {}),
            }).execute().data[0]
            supabase.table("tournament_knockout_payouts").insert({
                **_org(torneio),
                "tournament_id": str(tournament_id),
                "knockout_id": knockout["id"],
                "eliminator_tp_id": recebe["id"],
                "eliminator_player_id": recebe.get("player_id"),
                "cash_amount": float(valor),
                "added_to_bounty": 0,
                "paid": False,
                "created_at": _agora(),
            }).execute()
            return knockout

        if fmt == "mystery":
            if not ko_regras.fase_mystery_iniciada(torneio):
                raise ErroDeNegocio(
                    "mystery_fase_nao_iniciada", "Inicie a fase Mystery antes de encerrar os bounties.",
                    status=409,
                )
            restantes = (
                supabase.table("tournament_mystery_envelopes").select("*")
                .eq("tournament_id", str(tournament_id)).is_("drawn_at", "null").execute().data or []
            )
            total = sum((ko_regras.dinheiro(e["value"]) for e in restantes), Decimal("0.00"))
            knockout = fechar("closing", campeao, total, campeao)
            for env in restantes:
                supabase.table("tournament_mystery_envelopes").update({
                    "drawn_at": _agora(), "drawn_knockout_id": (knockout or {}).get("id"),
                }).eq("id", env["id"]).is_("drawn_at", "null").execute()
        else:
            vendas, knockouts, payouts = KnockoutService._livro(tournament_id)
            saldos = ko_regras.bounties_derivados(vendas, knockouts, payouts)
            inscritos = (
                supabase.table("tournament_players").select("*")
                .eq("tournament_id", str(tournament_id)).execute().data or []
            )
            for tp in sorted(inscritos, key=lambda t: str(t["id"])):
                saldo = saldos.get(str(tp["id"]), Decimal("0"))
                if saldo <= 0:
                    continue
                recebe = tp if tp.get("status") in _VIVOS else campeao
                fechar("closing", tp, saldo, recebe)
            fechar("unclaimed", None, ko_regras.sem_autor(knockouts, payouts), campeao)

        supabase.table("tournaments").update({"ko_closed_at": _agora()}).eq("id", str(tournament_id)).execute()
        return KnockoutService.resumo(tournament_id)

    @staticmethod
    def desfazer_encerramento(tournament_id: str, user_id: Optional[str] = None) -> dict:
        kos = (
            supabase.table("tournament_knockouts").select("*")
            .eq("tournament_id", str(tournament_id)).eq("status", "active").execute().data or []
        )
        fechamento = [k for k in kos if k.get("kind") in ("closing", "unclaimed")]
        if fechamento:
            ids = [k["id"] for k in fechamento]
            payouts = (
                supabase.table("tournament_knockout_payouts").select("*")
                .in_("knockout_id", ids).execute().data or []
            )
            if any(p.get("paid") for p in payouts):
                raise ErroDeNegocio(
                    "ko_encerramento_com_pagamento",
                    "Já foi pago algum valor do encerramento; não dá para desfazê-lo.",
                    status=409,
                )
            for k in fechamento:
                supabase.table("tournament_mystery_envelopes").update(
                    {"drawn_at": None, "drawn_knockout_id": None}
                ).eq("drawn_knockout_id", k["id"]).execute()
                supabase.table("tournament_knockouts").update({
                    "status": "undone", "undone_at": _agora(), "undone_by": user_id,
                }).eq("id", k["id"]).execute()
        supabase.table("tournaments").update({"ko_closed_at": None}).eq("id", str(tournament_id)).execute()
        return KnockoutService.resumo(tournament_id)

    # ── Mystery: fase ───────────────────────────────────────────────────────
    @staticmethod
    def iniciar_mystery(tournament_id: str, envelopes: Iterable[dict], day_id: Optional[str] = None) -> dict:
        """Congela o pozo KO e cria os envelopes: até um por jogador vivo,
        somando exatamente o pozo. Depois disto, eliminar sorteia envelope."""
        torneio = KnockoutService.config(tournament_id)
        if ko_regras.formato(torneio) != "mystery":
            raise ErroDeNegocio("torneio_nao_e_mystery", "Este torneio não é Mystery Bounty.")
        if torneio.get("mystery_started_at"):
            raise ErroDeNegocio("mystery_ja_iniciado", "A fase Mystery já foi iniciada.", status=409)

        consulta = (
            supabase.table("tournament_players").select("id, status, tournament_day_id")
            .eq("tournament_id", str(tournament_id))
        )
        if day_id:
            consulta = consulta.eq("tournament_day_id", day_id)
        vivos = [t for t in (consulta.execute().data or []) if t.get("status") in _VIVOS]
        if not vivos:
            raise ErroDeNegocio("mystery_sem_jogadores", "Não há jogadores vivos para iniciar a fase.")

        vendas, knockouts, payouts = KnockoutService._livro(tournament_id)
        pozo = sum(
            (ko_regras.dinheiro(v.get("bounty_amount")) for v in vendas
             if (v.get("status") or "active") == "active"),
            Decimal("0.00"),
        )
        # Prêmios registrados à mão já saíram do pool: os envelopes somam o resto.
        valores = ko_regras.validar_envelopes(
            list(envelopes), len(vivos), pozo - KnockoutService._premios_manuais(knockouts, payouts),
        )

        marcado = (
            supabase.table("tournaments").update({
                "mystery_started_at": _agora(),
                "mystery_day_id": day_id or vivos[0].get("tournament_day_id"),
                "mystery_pool": float(pozo),
                "mystery_players_at_start": len(vivos),
            }).eq("id", str(tournament_id)).is_("mystery_started_at", "null").execute().data or []
        )
        if not marcado:
            raise ErroDeNegocio("mystery_ja_iniciado", "A fase Mystery já foi iniciada.", status=409)
        try:
            supabase.table("tournament_mystery_envelopes").insert([
                {**_org(torneio), "tournament_id": str(tournament_id), "value": float(v)} for v in valores
            ]).execute()
        except Exception:
            supabase.table("tournaments").update({
                "mystery_started_at": None, "mystery_day_id": None,
                "mystery_pool": None, "mystery_players_at_start": None,
            }).eq("id", str(tournament_id)).execute()
            raise
        return KnockoutService.resumo(tournament_id)

    # ── Prêmio manual (Mystery com os envelopes abertos fora do sistema) ────
    @staticmethod
    def _premios_manuais(knockouts: List[dict], payouts: List[dict]) -> Decimal:
        """Σ dos prêmios registrados à mão (KOs `manual` ativos)."""
        manuais = {
            str(k["id"]) for k in knockouts
            if k.get("kind") == "manual" and (k.get("status") or "active") == "active"
        }
        return sum(
            (ko_regras.dinheiro(p.get("cash_amount")) for p in payouts if str(p.get("knockout_id")) in manuais),
            Decimal("0.00"),
        )

    @staticmethod
    def registrar_manual(tournament_id: str, recebe_tp_id: str, valor, eliminado_tp_id: Optional[str] = None,
                         user_id: Optional[str] = None) -> dict:
        """Registra um prêmio Mystery que o clube já entregou na mesa (envelope
        aberto fora do sistema). Fica PENDENTE e é pago pelo caminho de sempre
        (caixa geral, transação de prêmio KO).

        Só no Mystery e só enquanto a fase não foi iniciada NO SISTEMA: depois
        dela, os prêmios saem dos envelopes sorteados — os dois juntos pagariam
        o pool duas vezes. O total registrado não passa do pool Mystery.
        """
        torneio = KnockoutService.config(tournament_id)
        if ko_regras.formato(torneio) != "mystery":
            raise ErroDeNegocio("premio_manual_so_mystery", "O prêmio manual é só para torneio Mystery.")
        if torneio.get("ko_closed_at"):
            raise ErroDeNegocio(
                "ko_encerrado",
                "Os bounties deste torneio já foram encerrados. Desfaça o encerramento para registrar eliminações.",
                status=409,
            )
        if ko_regras.fase_mystery_iniciada(torneio):
            raise ErroDeNegocio(
                "premio_manual_fase_iniciada",
                "A fase Mystery foi iniciada no sistema: os prêmios saem dos envelopes sorteados.",
                status=409,
            )
        valor = ko_regras.dinheiro(valor)
        if valor <= 0:
            raise ErroDeNegocio("premio_valor_invalido", "Informe um valor maior que zero.")

        inscritos = (
            supabase.table("tournament_players").select("id, player_id, tournament_day_id")
            .eq("tournament_id", str(tournament_id)).execute().data or []
        )
        por_id = {str(i["id"]): i for i in inscritos}
        recebe = por_id.get(str(recebe_tp_id))
        if not recebe:
            raise ErroDeNegocio("premio_jogador_invalido", "Escolha um jogador inscrito neste torneio.")
        eliminado = None
        if eliminado_tp_id:
            eliminado = por_id.get(str(eliminado_tp_id))
            if not eliminado:
                raise ErroDeNegocio("premio_jogador_invalido", "Escolha um jogador inscrito neste torneio.")
            if str(eliminado["id"]) == str(recebe["id"]):
                raise ErroDeNegocio("eliminador_e_a_vitima", "Quem foi eliminado não pode ser o próprio eliminador.")

        vendas, knockouts, payouts = KnockoutService._livro(tournament_id)
        pozo = sum(
            (ko_regras.dinheiro(v.get("bounty_amount")) for v in vendas
             if (v.get("status") or "active") == "active"),
            Decimal("0.00"),
        )
        ativos = {str(k["id"]) for k in knockouts if (k.get("status") or "active") == "active"}
        comprometido = sum(
            (ko_regras.dinheiro(p.get("cash_amount")) for p in payouts if str(p.get("knockout_id")) in ativos),
            Decimal("0.00"),
        )
        disponivel = pozo - comprometido
        if valor > disponivel:
            raise ErroDeNegocio(
                "premio_acima_do_pool",
                f"Sobram {disponivel} no pool Mystery e o prêmio é {valor}.",
                disponivel=float(disponivel), solicitado=float(valor),
            )

        linha = {
            **_org(torneio),
            "tournament_id": str(tournament_id),
            "tournament_day_id": (eliminado or recebe).get("tournament_day_id"),
            "eliminated_tp_id": eliminado["id"] if eliminado else None,
            "eliminated_player_id": eliminado.get("player_id") if eliminado else None,
            "kind": "manual",
            "format": "mystery",
            "bounty_value": float(valor),
            "cash_share": 100.0,
            "status": "active",
            "created_at": _agora(),
        }
        if user_id:
            linha["created_by"] = user_id
        knockout = supabase.table("tournament_knockouts").insert(linha).execute().data[0]
        try:
            KnockoutService._gravar_payouts(
                knockout, torneio, valor, Decimal("100"), [str(recebe["id"])], {str(recebe["id"]): recebe},
            )
        except Exception:
            supabase.table("tournament_knockouts").delete().eq("id", knockout["id"]).execute()
            raise
        return KnockoutService._detalhar_knockout(knockout)

    @staticmethod
    def desfazer_manual(tournament_id: str, knockout_id: str, user_id: Optional[str] = None) -> dict:
        """Desfaz um prêmio registrado à mão, enquanto ninguém pagou."""
        kos = (
            supabase.table("tournament_knockouts").select("*")
            .eq("id", str(knockout_id)).eq("tournament_id", str(tournament_id)).execute().data or []
        )
        if not kos or kos[0].get("kind") != "manual":
            raise ErroDeNegocio("ko_nao_encontrado", "KO não encontrado.", status=404)
        if (kos[0].get("status") or "active") != "active":
            raise ErroDeNegocio("ko_desfeito", "Este KO foi desfeito e não pode ser pago.", status=409)
        pagos = (
            supabase.table("tournament_knockout_payouts").select("id, paid")
            .eq("knockout_id", str(knockout_id)).execute().data or []
        )
        if any(p.get("paid") for p in pagos):
            raise ErroDeNegocio(
                "premio_manual_ja_pago", "Este prêmio já foi pago no caixa; não dá para desfazer.", status=409,
            )
        mudanca = {"status": "undone", "undone_at": _agora()}
        if user_id:
            mudanca["undone_by"] = user_id
        supabase.table("tournament_knockouts").update(mudanca).eq("id", str(knockout_id)).execute()
        return KnockoutService.resumo(tournament_id)

    @staticmethod
    def desfazer_mystery(tournament_id: str) -> dict:
        torneio = KnockoutService.config(tournament_id)
        if not torneio.get("mystery_started_at"):
            raise ErroDeNegocio("mystery_nao_iniciado", "A fase Mystery não foi iniciada.", status=409)
        envelopes = (
            supabase.table("tournament_mystery_envelopes").select("id, drawn_at")
            .eq("tournament_id", str(tournament_id)).execute().data or []
        )
        if any(e.get("drawn_at") for e in envelopes):
            raise ErroDeNegocio(
                "mystery_com_envelope_sorteado",
                "Já saiu envelope nesta fase; não dá para desfazer o início.",
                status=409,
            )
        supabase.table("tournament_mystery_envelopes").delete().eq("tournament_id", str(tournament_id)).execute()
        supabase.table("tournaments").update({
            "mystery_started_at": None, "mystery_day_id": None,
            "mystery_pool": None, "mystery_players_at_start": None,
        }).eq("id", str(tournament_id)).execute()
        return KnockoutService.resumo(tournament_id)

    # ── Guardas para outros serviços ────────────────────────────────────────
    @staticmethod
    def exigir_venda_sem_ko(tx: dict) -> None:
        """Estorno de venda num torneio KO.

        A parte KO desta venda pode já ter saído da cabeça do jogador (ele foi
        eliminado — ou encerrado — depois dela): estornar agora tiraria do pozo
        um dinheiro que já foi entregue a outro. Na fase Mystery o pozo está
        congelado em envelopes: nenhuma entrada sai mais dele."""
        if tx.get("type") not in _TIPOS_DE_ENTRADA:
            return
        torneio = KnockoutService.config(tx.get("tournament_id"))
        if not ko_regras.e_ko(torneio):
            return
        if ko_regras.fase_mystery_iniciada(torneio):
            raise ErroDeNegocio(
                "venda_na_fase_mystery",
                "A fase Mystery já começou: o pozo KO está nos envelopes e as entradas não podem mais ser canceladas.",
                status=409,
            )
        if ko_regras.dinheiro(tx.get("bounty_amount")) <= 0 or not tx.get("tournament_player_id"):
            return
        kos = (
            supabase.table("tournament_knockouts").select("id, status, created_at, kind")
            .eq("eliminated_tp_id", str(tx["tournament_player_id"])).execute().data or []
        )
        venda = _quando(tx.get("created_at"))
        if any((k.get("status") or "active") == "active" and _quando(k.get("created_at")) >= venda for k in kos):
            raise ErroDeNegocio(
                "venda_com_ko_registrado",
                "O bounty desta venda já foi entregue numa eliminação. Desfaça a eliminação antes de cancelar a venda.",
                status=409,
            )

    # ── Resumo (aba KO) ─────────────────────────────────────────────────────
    @staticmethod
    def _detalhar_knockout(knockout: dict, payouts: Optional[List[dict]] = None,
                           nomes: Optional[Dict[str, str]] = None) -> dict:
        if payouts is None:
            payouts = (
                supabase.table("tournament_knockout_payouts").select("*")
                .eq("knockout_id", knockout["id"]).execute().data or []
            )
        if nomes is None:
            nomes = KnockoutService._nomes(
                [knockout.get("eliminated_player_id")] + [p.get("eliminator_player_id") for p in payouts]
            )
        return {
            "id": str(knockout["id"]),
            "kind": knockout.get("kind") or "elimination",
            "format": knockout.get("format") or "",
            "status": knockout.get("status") or "active",
            "created_at": str(knockout.get("created_at")) if knockout.get("created_at") else None,
            "eliminated_tp_id": knockout.get("eliminated_tp_id"),
            "eliminated_player_id": knockout.get("eliminated_player_id"),
            "eliminated_name": nomes.get(str(knockout.get("eliminated_player_id"))),
            "bounty_value": ko_regras.dinheiro(knockout.get("bounty_value")),
            "cash_share": Decimal(str(knockout.get("cash_share") or 100)),
            "payouts": [
                {
                    "id": str(p["id"]),
                    "knockout_id": str(p["knockout_id"]),
                    "eliminator_tp_id": p.get("eliminator_tp_id"),
                    "eliminator_player_id": p.get("eliminator_player_id"),
                    "eliminator_name": nomes.get(str(p.get("eliminator_player_id"))),
                    "cash_amount": ko_regras.dinheiro(p.get("cash_amount")),
                    "added_to_bounty": ko_regras.dinheiro(p.get("added_to_bounty")),
                    "paid": bool(p.get("paid")),
                    "paid_at": str(p.get("paid_at")) if p.get("paid_at") else None,
                    "paid_by": p.get("paid_by"),
                }
                for p in payouts
            ],
        }

    @staticmethod
    def resumo(tournament_id: str) -> dict:
        torneio = KnockoutService.config(tournament_id)
        fmt = ko_regras.formato(torneio)
        vendas, knockouts, payouts = KnockoutService._livro(tournament_id)
        inscritos = (
            supabase.table("tournament_players").select("id, player_id, status")
            .eq("tournament_id", str(tournament_id)).execute().data or []
        )
        nomes = KnockoutService._nomes(
            [t.get("player_id") for t in inscritos]
            + [k.get("eliminated_player_id") for k in knockouts]
            + [p.get("eliminator_player_id") for p in payouts]
        )
        saldos = ko_regras.bounties_derivados(vendas, knockouts, payouts)
        ativos = {str(k["id"]) for k in knockouts if (k.get("status") or "active") == "active"}
        por_ko: Dict[str, List[dict]] = {}
        for p in payouts:
            por_ko.setdefault(str(p["knockout_id"]), []).append(p)

        pozo = sum(
            (ko_regras.dinheiro(v.get("bounty_amount")) for v in vendas
             if (v.get("status") or "active") == "active"),
            Decimal("0.00"),
        )
        if ko_regras.fase_mystery_iniciada(torneio) and torneio.get("mystery_pool") is not None:
            pozo = ko_regras.dinheiro(torneio.get("mystery_pool"))
        pago = sum((ko_regras.dinheiro(p.get("cash_amount")) for p in payouts
                    if p.get("paid") and str(p["knockout_id"]) in ativos), Decimal("0.00"))
        pendente = sum((ko_regras.dinheiro(p.get("cash_amount")) for p in payouts
                        if not p.get("paid") and str(p["knockout_id"]) in ativos), Decimal("0.00"))

        bounties = []
        if fmt in ("ko", "pko"):
            for tp in inscritos:
                if tp.get("status") not in _VIVOS:
                    continue
                bounties.append({
                    "tournament_player_id": str(tp["id"]),
                    "player_id": tp.get("player_id"),
                    "player_name": nomes.get(str(tp.get("player_id"))),
                    "status": tp.get("status"),
                    "bounty": max(saldos.get(str(tp["id"]), Decimal("0")), Decimal("0")),
                })
            bounties.sort(key=lambda b: (-b["bounty"], b["player_name"] or ""))

        lista = sorted(knockouts, key=lambda k: _quando(k.get("created_at")), reverse=True)
        saida = {
            "tournament_id": str(tournament_id),
            "ko_format": fmt,
            "ko_percentage": Decimal(str(torneio.get("ko_percentage") or 0)),
            "ko_cash_share": ko_regras.parte_dinheiro(torneio),
            "closed_at": str(torneio.get("ko_closed_at")) if torneio.get("ko_closed_at") else None,
            "ko_pool": pozo,
            "paid": pago,
            "pending": pendente,
            "unclaimed": ko_regras.sem_autor(knockouts, payouts),
            "manual_total": KnockoutService._premios_manuais(knockouts, payouts),
            "bounties": bounties,
            "knockouts": [
                KnockoutService._detalhar_knockout(k, por_ko.get(str(k["id"]), []), nomes) for k in lista
            ],
            "mystery": None,
        }
        if fmt == "mystery":
            envelopes = (
                supabase.table("tournament_mystery_envelopes").select("value, drawn_at")
                .eq("tournament_id", str(tournament_id)).execute().data or []
            )
            restantes: Dict[Decimal, int] = {}
            for e in envelopes:
                if not e.get("drawn_at"):
                    valor = ko_regras.dinheiro(e.get("value"))
                    restantes[valor] = restantes.get(valor, 0) + 1
            saida["mystery"] = {
                "started_at": str(torneio.get("mystery_started_at")) if torneio.get("mystery_started_at") else None,
                "day_id": torneio.get("mystery_day_id"),
                "pool": ko_regras.dinheiro(torneio.get("mystery_pool")) if torneio.get("mystery_pool") is not None else None,
                "players_at_start": torneio.get("mystery_players_at_start"),
                "envelopes_total": len(envelopes),
                "envelopes_remaining": sum(restantes.values()),
                "remaining": [
                    {"value": v, "count": c} for v, c in sorted(restantes.items(), key=lambda i: -i[0])
                ],
            }
        return saida
