"""Shared test fixtures: a small in-memory fake of the Supabase client.

It supports the subset of the query builder used by the services under test:
select / insert / update / delete, the eq/neq/in_/or_/order/gte/lte filters,
and execute(). Filters are applied to the table's row list so update/delete
mutate state and subsequent selects observe the change.
"""
from types import SimpleNamespace
import uuid

import pytest


def _chave_de_ordem(valor):
    """Chave de ordenacao tolerante a tipos misturados.

    Uma coluna pode vir com None em algumas linhas (day_number ainda nao
    preenchido, por exemplo); comparar None com int estoura em Python. Nulos
    vao para o inicio, como no Postgres com ASC NULLS FIRST.
    """
    if valor is None:
        return (0, "")
    if isinstance(valor, bool):
        return (1, float(valor))
    if isinstance(valor, (int, float)):
        return (1, float(valor))
    return (2, str(valor))


class FakeQuery:
    def __init__(self, store, table):
        self._store = store
        self._table = table
        self._rows = store.setdefault(table, [])
        self._op = "select"
        self._payload = None
        self._filters = []  # list of (col, value)
        self._orders = []   # list of (col, desc)
        self._limit = None
        self._single = False

    # ── builders ──
    def select(self, *a, **k):
        self._op = "select"
        return self

    def insert(self, payload):
        self._op = "insert"
        self._payload = payload
        return self

    def update(self, payload):
        self._op = "update"
        self._payload = payload
        return self

    def upsert(self, payload, *a, **k):
        self._op = "upsert"
        self._payload = payload
        return self

    def delete(self):
        self._op = "delete"
        return self

    # ── filters (all just record an equality match where relevant) ──
    def eq(self, col, val):
        self._filters.append((col, val))
        return self

    def neq(self, col, val):
        self._filters.append((("neq", col), val))
        return self

    def in_(self, col, vals):
        self._filters.append((("in", col), list(vals)))
        return self

    def or_(self, *a, **k):
        return self

    def order(self, col=None, *a, desc=False, **k):
        """Ordena de verdade (nao e no-op).

        Varios servicos dependem da ordem para estar CORRETOS, nao so
        bonitos: o consumo de credito e FIFO (mais antigo primeiro) e a
        alocacao sequencial pega a mesa de menor numero. Com um order que
        nao ordena, esses testes passariam sem exercitar a regra."""
        if col:
            self._orders.append((col, bool(desc)))
        return self

    def gte(self, col, val):
        self._filters.append((("gte", col), val))
        return self

    def lte(self, col, val):
        self._filters.append((("lte", col), val))
        return self

    def gt(self, col, val):
        self._filters.append((("gt", col), val))
        return self

    def lt(self, col, val):
        self._filters.append((("lt", col), val))
        return self

    def limit(self, n, *a, **k):
        self._limit = n
        return self

    def range(self, *a, **k):
        return self

    def is_(self, col, val):
        # No PostgREST, is_(col, "null") filtra por ausencia de valor.
        self._filters.append((("is", col), None if val in ("null", None) else val))
        return self

    def not_(self, *a, **k):
        return self

    def ilike(self, *a, **k):
        return self

    def like(self, *a, **k):
        return self

    def single(self, *a, **k):
        self._single = True
        return self

    def maybe_single(self, *a, **k):
        self._single = True
        return self

    # ── matching ──
    def _match(self, row):
        for col, val in self._filters:
            if isinstance(col, tuple):
                kind, real = col
                if kind == "neq" and row.get(real) == val:
                    return False
                if kind == "in" and row.get(real) not in val:
                    return False
                if kind == "is" and row.get(real) != val:
                    return False
                if kind == "gt" and not (float(row.get(real) or 0) > float(val)):
                    return False
                if kind == "lt" and not (float(row.get(real) or 0) < float(val)):
                    return False
                # gte/lte servem para recorte de PERIODO, entao comparam como
                # texto (datas ISO ordenam lexicograficamente) quando o valor
                # nao e numerico.
                if kind in ("gte", "lte"):
                    atual = row.get(real)
                    if atual is None:
                        return False
                    try:
                        a, b = float(atual), float(val)
                    except (TypeError, ValueError):
                        a, b = str(atual), str(val)
                    if kind == "gte" and not a >= b:
                        return False
                    if kind == "lte" and not a <= b:
                        return False
            else:
                if row.get(col) != val:
                    return False
        return True

    def execute(self):
        table = self._table
        if self._op == "select":
            rows = [r for r in self._rows if self._match(r)]
            # A ordem e aplicada da ULTIMA chave para a PRIMEIRA, para que a
            # primeira chamada a order() seja a mais significativa (como no
            # PostgREST).
            for col, desc in reversed(self._orders):
                rows.sort(key=lambda r: _chave_de_ordem(r.get(col)), reverse=desc)
            if self._limit is not None:
                rows = rows[: self._limit]
            if self._single:
                return SimpleNamespace(data=(rows[0] if rows else None))
            return SimpleNamespace(data=rows, count=len(rows))
        if self._op == "insert":
            items = self._payload if isinstance(self._payload, list) else [self._payload]
            out = []
            for it in items:
                row = dict(it)
                row.setdefault("id", str(uuid.uuid4()))
                row.setdefault("created_at", "2026-06-08T00:00:00Z")
                row.setdefault("updated_at", "2026-06-08T00:00:00Z")
                # DEFAULTs que o banco real aplica e os modelos exigem.
                if table == "seat_allocations":
                    row.setdefault("players", {"name": "Jogador"})
                    row.setdefault("tournament_tables", {"table_number": 1})
                    row.setdefault("tournaments", {"name": "Torneio"})
                if table == "tournament_players":
                    row.setdefault("registered_at", "2026-06-08T00:00:00Z")
                    row.setdefault("status", "active")
                    row.setdefault("total_spent", 0)
                    row.setdefault("rebuy_count", 0)
                    row.setdefault("addon_count", 0)
                    row.setdefault("total_buy_in_amount", 0)
                    row.setdefault("total_rebuy_amount", 0)
                    row.setdefault("total_addon_amount", 0)
                self._rows.append(row)
                out.append(row)
            return SimpleNamespace(data=out)
        if self._op == "update":
            matched = [r for r in self._rows if self._match(r)]
            # O codigo envia expressoes SQL como "now()", que o Postgres avalia.
            # Guardar a string literal quebraria a validacao de data no modelo.
            payload = {
                k: ("2026-06-08T00:00:00Z" if v == "now()" else v)
                for k, v in (self._payload or {}).items()
            }
            for r in matched:
                r.update(payload)
            return SimpleNamespace(data=matched)
        if self._op == "upsert":
            items = self._payload if isinstance(self._payload, list) else [self._payload]
            out = []
            for it in items:
                existente = next((r for r in self._rows if r.get("id") == it.get("id")), None)
                if existente:
                    existente.update(it)
                    out.append(existente)
                else:
                    row = dict(it)
                    row.setdefault("id", str(uuid.uuid4()))
                    self._rows.append(row)
                    out.append(row)
            return SimpleNamespace(data=out)
        if self._op == "delete":
            matched = [r for r in self._rows if self._match(r)]
            self._rows[:] = [r for r in self._rows if r not in matched]
            return SimpleNamespace(data=matched)
        return SimpleNamespace(data=[])


