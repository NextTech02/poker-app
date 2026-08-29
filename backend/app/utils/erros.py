"""Recusas da API com CÓDIGO, para a tela poder traduzir.

O sistema atende clubes no Brasil, no Peru e na Colômbia. Uma `HTTPException`
com a frase pronta em português chega em espanhol nenhum: o operador colombiano
lê "Caixa fechado" no meio da operação.

Por isso o `detail` vai estruturado:

    {"code": "caixa_fechado", "message": "Abra o seu caixa antes de vender."}

- `code`  — identificador estável, o que a tela usa para escolher a frase.
- `message` — a frase em português. É RESERVA, não enfeite: vale para qualquer
  outro cliente da API, para o log, e para quando a tela ainda não conhece um
  código recém-criado. Melhor uma frase em português do que "erro desconhecido".
- os extras viram variáveis de interpolação na tela (`{{nome}}`, `{{nivel}}`).

Do lado do navegador, `config/api.js` traduz por `errors.<code>` e cai no
`message` quando não tem a chave — então acrescentar uma recusa nova aqui nunca
quebra a tela, só a deixa em português até alguém traduzir.

REGRA AO CRIAR UM CÓDIGO: ele é contrato com a tela e com a fila offline
gravada nos aparelhos. Renomear um código já usado quebra a tradução de quem
não atualizou; prefira criar outro e deixar o antigo morrer sozinho.
"""
from typing import Any

from fastapi import HTTPException


class ErroDeNegocio(ValueError):
    """Recusa nascida na REGRA, não no HTTP.

    Os serviços não devem conhecer código de status — quem traduz regra em HTTP
    é o router. Mas eles precisavam de um jeito de dizer QUAL recusa é, e até
    agora só tinham `ValueError("frase em português")`: o router fazia
    `detail=str(e)` e a frase chegava à tela sem código, sem tradução possível.

    Herda de ValueError de propósito: todo `except ValueError` que já existe
    continua pegando esta, então a conversão pode ser feita aos poucos, um
    serviço por vez, sem quebrar o que ainda não foi convertido.
    """

    def __init__(self, code: str, message: str, status: int = 400, **dados: Any):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.dados = {k: v for k, v in dados.items() if v is not None}

    def como_http(self) -> HTTPException:
        return erro_http(self.status, self.code, self.message, **self.dados)


def da_excecao(exc: Exception, code_padrao: str = "regra_de_negocio", status: int = 400) -> HTTPException:
    """Converte o que o serviço levantou na recusa que a tela recebe.

    É o ponto único do router: `ErroDeNegocio` vira recusa com código, e o
    `ValueError` simples — os que ainda não foram convertidos — continua virando
    a frase de sempre, agora embrulhada num código genérico para a tela não ter
    dois formatos para tratar.
    """
    if isinstance(exc, ErroDeNegocio):
        return exc.como_http()
    return erro_http(status, code_padrao, str(exc))


def erro_http(status: int, code: str, message: str, **dados: Any) -> HTTPException:
    """Monta a recusa. Use `raise erro_http(...)`, como qualquer HTTPException."""
    detalhe = {"code": code, "message": message}
    # Só o que tem valor: `None` na interpolação da tela vira "undefined" na
    # frase, e a frase é o que o operador lê.
    detalhe.update({k: v for k, v in dados.items() if v is not None})
    return HTTPException(status_code=status, detail=detalhe)


def nao_encontrado(code: str, message: str, **dados: Any) -> HTTPException:
    """404 — o recurso não existe (ou não é desta organização, que para quem
    pergunta dá no mesmo: dizer "existe, mas não é seu" já entrega informação
    de outro clube)."""
    return erro_http(404, code, message, **dados)


def conflito(code: str, message: str, **dados: Any) -> HTTPException:
    """409 — o pedido é válido, mas briga com o que já está lá: cadastro
    repetido, caixa já aberto, consignação já reconciliada. Não é 400: não há
    nada de malformado no que o cliente mandou."""
    return erro_http(409, code, message, **dados)


def recusado(code: str, message: str, **dados: Any) -> HTTPException:
    """400 — o pedido não passa na regra do negócio (documento inválido, venda
    fora do nível permitido)."""
    return erro_http(400, code, message, **dados)


def sem_permissao(code: str, message: str, **dados: Any) -> HTTPException:
    """403 — a pessoa está autenticada, mas este recurso não é para o perfil
    dela."""
    return erro_http(403, code, message, **dados)
