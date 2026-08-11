"""Shared test fixtures: a small in-memory fake of the Supabase client.

It supports the subset of the query builder used by the services under test:
select / insert / update / delete, the eq/neq/in_/or_/order/gte/lte filters,
and execute(). Filters are applied to the table's row list so update/delete
mutate state and subsequent selects observe the change.
"""
from types import SimpleNamespace
import uuid


class FakeQuery:
    def __init__(self, store, table):
        self._store = store
        self._table = table
        self._rows = store.setdefault(table, [])
        self._op = "select"
        self._payload = None
        self._filters = []  # list of (col, value)
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

    def order(self, *a, **k):
        return self

    def gte(self, *a, **k):
        return self

    def lte(self, *a, **k):
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
            else:
                if row.get(col) != val:
                    return False
        return True

    def execute(self):
        if self._op == "select":
            rows = [r for r in self._rows if self._match(r)]
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
                self._rows.append(row)
                out.append(row)
            return SimpleNamespace(data=out)
        if self._op == "update":
            matched = [r for r in self._rows if self._match(r)]
            for r in matched:
                r.update(self._payload)
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
