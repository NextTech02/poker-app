from typing import List, Optional

from fastapi import HTTPException

from app.database import supabase
from app.models.player import (
    PlayerCreate,
    PlayerUpdate,
    Player,
    PlayerStats,
    PlayerHistoryEntry,
    nome_limpo,
    sincronizar_nome,
)
from app.services.player_consent_service import PlayerConsentService
from app.utils.documentos import (
    erro_de_tipo_recusado,
    normalizar_documento,
    tipo_para_banco_antigo,
    validar_documento,
)

# Campos que exigem ler a linha atual antes de gravar um PATCH parcial.
CAMPOS_NOME = {"name", "first_name", "last_name"}
CAMPOS_DOCUMENTO = {"document_type", "document_number"}

# Colunas do cadastro novo. O deploy não é atômico: se o backend subir antes da
# migração, o PostgREST recusa o insert citando a coluna que não existe — e o
# clube não pode ficar sem cadastrar jogador por causa disso.
COLUNAS_NOVAS = ("first_name", "last_name")


def _erro_de_coluna_nova(exc: Exception) -> bool:
    """A falha é 'essa coluna ainda não existe' (migração não aplicada)?"""
    msg = str(exc).lower()
    return any(c in msg for c in COLUNAS_NOVAS) and (
        "column" in msg or "coluna" in msg or "schema cache" in msg or "pgrst204" in msg
    )


def _sem_colunas_novas(data: dict) -> dict:
    return {k: v for k, v in data.items() if k not in COLUNAS_NOVAS}


def _ajustar_ao_banco_sem_migracao(data: dict, exc: Exception) -> Optional[dict]:
    """O mesmo cadastro, no formato que um banco sem a migração aceita.

    Duas migrações podem estar faltando quando o código sobe primeiro: as
    colunas first_name/last_name e o CHECK com os tipos de documento por país.
    Nenhuma das duas pode derrubar o cadastro no balcão — nos dois casos o que
    se perde é detalhe (o sobrenome separado, o tipo do país), e isso volta
    sozinho na próxima edição depois da migração.

    Devolve None quando a falha não é uma dessas — aí o erro sobe.
    """
    if _erro_de_coluna_nova(exc):
        return _sem_colunas_novas(data)
    if erro_de_tipo_recusado(exc):
        legado = tipo_para_banco_antigo(data.get("document_type"))
        if legado:
            return {**data, "document_type": legado}
    return None


def _validar_documento_ou_400(tipo: Optional[str], numero: Optional[str]) -> str:
    """Documento é o comprovante de quem recebeu prêmio em dinheiro.

    O dono do clube cadastrou "um monte de 0" e o sistema aceitou. A tela avisa
    cedo, mas quem VALE é aqui: a mesma API atende a importação, o replay da
    fila offline e qualquer cliente fora do navegador. Cadastro antigo
    ('national_id') passa sem regra estrita — ver app/utils/documentos.py — para
    que corrigir o telefone de um jogador legado não trave no balcão.
    """
    resultado = validar_documento(tipo, numero)
    if not resultado.valido:
        raise HTTPException(status_code=400, detail=resultado.motivo)
    return resultado.normalizado


def _quem_ja_tem(campo: str, dados: dict) -> Optional[str]:
    """Nome do jogador que já ocupa aquele e-mail/documento, se der para saber.

    Dizer "já existe" sem dizer QUEM manda o operador procurar às cegas numa
    base de centenas. Com o nome, ele reconhece na hora — quase sempre é a
    mesma pessoa se cadastrando de novo porque a busca não a encontrou.

    Falhar aqui não pode atrapalhar: a mensagem sem o nome ainda serve, e este
    caminho só roda quando a gravação JÁ falhou.
    """
    try:
        q = supabase.table("players").select("name")
        if campo == "email":
            q = q.eq("email", (dados.get("email") or "").lower())
        else:
            q = q.eq("document_type", dados.get("document_type"))
            q = q.eq("document_number", dados.get("document_number"))
        achado = q.limit(1).execute().data or []
        return (achado[0].get("name") or "").strip() or None
    except Exception:
        return None


