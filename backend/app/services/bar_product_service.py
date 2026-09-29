"""Catálogo do bar (categorias e produtos) e o ledger de estoque.

O catálogo é da ORGANIZAÇÃO: a cerveja é a mesma todo turno. O que a comanda
faz com ele é COPIAR nome, preço e custo no item (snapshot) — mudar o preço
amanhã não reescreve a comanda de ontem.

ESTOQUE: `bar_products.stock_qty` é mantido EXCLUSIVAMENTE pelo trigger de
`bar_stock_movements`. Este serviço só grava movimentos MANUAIS (entrada,
ajuste, perda); venda e devolução por cancelamento nascem por trigger a partir
do item da comanda. Editar `stock_qty` direto desalinharia o ledger — o PATCH
recusa com `estoque_so_por_movimento`.

A venda NUNCA bloqueia por estoque: a cerveja já está na mão do cliente, o
errado é a contagem. Só a PERDA manual exige saldo (não dá para perder o que
não se tem).
"""
import unicodedata
from typing import List, Optional

from app.database import supabase
from app.models.bar import (
    BarCategoryCreate,
    BarCategoryResponse,
    BarCategoryUpdate,
    BarProductCreate,
    BarProductResponse,
    BarProductUpdate,
    BarStockMovementCreate,
    BarStockMovementResponse,
)
from app.utils.erros import ErroDeNegocio


def _normalizar(texto: Optional[str]) -> str:
    """Sem acento e sem caixa: 'Açaí' casa com 'acai'. A busca roda em Python
    porque a lista de produtos de um clube é pequena, e o `ilike` do PostgREST
    não ignora acento."""
    if not texto:
        return ""
    sem_acento = "".join(
        c for c in unicodedata.normalize("NFKD", str(texto))
        if not unicodedata.combining(c)
    )
    return sem_acento.casefold().strip()


def _eh_duplicidade(exc: Exception) -> bool:
    texto = str(exc).lower()
    return "duplicate key" in texto or "23505" in texto


