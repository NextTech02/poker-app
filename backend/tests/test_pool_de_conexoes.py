"""Pool de conexões com o Supabase.

Conexão fria custa TCP + TLS: ~215 ms medidos da VPS (1ª consulta ~280 ms, as
seguintes ~65 ms). Três coisas mantêm o pool quente, e é isso que se prende
aqui:

- UM pool por processo: as consultas com a chave de serviço e as feitas como
  o usuário usam as mesmas conexões (antes eram dois pools esfriando cada um
  por conta própria);
- conexão parada vive 90 s no pool (antes 30 s). Medido: o servidor mantém a
  conexão parada por 180 s e já a fechou aos 5 min — e reaproveitar conexão
  fechada dá ERRO, não reconexão;
- o aquecimento faz uma consulta mínima por conexão a cada 20 s — só em
  produção.
"""
import threading
import time

import httpx

from app import main
from app.database import supabase_client as sc


def test_chave_de_servico_e_usuario_usam_o_mesmo_pool():
    usuario = sc._build_user_postgrest("cabecalho.corpo.assinatura")
    assert sc._cliente_admin.postgrest.session._transport is sc._SHARED_TRANSPORT
    assert usuario.session._transport is sc._SHARED_TRANSPORT


def test_conexao_parada_fica_no_pool_por_90_segundos():
    # Abaixo dos 180 s que o servidor comprovadamente aguenta (ver o comentário
    # de _VIDA_DA_CONEXAO_PARADA).
    assert sc._VIDA_DA_CONEXAO_PARADA == 90.0
    assert sc._SHARED_TRANSPORT._pool._keepalive_expiry == 90.0


class _SessaoFalsa:
    """Registra as consultas do aquecimento e quantas correram AO MESMO TEMPO."""

    def __init__(self, erro=None):
        self.caminhos = []
        self.simultaneas = 0
        self._agora = 0
        self._trava = threading.Lock()
        self._erro = erro

    def get(self, caminho, params=None):
        with self._trava:
            self.caminhos.append((caminho, params))
            self._agora += 1
            self.simultaneas = max(self.simultaneas, self._agora)
        time.sleep(0.05)
        with self._trava:
            self._agora -= 1
        if self._erro:
            raise self._erro


def _com_sessao(monkeypatch, sessao):
    monkeypatch.setattr(sc._cliente_admin.postgrest, "session", sessao)


def test_aquecimento_usa_uma_consulta_minima_por_conexao_em_paralelo(monkeypatch):
    sessao = _SessaoFalsa()
    _com_sessao(monkeypatch, sessao)
    sc._aquecer_uma_vez()
    assert sessao.caminhos == [("/plans", {"select": "code", "limit": "1"})] * sc._CONEXOES_AQUECIDAS
    # Em sequência elas reaproveitariam uma conexão só.
    assert sessao.simultaneas == sc._CONEXOES_AQUECIDAS


def test_rede_fora_nao_derruba_o_aquecimento(monkeypatch):
    _com_sessao(monkeypatch, _SessaoFalsa(erro=httpx.ConnectError("sem rede")))
    sc._aquecer_uma_vez()  # não levanta: a próxima rodada tenta de novo


def test_startup_so_aquece_em_producao(monkeypatch):
    chamadas = []
    monkeypatch.setattr(main, "iniciar_aquecimento", lambda: chamadas.append(1))
    monkeypatch.setattr(main.settings, "environment", "development")
    main._aquecer_pool_de_conexoes()
    assert chamadas == []
    monkeypatch.setattr(main.settings, "environment", "production")
    main._aquecer_pool_de_conexoes()
    assert chamadas == [1]


def test_iniciar_duas_vezes_nao_abre_segunda_thread(monkeypatch):
    rodadas = []
    monkeypatch.setattr(sc, "_aquecer_uma_vez", lambda: rodadas.append(1))
    monkeypatch.setattr(sc, "_AQUECER_A_CADA", 3600)
    monkeypatch.setattr(sc, "_aquecimento", None)
    primeira = sc.iniciar_aquecimento()
    segunda = sc.iniciar_aquecimento()
    assert primeira is segunda and primeira.daemon
    time.sleep(0.1)
    assert rodadas == [1]  # uma rodada já no início, e só uma thread
