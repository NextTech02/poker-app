from pydantic import BaseModel, Field
from typing import Optional, Literal


# ── Categorias ───────────────────────────────────────────────────────────────

class ExpenseCategoryCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    kind: Literal['fixo', 'variavel'] = 'variavel'
    active: bool = True
    sort_order: int = 0


class ExpenseCategoryUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=80)
    kind: Optional[Literal['fixo', 'variavel']] = None
    active: Optional[bool] = None
    sort_order: Optional[int] = None


# ── Despesas ─────────────────────────────────────────────────────────────────

class ExpenseCreate(BaseModel):
    stage_id: str = Field(..., description="Etapa a que a despesa pertence (âncora do DRE)")
    category_id: Optional[str] = None
    tournament_id: Optional[str] = None
    tournament_day_id: Optional[str] = None
    description: str = Field(..., min_length=1, max_length=200)
    supplier: Optional[str] = Field(None, max_length=120)
    amount: float = Field(..., gt=0)
    status: Literal['pendente', 'pago'] = 'pendente'
    due_date: Optional[str] = None
    paid_at: Optional[str] = None
    payment_method: Optional[str] = None
    # Fase 2: false = pago por fora (banco), não movimenta o caixa geral.
    paid_from_cash: bool = True
    notes: Optional[str] = None


class AttachmentCreate(BaseModel):
    """Metadados do comprovante. O arquivo em si sobe direto para o Storage
    pelo navegador; aqui só registramos o caminho para listar depois."""
    path: str = Field(..., min_length=1, max_length=500)
    file_name: str = Field(..., min_length=1, max_length=255)
    content_type: Optional[str] = Field(None, max_length=120)
    size_bytes: Optional[int] = Field(None, ge=0)


class ExpenseTemplateCreate(BaseModel):
    """Modelo de despesa recorrente: o operador aplica em cada etapa nova em vez
    de o sistema ratear sozinho — o valor de aluguel/dealers muda entre etapas."""
    name: str = Field(..., min_length=1, max_length=80)
    category_id: Optional[str] = None
    description: str = Field(..., min_length=1, max_length=200)
    supplier: Optional[str] = Field(None, max_length=120)
    amount: float = Field(..., ge=0)


class RevenueCreate(BaseModel):
    """Outras receitas da etapa: bar, patrocínio, aluguel de espaço…"""
    stage_id: str = Field(..., description="Etapa a que a receita pertence")
    tournament_id: Optional[str] = None
    source: str = Field('Outros', max_length=80)
    description: str = Field(..., min_length=1, max_length=200)
    amount: float = Field(..., gt=0)
    status: Literal['pendente', 'recebido'] = 'pendente'
    payment_method: Optional[str] = None
    # false = caiu direto no banco, não entra no caixa geral.
    to_cash: bool = True
    notes: Optional[str] = None


class RevenueUpdate(BaseModel):
    tournament_id: Optional[str] = None
    source: Optional[str] = Field(None, max_length=80)
    description: Optional[str] = Field(None, min_length=1, max_length=200)
    amount: Optional[float] = Field(None, gt=0)
    status: Optional[Literal['pendente', 'recebido']] = None
    payment_method: Optional[str] = None
    to_cash: Optional[bool] = None
    notes: Optional[str] = None


class ExpenseUpdate(BaseModel):
    category_id: Optional[str] = None
    tournament_id: Optional[str] = None
    tournament_day_id: Optional[str] = None
    description: Optional[str] = Field(None, min_length=1, max_length=200)
    supplier: Optional[str] = Field(None, max_length=120)
    amount: Optional[float] = Field(None, gt=0)
    status: Optional[Literal['pendente', 'pago']] = None
    due_date: Optional[str] = None
    paid_at: Optional[str] = None
    payment_method: Optional[str] = None
    paid_from_cash: Optional[bool] = None
    notes: Optional[str] = None
