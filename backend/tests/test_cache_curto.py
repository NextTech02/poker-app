"""Cache curto por processo (app/utils/cache_curto.py).

O que importa: serve o valor dentro da validade, relê depois dela, não guarda
falha e não cresce sem limite.
"""
import pytest

from app.utils import cache_curto
from app.utils.cache_curto import CacheCurto


@pytest.fixture
def relogio(monkeypatch):
    agora = {"t": 1000.0}
    monkeypatch.setattr(cache_curto.time, "monotonic", lambda: agora["t"])
    return agora


def test_dentro_da_validade_nao_recalcula(relogio):
    cache = CacheCurto(validade_s=30)
    calculos = []
    ler = lambda: calculos.append(1) or "v"
    cache.obter("k", ler)
    relogio["t"] += 29
    assert cache.obter("k", ler) == "v"
    assert len(calculos) == 1


def test_vencido_recalcula(relogio):
    cache = CacheCurto(validade_s=30)
    cache.obter("k", lambda: "velho")
    relogio["t"] += 31
    assert cache.obter("k", lambda: "novo") == "novo"


def test_falha_nao_e_guardada(relogio):
    cache = CacheCurto(validade_s=30)

    def estoura():
        raise RuntimeError("rede")

    with pytest.raises(RuntimeError):
        cache.obter("k", estoura)
    assert cache.obter("k", lambda: "ok") == "ok"


def test_esquecer_forca_a_releitura(relogio):
    cache = CacheCurto(validade_s=30)
    cache.obter("k", lambda: "velho")
    cache.esquecer("k")
    assert cache.obter("k", lambda: "novo") == "novo"


def test_nao_cresce_alem_do_maximo(relogio):
    cache = CacheCurto(validade_s=30, maximo=2)
    for chave in ("a", "b", "c"):
        cache.obter(chave, lambda c=chave: c)
    # "a" (o mais antigo) saiu; "b" e "c" ficam
    assert cache.obter("a", lambda: "relido") == "relido"
    assert cache.obter("c", lambda: "nao") == "c"