class BarProductService:

    # ============================================================
    # Categorias
    # ============================================================

    @staticmethod
    def list_categories(
        organization_id: Optional[str] = None, active: Optional[bool] = None
    ) -> List[BarCategoryResponse]:
        query = supabase.table("bar_product_categories").select("*")
        if organization_id:
            query = query.eq("organization_id", organization_id)
        if active is not None:
            query = query.eq("active", active)
        linhas = query.order("sort_order").execute().data or []

        # Contagem de produtos numa consulta só (sem N+1).
        contagem: dict = {}
        if linhas:
            pq = supabase.table("bar_products").select("category_id")
            if organization_id:
                pq = pq.eq("organization_id", organization_id)
            for p in (pq.execute().data or []):
                cid = p.get("category_id")
                if cid:
                    contagem[cid] = contagem.get(cid, 0) + 1

        return [
            BarCategoryResponse(**c, products_count=contagem.get(c["id"], 0))
            for c in linhas
        ]

    @staticmethod
    def get_category(category_id: str) -> dict:
        resp = supabase.table("bar_product_categories").select("*") \
            .eq("id", category_id).execute()
        if not resp.data:
            raise ErroDeNegocio(
                "categoria_nao_encontrada", "Categoria não encontrada.", status=404
            )
        return resp.data[0]

    @staticmethod
    def create_category(
        data: BarCategoryCreate, organization_id: Optional[str] = None
    ) -> BarCategoryResponse:
        payload = data.model_dump()
        if organization_id:
            payload["organization_id"] = organization_id
        resp = supabase.table("bar_product_categories").insert(payload).execute()
        return BarCategoryResponse(**resp.data[0])

    @staticmethod
    def update_category(category_id: str, data: BarCategoryUpdate) -> BarCategoryResponse:
        atual = BarProductService.get_category(category_id)
        mudancas = data.model_dump(exclude_unset=True)
        if not mudancas:
            return BarCategoryResponse(**atual)
        resp = supabase.table("bar_product_categories").update(mudancas) \
            .eq("id", category_id).execute()
        return BarCategoryResponse(**resp.data[0])

    @staticmethod
    def delete_category(category_id: str) -> dict:
        """Categoria com produto não some: o produto ficaria sem grupo na POS.
        O clube move os produtos (ou os desativa) primeiro."""
        BarProductService.get_category(category_id)
        usos = supabase.table("bar_products").select("id") \
            .eq("category_id", category_id).execute().data or []
        if usos:
            raise ErroDeNegocio(
                "categoria_com_produtos",
                "A categoria tem produtos. Mova-os antes de removê-la.",
                status=409,
                quantidade=len(usos),
            )
        supabase.table("bar_product_categories").delete().eq("id", category_id).execute()
        return {"message": "Categoria removida"}

    # ============================================================
    # Produtos
    # ============================================================

    @staticmethod
    def list_products(
        organization_id: Optional[str] = None,
        active: Optional[bool] = None,
        category_id: Optional[str] = None,
        q: Optional[str] = None,
        low_stock: Optional[bool] = None,
    ) -> List[BarProductResponse]:
        query = supabase.table("bar_products").select("*")
        if organization_id:
            query = query.eq("organization_id", organization_id)
        if active is not None:
            query = query.eq("active", active)
        if category_id:
            query = query.eq("category_id", category_id)
        linhas = query.order("sort_order").order("name").execute().data or []

        termo = _normalizar(q)
        if termo:
            linhas = [
                p for p in linhas
                if termo in _normalizar(p.get("name")) or termo in _normalizar(p.get("sku"))
            ]
        if low_stock:
            linhas = [p for p in linhas if BarProductService._estoque_baixo(p)]

        return BarProductService._enriquecer(linhas, organization_id)

    @staticmethod
    def get_product(product_id: str) -> dict:
        resp = supabase.table("bar_products").select("*").eq("id", product_id).execute()
        if not resp.data:
            raise ErroDeNegocio(
                "produto_nao_encontrado", "Produto não encontrado.", status=404
            )
        return resp.data[0]

    @staticmethod
    def create_product(
        data: BarProductCreate, organization_id: Optional[str] = None
    ) -> BarProductResponse:
        payload = data.model_dump()
        payload["sku"] = (payload.get("sku") or "").strip() or None
        if organization_id:
            payload["organization_id"] = organization_id
        if payload.get("category_id"):
            BarProductService.get_category(payload["category_id"])
        try:
            resp = supabase.table("bar_products").insert(payload).execute()
        except Exception as exc:
            if _eh_duplicidade(exc):
                raise ErroDeNegocio(
                    "sku_duplicado", "Já existe um produto com este código.",
                    status=409, sku=payload.get("sku"),
                )
            raise
        return BarProductService._enriquecer(resp.data, organization_id)[0]

    @staticmethod
    def update_product(product_id: str, data: BarProductUpdate) -> BarProductResponse:
        atual = BarProductService.get_product(product_id)
        mudancas = data.model_dump(exclude_unset=True)
        if "stock_qty" in mudancas:
            # O ledger é a verdade. Editar a coluna à mão desalinha os dois e o
            # relatório de estoque passa a mentir sem ninguém saber quando.
            raise ErroDeNegocio(
                "estoque_so_por_movimento",
                "O estoque muda por entrada, ajuste ou perda — não por edição do produto.",
            )
        if not mudancas:
            return BarProductService._enriquecer([atual], atual.get("organization_id"))[0]
        if "sku" in mudancas:
            mudancas["sku"] = (mudancas.get("sku") or "").strip() or None
        if mudancas.get("category_id"):
            BarProductService.get_category(mudancas["category_id"])
        try:
            resp = supabase.table("bar_products").update(mudancas).eq("id", product_id).execute()
        except Exception as exc:
            if _eh_duplicidade(exc):
                raise ErroDeNegocio(
                    "sku_duplicado", "Já existe um produto com este código.",
                    status=409, sku=mudancas.get("sku"),
                )
            raise
        return BarProductService._enriquecer(resp.data, atual.get("organization_id"))[0]

    @staticmethod
    def delete_product(product_id: str) -> dict:
        """Produto já vendido é DESATIVADO, não apagado: o item da comanda
        guarda o nome (snapshot), mas o relatório por produto agrupa pela FK e
        perderia a linha."""
        BarProductService.get_product(product_id)
        vendas = supabase.table("bar_tab_items").select("id") \
            .eq("product_id", product_id).limit(1).execute().data or []
        if vendas:
            supabase.table("bar_products").update({"active": False}).eq("id", product_id).execute()
            return {"message": "Produto desativado", "deactivated": True}
        try:
            supabase.table("bar_products").delete().eq("id", product_id).execute()
        except Exception as exc:
            # Movimento de estoque manual segura a linha (FK RESTRICT). Mesma
            # saída: desativar.
            if "23503" in str(exc) or "foreign key" in str(exc).lower():
                supabase.table("bar_products").update({"active": False}).eq("id", product_id).execute()
                return {"message": "Produto desativado", "deactivated": True}
            raise
        return {"message": "Produto removido", "deactivated": False}

    # ============================================================
    # Estoque
    # ============================================================

    @staticmethod
    def add_stock_movement(
        product_id: str,
        data: BarStockMovementCreate,
        auth_user_id: Optional[str] = None,
        organization_id: Optional[str] = None,
    ) -> dict:
        produto = BarProductService.get_product(product_id)
        if not produto.get("track_stock"):
            raise ErroDeNegocio(
                "produto_sem_controle_de_estoque",
                "Este produto não controla estoque. Ative o controle no cadastro.",
            )
        if data.client_mutation_id:
            repetido = supabase.table("bar_stock_movements").select("*") \
                .eq("client_mutation_id", data.client_mutation_id).limit(1).execute().data or []
            if repetido:
                atualizado = BarProductService.get_product(product_id)
                return {
                    "movement": BarStockMovementResponse(**repetido[0]),
                    "product": BarProductService._enriquecer([atualizado], organization_id)[0],
                    "duplicate": True,
                }

        quantidade = int(data.quantity)
        if quantidade == 0:
            raise ErroDeNegocio("quantidade_invalida", "Informe uma quantidade diferente de zero.")
        if data.kind == "in":
            quantidade = abs(quantidade)
        elif data.kind == "loss":
            quantidade = -abs(quantidade)
            disponivel = int(produto.get("stock_qty") or 0)
            if abs(quantidade) > disponivel:
                raise ErroDeNegocio(
                    "estoque_insuficiente",
                    "Não há estoque suficiente para registrar essa perda.",
                    disponivel=disponivel, solicitado=abs(quantidade),
                )
        # 'adjustment' vai como veio (± é o que o ajuste significa).

        # Custo só tem sentido na entrada: é ela que alimenta a média.
        unit_cost = data.unit_cost if data.kind == "in" else None
        total_cost = data.total_cost if data.kind == "in" else None
        if unit_cost is None and total_cost is not None:
            unit_cost = round(total_cost / quantidade, 4)

        payload = {
            "product_id": product_id,
            "kind": data.kind,
            "quantity": quantidade,
            "unit_cost": unit_cost,
            "notes": data.notes,
            "client_mutation_id": data.client_mutation_id,
            "created_by": auth_user_id,
            "organization_id": organization_id or produto.get("organization_id"),
        }
        # Só manda a coluna quando há valor: um banco ainda sem a migração do
        # custo médio recusaria a coluna desconhecida mesmo com nulo.
        if total_cost is not None:
            payload["total_cost"] = total_cost
        try:
            resp = supabase.table("bar_stock_movements").insert(payload).execute()
        except Exception as exc:
            if _eh_duplicidade(exc) and data.client_mutation_id:
                repetido = supabase.table("bar_stock_movements").select("*") \
                    .eq("client_mutation_id", data.client_mutation_id).limit(1).execute().data or []
                if repetido:
                    resp_data = repetido
                else:
                    raise
            else:
                raise
        else:
            resp_data = resp.data

        # O custo do produto NÃO é gravado aqui: o trigger
        # bar_stock_weighted_cost recalcula a média ponderada dentro do INSERT,
        # com o produto travado (database_migration_bar_custo_medio.sql).
        # Sobrescrever com o custo da entrada recusteava o estoque antigo.

        atualizado = BarProductService.get_product(product_id)
        return {
            "movement": BarStockMovementResponse(**resp_data[0]),
            "product": BarProductService._enriquecer([atualizado], organization_id)[0],
            "duplicate": False,
        }

    @staticmethod
    def list_movements(product_id: str, limit: int = 100) -> List[BarStockMovementResponse]:
        BarProductService.get_product(product_id)
        resp = supabase.table("bar_stock_movements").select("*") \
            .eq("product_id", product_id).order("created_at", desc=True).limit(limit).execute()
        return [BarStockMovementResponse(**m) for m in (resp.data or [])]

    @staticmethod
    def low_stock(organization_id: Optional[str] = None) -> List[BarProductResponse]:
        return BarProductService.list_products(
            organization_id=organization_id, active=True, low_stock=True
        )

    # ============================================================
    # Auxiliares
    # ============================================================

    @staticmethod
    def _estoque_baixo(produto: dict) -> bool:
        return bool(produto.get("track_stock")) and \
            int(produto.get("stock_qty") or 0) <= int(produto.get("min_stock") or 0)

    @staticmethod
    def _enriquecer(linhas: List[dict], organization_id: Optional[str]) -> List[BarProductResponse]:
        if not linhas:
            return []
        ids = list({p["category_id"] for p in linhas if p.get("category_id")})
        nomes: dict = {}
        if ids:
            cats = supabase.table("bar_product_categories").select("id, name") \
                .in_("id", ids).execute().data or []
            nomes = {c["id"]: c.get("name") for c in cats}
        return [
            BarProductResponse(
                **p,
                category_name=nomes.get(p.get("category_id")),
                low_stock=BarProductService._estoque_baixo(p),
            )
            for p in linhas
        ]
