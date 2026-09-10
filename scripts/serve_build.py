"""Servidor estático do build do frontend, para testar sem o dev server.

POR QUE EXISTE: `react-scripts start` sobe um webpack-dev-server que passa de
400 MB nesta máquina — e já foi morto pelo sistema por falta de memória no meio
de um teste. Servir o `build/` custa ~15 MB e é o mesmo bundle que vai para
produção.

O QUE ELE PRECISA FAZER E UM `http.server` PURO NÃO FAZ: devolver o
`index.html` para qualquer rota que não seja um arquivo real. O React Router
resolve `/cash/mesas/<id>` no NAVEGADOR; sem esse fallback, recarregar a página
numa rota interna (ou abrir um link direto) daria 404.

Uso:  python scripts/serve_build.py [porta]
"""
import os
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

RAIZ = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "frontend", "build")


class SPAHandler(SimpleHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 (nome exigido pela BaseHTTPRequestHandler)
        caminho = self.translate_path(self.path)
        if not os.path.exists(caminho) or os.path.isdir(caminho):
            # Rota do React Router, não arquivo: quem resolve é o navegador.
            self.path = "/index.html"
        return super().do_GET()

    def end_headers(self):
        # Sem cache: testar um build novo não pode depender de Ctrl+F5.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

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
