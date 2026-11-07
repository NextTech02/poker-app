"""Relógio de mesa e time bank (ver docs/RELOGIO_DE_MESA_2026-11.md)."""
from pydantic import BaseModel, Field, field_validator


class ConfiguracaoDoRelogio(BaseModel):
    """O que o clube escolhe por dia. Os padrões são os do plano: 20 s no
    pré-flop, 30 s depois, cartão de 30 s, 2 iniciais, +1 por intervalo."""

    enabled: bool = False
    preflop_seconds: int = Field(20, ge=5, le=300)
    postflop_seconds: int = Field(30, ge=5, le=300)
    # "Pedir o relógio" no regulamento TDA: 25 s mais 5 de contagem.
    called_clock_seconds: int = Field(30, ge=5, le=300)
    # Número que a TV mostra, sem contar os intervalos.
    start_level: int = Field(1, ge=1, le=200)
    time_bank_enabled: bool = True
    card_seconds: int = Field(30, ge=5, le=300)
    initial_cards: int = Field(2, ge=0, le=50)
    cards_per_break: int = Field(1, ge=0, le=20)
    max_cards_per_decision: int = Field(6, ge=1, le=50)


class CartaoUsado(BaseModel):
    tournament_player_id: str
    # Gerado no tablet: é o que faz o reenvio não descontar de novo.
    client_event_id: str


class PedidoDeAjuste(BaseModel):
    cards: int = Field(..., ge=-50, le=50)
    reason: str = Field(..., max_length=200)

    @field_validator("cards")
    @classmethod
    def _ajuste_precisa_mudar_algo(cls, valor: int) -> int:
        if valor == 0:
            raise ValueError("O ajuste precisa somar ou tirar cartões.")
        return valor

    @field_validator("reason")
    @classmethod
    def _motivo_obrigatorio(cls, valor: str) -> str:
        valor = valor.strip()
        if not valor:
            raise ValueError("Informe o motivo do ajuste.")
        return valor
