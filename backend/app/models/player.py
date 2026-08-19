import re

from pydantic import BaseModel, Field, EmailStr, field_validator, model_validator
from typing import Optional
from datetime import datetime

from app.utils.documentos import TIPOS_ACEITOS


def _blank_to_none(v):
    # Data vem do form como string 'YYYY-MM-DD' (ou '' quando vazia). Mantemos
    # string (o Postgres aceita para coluna date) e tratamos vazio como null.
    if v in (None, ""):
        return None
    return v


# ── Nome e sobrenome ────────────────────────────────────────────────────────
# O cadastro passou a ter dois campos (first_name / last_name), mas `name`
# CONTINUA existindo e preenchido: 93 arquivos do sistema leem players.name
# (recibo de prêmio, alocação de mesa, ranking, tela de TV). As funções abaixo
# são o mesmo acordo do trigger do banco (db/migrations/
# database_migration_player_first_last_name.sql), repetido aqui porque o deploy
# não é atômico: o backend novo pode rodar antes da migração, e o frontend
# antigo continua mandando só `name` por um tempo.


def nome_limpo(valor: Optional[str]) -> str:
    """Espaços aparados e colapsados ('Adam  Louis' -> 'Adam Louis').

    Espaço duplicado faria a divisão devolver um sobrenome começando com
    espaço — e a busca por sobrenome no balcão nunca acharia o jogador.
    """
    return re.sub(r"\s+", " ", str(valor if valor is not None else "")).strip()


def primeiro_nome(valor: Optional[str]) -> Optional[str]:
    """Tudo até o PRIMEIRO espaço ('José Felipe Pinto' -> 'José')."""
    limpo = nome_limpo(valor)
    if not limpo:
        return None
    return limpo.split(" ", 1)[0]


def sobrenome(valor: Optional[str]) -> Optional[str]:
    """O resto depois do primeiro espaço; None para nome de uma palavra só."""
    limpo = nome_limpo(valor)
    partes = limpo.split(" ", 1)
    return partes[1] if len(partes) == 2 and partes[1] else None


def montar_nome(primeiro: Optional[str], ultimo: Optional[str]) -> str:
    return nome_limpo(f"{primeiro or ''} {ultimo or ''}")


def sincronizar_nome(dados: dict) -> dict:
    """Deixa name / first_name / last_name coerentes entre si.

    Quem manda o sobrenome manda no `name` (é o cadastro novo); quem só sabe
    `name` (importação, replay offline, frontend antigo, linha antiga do banco)
    tem o nome dividido. Devolve um dict novo — não mexe no que veio.
    """
    saida = dict(dados)
    primeiro = nome_limpo(saida.get("first_name")) or None
    ultimo = nome_limpo(saida.get("last_name")) or None

    if primeiro:
        saida["first_name"] = primeiro
        saida["last_name"] = ultimo
        saida["name"] = montar_nome(primeiro, ultimo)
    elif nome_limpo(saida.get("name")):
        saida["name"] = nome_limpo(saida.get("name"))
        saida["first_name"] = primeiro_nome(saida["name"])
        saida["last_name"] = sobrenome(saida["name"])
    return saida


class PlayerBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=255, description="Full name (kept in sync with first_name + last_name)")
    first_name: Optional[str] = Field(None, max_length=120, description="Nome")
    last_name: Optional[str] = Field(None, max_length=160, description="Sobrenome")
    email: EmailStr = Field(..., description="Email address (required, unique)")
    phone: str = Field(..., min_length=1, max_length=50, description="Phone number with country code (required)")
    nationality: str = Field(..., min_length=1, max_length=100, description="Nationality/Country (required)")
    # `str` e não Literal de propósito: os tipos aceitos vivem em
    # app/utils/documentos.py (cpf/dni/cedula/passport/driver_license + o legado
    # national_id) e quem valida é o service, que devolve 400 com a frase pronta
    # em vez do 422 genérico do Pydantic. Com Literal, uma linha antiga do banco
    # com tipo fora da lista derrubaria até o GET do jogador.
    document_type: str = Field(..., min_length=1, max_length=30, description=f"Um de: {', '.join(TIPOS_ACEITOS)}")
    document_number: str = Field(..., min_length=1, max_length=100, description="Document number (required)")
    nickname: Optional[str] = Field(None, max_length=100, description="Player nickname (optional)")
    birth_date: Optional[str] = Field(None, description="Birth date 'YYYY-MM-DD' (optional) — loyalty birthday bonus")
    notes: Optional[str] = Field(None, description="Additional notes (optional)")

    @model_validator(mode="before")
    @classmethod
    def _nome_base(cls, valores):
        # Antes da validação dos campos: quem mandou só first_name/last_name
        # ganha `name` (senão o obrigatório abaixo recusaria o cadastro novo),
        # e quem mandou só `name` ganha as partes divididas.
        return sincronizar_nome(valores) if isinstance(valores, dict) else valores

    @field_validator("birth_date", mode="before")
    @classmethod
    def _bd_base(cls, v):
        return _blank_to_none(v)