def _erro_de_gravacao(exc: Exception, dados: dict) -> Optional[HTTPException]:
    """Traduz a reclamação do banco para algo que o balcão resolva.

    O que chegava na tela era o texto cru do Postgres — "duplicate key value
    violates unique constraint players_email_org_key" — precedido de "Internal
    server error". Fora ilegível, dizia a coisa errada: não é erro interno,
    é cadastro repetido, e quem está no balcão consegue resolver em cinco
    segundos se souber disso.

    O `detail` vai ESTRUTURADO (code + message) porque o sistema atende clubes
    no Brasil, no Peru e na Colômbia: o frontend traduz pelo `code`, e o
    `message` em português serve de reserva para qualquer outro cliente da API.
    """
    texto = str(exc)

    if "players_email_org_key" in texto:
        nome = _quem_ja_tem("email", dados)
        return HTTPException(status_code=409, detail={
            "code": "email_duplicado",
            "name": nome,
            "message": (
                f"Este e-mail já está cadastrado para {nome}." if nome
                else "Este e-mail já está cadastrado para outro jogador."
            ),
        })

    if "players_document_org_key" in texto:
        nome = _quem_ja_tem("documento", dados)
        return HTTPException(status_code=409, detail={
            "code": "documento_duplicado",
            "name": nome,
            "message": (
                f"Este documento já está cadastrado para {nome}." if nome
                else "Este documento já está cadastrado para outro jogador."
            ),
        })

    # O limite do plano vinha pelo mesmo caminho, e com a mesma cara de erro
    # interno — sendo que a saída é trocar de plano, não tentar de novo.
    if "PLANO_LIMITE_CLIENTES" in texto:
        return HTTPException(status_code=409, detail={
            "code": "limite_de_jogadores",
            "message": (
                "O plano do clube atingiu o limite de jogadores cadastrados. "
                "Troque de plano para cadastrar mais."
            ),
        })

    return None


