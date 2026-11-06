"""Resumo da noite de PERF_LOG (backend/scripts/resumo_perf_log.py).

O script lê o MESMO formato que o middleware escreve (FORMATO_DA_LINHA_PERF):
se um mudar sem o outro, a noite de medição sai sem resumo nenhum.
"""
import importlib.util
from pathlib import Path

from app.main import FORMATO_DA_LINHA_PERF

_caminho = Path(__file__).resolve().parents[1] / "scripts" / "resumo_perf_log.py"
_spec = importlib.util.spec_from_file_location("resumo_perf_log", _caminho)
resumo = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(resumo)

DIA = "0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0"
OUTRO_DIA = "11111111-2222-3333-4444-555555555555"


def _linha(hora, metodo, rota, ms, consultas, lento=""):
    # Como sai no `docker compose logs`: o prefixo do gunicorn vem antes.
    return "[2026-11-04 21:05:33 +0000] [8] [INFO] " + FORMATO_DA_LINHA_PERF % (
        hora, metodo, rota, ms, consultas, lento)


def test_le_o_formato_que_o_middleware_escreve():
    por_rota, lidas = resumo.ler([_linha("21:05:33", "POST", "/transactions", 412, 8, "  <-- LENTO")])
    assert lidas == 1
    assert por_rota[("POST", "/transactions")]["ms"] == [412]
    assert por_rota[("POST", "/transactions")]["consultas"] == [8]


def test_ids_e_codigos_viram_uma_rota_so():
    linhas = [
        _linha("21:00:00", "GET", f"/tournament-days/{DIA}/timer/status-enriched", 40, 2),
        _linha("21:00:03", "GET", f"/tournament-days/{OUTRO_DIA}/timer/status-enriched", 60, 2),
        _linha("21:00:05", "GET", "/public/tv/AB12CD/seating", 30, 4),
        _linha("21:00:06", "GET", f"/public/tv/days/{DIA}/extras", 90, 12),
    ]
    por_rota, _ = resumo.ler(linhas)
    assert set(por_rota) == {
        ("GET", "/tournament-days/{id}/timer/status-enriched"),
        ("GET", "/public/tv/{codigo}/seating"),
        ("GET", "/public/tv/days/{id}/extras"),
    }
    assert len(por_rota[("GET", "/tournament-days/{id}/timer/status-enriched")]["ms"]) == 2


def test_ordena_pelo_tempo_somado_e_nao_pelo_mais_lento():
    # 100 relógios de 80 ms (8 s) pesam mais que 2 relatórios de 2 s (4 s).
    linhas = [_linha("21:00:00", "GET", f"/tournament-days/{DIA}/timer/status-enriched", 80, 2)] * 100
    linhas += [_linha("21:00:00", "GET", "/reports/financial", 2000, 9)] * 2
    por_rota, _ = resumo.ler(linhas)
    ordem = [l["rota"] for l in resumo.resumir(por_rota)]
    assert ordem == ["/tournament-days/{id}/timer/status-enriched", "/reports/financial"]


def test_recorte_da_noite():
    linhas = [_linha("18:59:59", "GET", "/players", 50, 1), _linha("21:30:00", "GET", "/players", 50, 1)]
    _, lidas = resumo.ler(linhas, desde="19:00", ate="23:59")
    assert lidas == 1


def test_linhas_que_nao_sao_perf_sao_ignoradas():
    _, lidas = resumo.ler(['10.0.0.1 - - "GET /health HTTP/1.1" 200', "Booting worker with pid: 8"])
    assert lidas == 0
