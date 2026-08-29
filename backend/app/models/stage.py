from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime, date

# ErroDeNegocio herda de ValueError, entao quem ja capturava ValueError aqui
# continua capturando — o que muda e a recusa levar um CODIGO, para a tela
# escolher a frase no idioma do clube (ver app/utils/erros.py).
from app.utils.erros import ErroDeNegocio

# Mensagens das regras de data da etapa. Ficam aqui, num lugar só, porque o
# router e o service precisam devolver EXATAMENTE o mesmo texto ao operador.
MSG_FIM_ANTES_DO_INICIO = (
    "A data final da etapa não pode ser anterior à data de início"
)
MSG_INICIO_OBRIGATORIO = "Informe a data de início da etapa"


def validar_ordem_das_datas(inicio: Optional[date], fim: Optional[date]) -> None:
    """Uma etapa que termina antes de começar não existe na operação.

    O dono conseguiu cadastrar 10/08 → 02/08: isso bagunça o relatório por
    período (o intervalo fica vazio) e a lista de etapas ativas (nenhuma data
    contém "hoje"). Só compara quando as duas datas existem — o fim continua
    opcional, porque o circuito pode estar em aberto.
    """
    if inicio and fim and fim < inicio:
        raise ErroDeNegocio("etapa_fim_antes_do_inicio", MSG_FIM_ANTES_DO_INICIO)


def validar_datas_da_etapa(inicio: Optional[date], fim: Optional[date]) -> None:
    """As duas regras de data juntas, do jeito que valem para a etapa GRAVADA.

    Ficam aqui e são chamadas pelo StageService (criação e edição), NÃO por um
    model_validator do Pydantic. Motivo: um ValueError levantado dentro de um
    model_validator vira ValidationError e o FastAPI responde 422 com `detail`
    em LISTA, antes mesmo de entrar na função do endpoint — a tela recebia uma
    estrutura em vez da frase em português. Validando no service, as duas
    rotas (POST e PATCH) devolvem 400 com `detail` em texto simples.
    """
    if inicio is None:
        raise ErroDeNegocio("etapa_sem_data_de_inicio", MSG_INICIO_OBRIGATORIO)
    validar_ordem_das_datas(inicio, fim)


class StageBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=255, description="Stage name (e.g., 'Etapa Bogotá')")
    location: str = Field(..., min_length=1, max_length=255, description="Stage location/city")
    # OPCIONAL na LEITURA de propósito: existem etapas antigas na base sem
    # data nenhuma, e elas precisam continuar sendo lidas, listadas e
    # operadas. A obrigatoriedade vale para quem ESCREVE (StageCreate /
    # StageUpdate), não para quem lê.
    start_date: Optional[date] = Field(None, description="Stage start date")
    end_date: Optional[date] = Field(None, description="Stage end date")
    description: Optional[str] = Field(None, description="Stage description")
    status: str = Field(default='upcoming', description="Stage status: upcoming, active, completed, cancelled")


class StageCreate(StageBase):
    # Decisão do dono do produto: início OBRIGATÓRIO, fim OPCIONAL (circuito
    # em aberto). Sem início, a etapa não entra em nenhum recorte por período.
    # A cobrança é feita no StageService (validar_datas_da_etapa) e não aqui,
    # para o operador receber 400 com a frase em português em vez de 422 com
    # `detail` em lista, que a tela de Etapas não sabe ler.
    start_date: Optional[date] = Field(None, description="Stage start date (obrigatória)")


class StageUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    location: Optional[str] = Field(None, max_length=255)
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    description: Optional[str] = None
    status: Optional[str] = None
    # Sem model_validator de propósito: as regras de data dependem da linha
    # GRAVADA (um PATCH com só `end_date` precisa do início que está no banco),
    # então quem julga é o StageService.update_stage — e o erro sai como 400
    # com texto simples, igual ao da criação.


class Stage(StageBase):
    id: str
    created_at: datetime
    updated_at: Optional[datetime] = None

    # Chave-mestra de bloqueio de vendas: quando ligada, nenhum dia da etapa
    # vende. Declarada só aqui (e não em StageBase) para que a CRIAÇÃO da etapa
    # não tente gravar a coluna enquanto a migração não tiver rodado.
    sales_blocked: bool = False
    sales_blocked_reason: Optional[str] = None
    sales_blocked_at: Optional[datetime] = None
    sales_blocked_by: Optional[str] = None

    class Config:
        from_attributes = True


class StageSummary(BaseModel):
    """Stage summary with tournament count"""
    id: str
    name: str
    location: str
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    description: Optional[str] = None
    status: str
    tournament_count: int = 0
    created_at: datetime
    # Chega de graça: a RPC devolve a linha inteira da etapa e a consulta de
    # reserva usa select("*"). Sem a coluna (migração pendente) fica False, que
    # é o comportamento de hoje.
    sales_blocked: bool = False
    sales_blocked_reason: Optional[str] = None

    class Config:
        from_attributes = True


class StageDeleteImpact(BaseModel):
    """O que a exclusão da etapa DESTRÓI, com número em cima.

    As FKs para `stages` são ON DELETE CASCADE: apagar a etapa apaga junto
    sangrias, despesas, outras receitas, pagamentos de funcionário, caixas,
    tipos de buy e consignações de ficha. É a contabilidade inteira da etapa,
    e o texto de confirmação antigo não dizia nada disso. Este resumo existe
    para a tela conseguir mostrar "3 sangrias, 12 despesas, R$ 4.500 em caixa"
    antes de alguém clicar.
    """
    stage_id: str
    stage_name: str
    # Torneios NÃO são apagados (a FK é ON DELETE SET NULL): ficam órfãos de
    # etapa. Entra no resumo porque também é perda de rastro.
    tournaments: int = 0
    sangrias: int = 0
    sangrias_amount: float = 0
    expenses: int = 0
    expenses_amount: float = 0
    other_revenues: int = 0
    other_revenues_amount: float = 0
    staff_payments: int = 0
    staff_payments_amount: float = 0
    chip_consignments: int = 0
    cashboxes: int = 0
    buy_types: int = 0
    cash_balance: float = 0
    cash_total_received: float = 0
    # True = tem dinheiro no meio; a exclusão é recusada e o caminho passa a
    # ser arquivar (cancelar) a etapa, que preserva tudo.
    blocked: bool = False