class FakeSupabase:
    def __init__(self, tables=None):
        # deep-ish copy so tests don't share mutable rows
        self.store = {k: [dict(r) for r in v] for k, v in (tables or {}).items()}
        self.rpcs = {}        # nome do rpc -> valor ou callable
        self.rpc_calls = []   # registro das chamadas, para assercoes

    def table(self, name):
        return FakeQuery(self.store, name)

    from_ = table

    def rpc(self, fn, params=None):
        """RPC: o teste registra o retorno em `fake.rpcs[nome]` (valor ou callable).

        RPC nao registrado ESTOURA, de proposito. Varios servicos chamam um RPC
        dentro de try/except e caem num calculo em Python quando ele nao existe;
        se o fake devolvesse None em silencio, esse fallback nunca seria
        exercitado e o teste passaria medindo o caminho errado.
        """
        self.rpc_calls.append((fn, params or {}))
        if fn not in self.rpcs:
            raise RuntimeError(f"RPC nao registrado no teste: {fn}")
        alvo = self.rpcs[fn]
        valor = alvo(params or {}) if callable(alvo) else alvo
        return SimpleNamespace(execute=lambda: SimpleNamespace(data=valor))


# ---------------------------------------------------------------------------
# Camada HTTP
# ---------------------------------------------------------------------------

USUARIO_TESTE = {
    "sub": "88888888-8888-8888-8888-888888888888",
    "email": "admin@clube.com",
    "organization_id": "33333333-3333-3333-3333-333333333333",
    "role": "authenticated",
    "platform_admin": False,
}


@pytest.fixture
def client(monkeypatch):
    """TestClient com a autenticação neutralizada.

    Os routers são casca fina: validam entrada, chamam o service e traduzem
    erro em status HTTP. É essa tradução que se testa aqui — a regra de
    negócio já tem teste próprio no nível do service. Por isso o JWT e o
    RBAC saem do caminho: sem isso todo request pararia em 401 antes de
    chegar na linha que interessa.
    """
    from fastapi.testclient import TestClient

    from app.main import app
    from app.auth.jwt import get_current_user, verify_token
    from app.models.staff import MyPermissions
    from app.services.staff_service import StaffService

    # is_admin=True faz require_permission/forbid_permission liberarem tudo.
    monkeypatch.setattr(
        StaffService, "get_my_permissions",
        staticmethod(lambda uid: MyPermissions(is_admin=True, permissions=[])),
    )

    usuario = dict(USUARIO_TESTE)
    app.dependency_overrides[get_current_user] = lambda: usuario
    app.dependency_overrides[verify_token] = lambda: usuario
    try:
        with TestClient(app) as c:
            # `client.usuario` e o mesmo dict que a dependencia devolve: o
            # teste muda um claim (platform_admin, organization_id) e o
            # proximo request ja enxerga.
            c.usuario = usuario
            yield c
    finally:
        app.dependency_overrides.clear()


@pytest.fixture
def stub():
    """Troca métodos de service por funções fixas durante um teste.

    `stub(TournamentService, get_tournament=lambda tid: {...})` — devolve o
    próprio monkeypatch por baixo, então a restauração é automática.
    """
    from _pytest.monkeypatch import MonkeyPatch

    mp = MonkeyPatch()

    def _aplicar(alvo, **metodos):
        for nome, fn in metodos.items():
            mp.setattr(alvo, nome, staticmethod(fn) if callable(fn) else fn)
        return alvo

    yield _aplicar
    mp.undo()
