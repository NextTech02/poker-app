"""Servidor estático do build do frontend, para testar sem o dev server.

POR QUE EXISTE: `react-scripts start` sobe um webpack-dev-server que passa de
400 MB nesta máquina — e já foi morto pelo sistema por falta de memória no meio
de um teste. Servir o `build/` custa ~15 MB e é o mesmo bundle que vai para
produção.

O QUE ELE PRECISA FAZER E UM `http.server` PURO NÃO FAZ:

1. Devolver o `index.html` para qualquer rota que não seja um arquivo real. O
   React Router resolve `/cash/mesas/<id>` no NAVEGADOR; sem esse fallback,
   recarregar a página numa rota interna (ou abrir um link direto) daria 404.
2. COMPRIMIR. O bundle principal tem ~1 MB de JavaScript e ~115 KB de CSS; sem
   gzip é isso que atravessa a conexão a cada carga.
3. Deixar o navegador CACHEAR os assets. Ver a nota sobre `no-store` abaixo.

Uso:  python scripts/serve_build.py [porta]
"""
import gzip
import os
import sys
from collections import OrderedDict
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

RAIZ = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "frontend", "build")

# Comprimir 1 MB de JS custa ~40 ms. Fazer isso a cada requisição, com uma SPA
# pedindo dezenas de assets, é o servidor gastando mais CPU do que o navegador.
# O cache é chaveado por (caminho, mtime, tamanho): salvar um build novo troca a
# chave sozinho, então nunca se serve o comprimido de um arquivo antigo.
_CACHE_MAX_BYTES = 64 * 1024 * 1024
_cache = OrderedDict()
_cache_bytes = 0

# Só comprime o que comprime bem. Imagem e fonte já vêm comprimidas: passá-las
# pelo gzip gasta CPU para devolver um arquivo do mesmo tamanho ou maior.
COMPRIMIVEIS = (
    "text/", "application/javascript", "application/json",
    "image/svg+xml", "application/manifest+json",
)
MINIMO_PARA_COMPRIMIR = 1024  # abaixo disso o cabeçalho custa mais que a economia


def _comprimido(caminho, assinatura):
    """Devolve o gzip do arquivo, do cache quando possível."""
    global _cache_bytes
    chave = (caminho, assinatura)
    achado = _cache.get(chave)
    if achado is not None:
        _cache.move_to_end(chave)  # LRU: o recém-usado vai para o fim
        return achado

    with open(caminho, "rb") as f:
        # mtime=0 para o resultado ser determinístico entre execuções.
        dados = gzip.compress(f.read(), compresslevel=6, mtime=0)

    _cache[chave] = dados
    _cache_bytes += len(dados)
    while _cache_bytes > _CACHE_MAX_BYTES and len(_cache) > 1:
        _, velho = _cache.popitem(last=False)
        _cache_bytes -= len(velho)
    return dados


class SPAHandler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"  # sem isto não há keep-alive: uma conexão TCP por asset

    def do_GET(self):  # noqa: N802 (nome exigido pela BaseHTTPRequestHandler)
        caminho = self.translate_path(self.path)
        if not os.path.exists(caminho) or os.path.isdir(caminho):
            # Rota do React Router, não arquivo: quem resolve é o navegador.
            self.path = "/index.html"
            caminho = self.translate_path(self.path)
        if not self._envia_comprimido(caminho):
            return super().do_GET()

    def do_HEAD(self):  # noqa: N802
        return super().do_HEAD()

    def _envia_comprimido(self, caminho):
        """True se atendeu aqui; False para deixar a classe-mãe servir cru."""
        if "gzip" not in self.headers.get("Accept-Encoding", ""):
            return False
        try:
            st = os.stat(caminho)
        except OSError:
            return False
        if not st.st_size >= MINIMO_PARA_COMPRIMIR:
            return False

        tipo = self.guess_type(caminho)
        if not any(tipo.startswith(p) for p in COMPRIMIVEIS):
            return False

        dados = _comprimido(caminho, (st.st_mtime_ns, st.st_size))
        self.send_response(200)
        self.send_header("Content-Type", tipo)
        self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(dados)))
        self.send_header("Vary", "Accept-Encoding")
        self._cabecalho_de_cache()
        self.end_headers()
        self.wfile.write(dados)
        return True

    def _cabecalho_de_cache(self):
        # Os assets do CRA têm o HASH DO CONTEÚDO no nome (main.fe899410.js).
        # Um build novo gera um nome novo, então cachear para sempre é seguro E
        # correto: o navegador nunca serve o arquivo velho, porque o
        # `index.html` — esse sim, `no-store` — passa a apontar para outro nome.
        #
        # O `no-store` em tudo, que estava aqui antes, obrigava a rebaixar e
        # REINTERPRETAR ~1,1 MB de JavaScript a cada recarga.
        if self.path.startswith("/static/"):
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        else:
            self.send_header("Cache-Control", "no-store")

    def end_headers(self):
        # Quando quem serve é a classe-mãe (arquivo pequeno ou já comprimido),
        # o cabeçalho de cache precisa entrar por aqui.
        if not self._ja_mandou_cache:
            self._cabecalho_de_cache()
        super().end_headers()

    def send_header(self, keyword, value):
        if keyword == "Cache-Control":
            self._ja_mandou_cache = True
        super().send_header(keyword, value)

    _ja_mandou_cache = False

    def send_response(self, *args, **kwargs):
        self._ja_mandou_cache = False
        super().send_response(*args, **kwargs)

    def log_message(self, formato, *args):
        # O log de cada asset polui o terminal sem ajudar em nada.
        if not self.path.startswith("/static/"):
            super().log_message(formato, *args)

    def handle_one_request(self):
        # O navegador cancela requisições o tempo todo (troca de rota, service
        # worker, prefetch). No Windows isso chega como WinError 10053 e o
        # BaseHTTPRequestHandler despeja um traceback inteiro no terminal — que
        # parece o servidor quebrando e não é.
        try:
            super().handle_one_request()
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            self.close_connection = True


def main():
    porta = int(sys.argv[1]) if len(sys.argv) > 1 else 3000
    raiz = os.path.normpath(RAIZ)
    if not os.path.isdir(raiz):
        raise SystemExit(f"build nao encontrado em {raiz} — rode `npm run build` no frontend")

    handler = partial(SPAHandler, directory=raiz)
    # THREADING, e não HTTPServer puro: o `HTTPServer` atende UMA requisição por
    # vez. Uma SPA pede dezenas de assets em paralelo, e basta um download que o
    # navegador abandona no meio para as outras ficarem na fila — a página
    # parece travada, como se o servidor tivesse caído.
    servidor = ThreadingHTTPServer(("127.0.0.1", porta), handler)
    servidor.daemon_threads = True
    print(f"Servindo {raiz} em http://localhost:{porta}")
    servidor.serve_forever()


if __name__ == "__main__":
    main()