class PlayerCreate(PlayerBase):
    # Offline: id gerado no cliente (vira o PK; idempotência no replay).
    client_id: Optional[str] = Field(default=None, description="Client-generated player id (offline)")


class PlayerUpdate(BaseModel):
    # Sem o validador de nome do PlayerBase de propósito: aqui o payload é
    # parcial (PATCH só do sobrenome, por exemplo) e remontar `name` exige a
    # linha atual do banco — quem faz isso é o PlayerService.update_player.
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    first_name: Optional[str] = Field(None, max_length=120)
    last_name: Optional[str] = Field(None, max_length=160)
    email: Optional[EmailStr] = None
    phone: Optional[str] = Field(None, max_length=50)
    nationality: Optional[str] = Field(None, max_length=100)
    document_type: Optional[str] = Field(None, max_length=30)
    document_number: Optional[str] = Field(None, max_length=100)
    nickname: Optional[str] = Field(None, max_length=100)
    birth_date: Optional[str] = None
    notes: Optional[str] = None

    @field_validator("birth_date", mode="before")
    @classmethod
    def _bd_upd(cls, v):
        return _blank_to_none(v)


class Player(PlayerBase):
    id: str
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class PlayerStats(BaseModel):
    """Player statistics from the player_statistics view (org-scoped via RLS)."""
    id: str
    name: str
    nickname: Optional[str] = None
    tournaments_played: int = 0
    entries: int = 0            # participações (linhas em tournament_players)
    days_played: int = 0
    total_buy_ins: int = 0
    total_rebuys: int = 0
    total_addons: int = 0
    total_buy_in_amount: float = 0.0
    total_rebuy_amount: float = 0.0
    total_addon_amount: float = 0.0
    total_spent: float = 0.0
    total_prizes: float = 0.0
    net_profit: float = 0.0
    first_places: int = 0
    top_3_finishes: int = 0
    itm_count: int = 0          # in the money (nº de premiações)
    eliminated_count: int = 0
    best_position: Optional[int] = None
    avg_position: Optional[float] = None
    first_played: Optional[str] = None
    last_played: Optional[str] = None
    win_rate: float = 0.0       # 0..1 — % de 1º lugar
    itm_rate: float = 0.0       # 0..1 — % de vezes no dinheiro
    rebuy_rate: float = 0.0     # rebuys por participação
    roi: float = 0.0            # lucro / investido
    final_tables: int = 0       # mesas finais alcançadas (final_position 1..9)
    hours_played: float = 0.0   # horas jogadas (Σ eliminated_at − registered_at)

    class Config:
        from_attributes = True


class PlayerHistoryEntry(BaseModel):
    """Uma participação do jogador (linha do histórico)."""
    tournament_player_id: str
    tournament_id: Optional[str] = None
    tournament_name: Optional[str] = None
    tournament_day_id: Optional[str] = None
    day_name: Optional[str] = None
    registered_at: Optional[str] = None
    status: Optional[str] = None
    buy_in_count: int = 0
    rebuy_count: int = 0
    addon_count: int = 0
    total_spent: float = 0.0
    final_position: Optional[int] = None
    prize_won: float = 0.0

    class Config:
        from_attributes = True