class PlayerService:
    @staticmethod
    def create_player(player_data: PlayerCreate) -> Player:
        """Create a new player"""
        data = player_data.model_dump()
        client_id = data.pop("client_id", None)
        data["document_number"] = _validar_documento_ou_400(
            data.get("document_type"), data.get("document_number")
        )
        # Offline: usa o id do cliente como PK; idempotente (pré-checa).
        if client_id:
            dup = supabase.table("players").select("*").eq("id", client_id).execute()
            if dup.data:
                return Player(**dup.data[0])
            data["id"] = client_id
        response = PlayerService._gravar(lambda d: supabase.table("players").insert(d), data)
        criado = response.data[0]
        # Pedido de autorização para contatos futuros (LGPD), por e-mail e em
        # segundo plano: o balcão não espera, e falha no envio não desfaz o
        # cadastro. Cobre também o replay da fila offline (sync_service).
        PlayerConsentService.solicitar_em_segundo_plano(criado)
        return Player(**criado)

    @staticmethod
    def _gravar(monta_query, data: dict):
        """Executa o insert/update tolerando o banco sem as migrações novas.

        O banco reclama de um problema por vez, então a tentativa é refeita
        enquanto houver ajuste conhecido a aplicar. Isso termina sempre: cada
        ajuste só muda alguma coisa na primeira vez (na segunda devolveria o
        mesmo payload, e aí o erro sobe).
        """
        tentativa = data
        while True:
            try:
                return monta_query(tentativa).execute()
            except HTTPException:
                raise
            except Exception as exc:
                ajustado = _ajustar_ao_banco_sem_migracao(tentativa, exc)
                if ajustado is None or ajustado == tentativa:
                    # Última parada antes de o erro do banco chegar à tela.
                    raise _erro_de_gravacao(exc, tentativa) or exc
                tentativa = ajustado

    @staticmethod
    def get_players(search: Optional[str] = None) -> List[Player]:
        """Get all players, optionally filtered by search term"""
        query = supabase.table("players").select("*")

        if search:
            # A busca continua sobre `name` porque `name` é, por construção
            # (trigger do banco + sincronizar_nome aqui), "first_name
            # last_name" — então um ilike só já acha por nome, por sobrenome ou
            # pelos dois juntos. Isto é a busca do balcão, com fila esperando:
            # trocar por um OR de três colunas quebraria enquanto a migração
            # não estivesse aplicada.
            # O termo é limpo antes: quem digita "beto  silva" (dois espaços)
            # não pode receber "nenhum jogador encontrado".
            termo = nome_limpo(search)
            query = query.or_(f"name.ilike.%{termo}%,nickname.ilike.%{termo}%")

        response = query.order("name").execute()
        return [Player(**item) for item in response.data]

    @staticmethod
    def get_player(player_id: str) -> Optional[Player]:
        """Get a player by ID"""
        response = supabase.table("players").select("*").eq("id", player_id).execute()

        if response.data:
            return Player(**response.data[0])
        return None

    @staticmethod
    def _reconciliar_nome(data: dict, atual: dict) -> None:
        """Remonta o nome do PATCH parcial com o que já está gravado."""
        if data.keys() & CAMPOS_NOME:
            # Partes do que já está gravado. Passa pelo sincronizar_nome
            # para cobrir a linha antiga (ou o banco ainda sem a migração),
            # onde só existe `name`.
            juntos = sincronizar_nome({c: atual.get(c) for c in CAMPOS_NOME})
            if not (data.keys() & {"first_name", "last_name"}):
                # Cliente antigo: mandou só o nome completo. Zerar as partes
                # faz o nome novo ser redividido — senão o nome antigo seria
                # remontado por cima do que a operação acabou de digitar.
                juntos["first_name"] = None
                juntos["last_name"] = None
            juntos.update({c: data[c] for c in CAMPOS_NOME if c in data})
            juntos = sincronizar_nome(juntos)

            # Nada de descarte calado: com first_name="" e last_name="Silva"
            # a remontagem cai no `name` que já estava gravado e devolve o
            # nome ANTIGO — o "Silva" sumiria sem erro nenhum. Pela tela não
            # acontece (o formulário exige o nome), mas acontece pelo replay
            # da fila offline, pela importação e por cliente HTTP. Se o que
            # veio no PATCH não sobreviveu, é 400.
            enviado = {c: nome_limpo(data[c]) or None for c in CAMPOS_NOME if c in data}
            if any(juntos.get(c) != v for c, v in enviado.items()):
                raise HTTPException(
                    status_code=400,
                    detail="Informe o nome do jogador — o sobrenome sozinho não basta.",
                )

            # `name` é NOT NULL e é o que 93 telas mostram: só reescreve
            # quando o resultado tem nome de verdade.
            if juntos.get("name"):
                data.update({c: juntos.get(c) for c in CAMPOS_NOME})

    @staticmethod
    def _reconciliar_documento(data: dict, atual: dict) -> None:
        """Valida o documento do PATCH parcial contra o que já está gravado."""
        if data.keys() & CAMPOS_DOCUMENTO:
            tipo = data.get("document_type", atual.get("document_type"))
            numero = data.get("document_number", atual.get("document_number"))
            normalizado = normalizar_documento(tipo, numero)
            # A régua vale para documento NOVO. Reenviar o que já está
            # gravado passa como está: a tela manda o formulário inteiro ao
            # salvar, e há cadastro antigo (e importado antes de a planilha
            # validar) com documento que não passa na régua de hoje — se
            # isso bloqueasse, ninguém mais conseguiria nem corrigir o
            # telefone desse jogador, com a fila esperando no balcão.
            igual_ao_gravado = tipo == atual.get("document_type") and normalizado == (
                normalizar_documento(
                    atual.get("document_type"), atual.get("document_number")
                )
            )
            if not igual_ao_gravado:
                normalizado = _validar_documento_ou_400(tipo, numero)
            # Só reescreve o número quando ele veio no PATCH — trocar o
            # telefone não é hora de mexer no documento de ninguém.
            if "document_number" in data:
                data["document_number"] = normalizado

    @staticmethod
    def update_player(player_id: str, player_data: PlayerUpdate) -> Optional[Player]:
        """Update a player"""
        data = player_data.model_dump(exclude_unset=True)

        # PATCH é parcial: mudar só o sobrenome, ou só o número do documento,
        # exige saber o que já está gravado para remontar o nome completo e
        # para validar o documento com o tipo certo.
        if data.keys() & (CAMPOS_NOME | CAMPOS_DOCUMENTO):
            atual_res = (
                supabase.table("players").select("*").eq("id", player_id).execute()
            )
            atual = (atual_res.data or [{}])[0]

            PlayerService._reconciliar_nome(data, atual)
            PlayerService._reconciliar_documento(data, atual)

        response = PlayerService._gravar(
            lambda d: supabase.table("players").update(d).eq("id", player_id), data
        )

        if response.data:
            return Player(**response.data[0])
        return None

    @staticmethod
    def delete_player(player_id: str) -> bool:
        """Delete a player"""
        response = supabase.table("players").delete().eq("id", player_id).execute()
        return len(response.data) > 0

    @staticmethod
    def get_player_statistics(player_id: Optional[str] = None) -> List[PlayerStats]:
        """Get player statistics from view"""
        query = supabase.table("player_statistics").select("*")

        if player_id:
            query = query.eq("id", player_id)

        response = query.execute()
        return [PlayerStats(**item) for item in response.data]

    @staticmethod
    def get_player_history(player_id: str) -> List[PlayerHistoryEntry]:
        """Histórico por participação (uma linha por entrada em tournament_players).

        Org-scoped: o backend roda as queries como o usuário (RLS), então só
        retorna torneios da própria organização. Prêmio por entrada vem de
        prize_allocations casado por (torneio + posição final) — a tabela não
        tem tournament_day_id, então o casamento é por posição.
        """
        tp_res = (
            supabase.table("tournament_players")
            .select(
                "id, tournament_id, tournament_day_id, registered_at, status, "
                "buy_in_count, rebuy_count, addon_count, total_spent, final_position, "
                "tournaments(name), "
                "tournament_days!tournament_players_tournament_day_id_fkey(day_name, day_number)"
            )
            .eq("player_id", player_id)
            .order("registered_at", desc=True)
            .execute()
        )
        rows = tp_res.data or []

        # Prêmios do jogador (cash), agrupados por (tournament_id, position).
        prize_res = (
            supabase.table("prize_allocations")
            .select("tournament_id, position, prize_amount, prize_type")
            .eq("player_id", player_id)
            .execute()
        )
        prize_map = {}
        for pa in (prize_res.data or []):
            if pa.get("prize_type") not in (None, "cash"):
                continue
            key = (pa.get("tournament_id"), pa.get("position"))
            prize_map[key] = prize_map.get(key, 0.0) + float(pa.get("prize_amount") or 0)

        history: List[PlayerHistoryEntry] = []
        for r in rows:
            tour = r.get("tournaments") or {}
            day = r.get("tournament_days") or {}
            day_name = day.get("day_name")
            if not day_name and day.get("day_number") is not None:
                day_name = f"Dia {day.get('day_number')}"
            final_pos = r.get("final_position")
            prize = prize_map.get((r.get("tournament_id"), final_pos), 0.0)
            history.append(PlayerHistoryEntry(
                tournament_player_id=r["id"],
                tournament_id=r.get("tournament_id"),
                tournament_name=tour.get("name"),
                tournament_day_id=r.get("tournament_day_id"),
                day_name=day_name,
                registered_at=r.get("registered_at"),
                status=r.get("status"),
                buy_in_count=r.get("buy_in_count") or 0,
                rebuy_count=r.get("rebuy_count") or 0,
                addon_count=r.get("addon_count") or 0,
                total_spent=float(r.get("total_spent") or 0),
                final_position=final_pos,
                prize_won=prize,
            ))
        return history
