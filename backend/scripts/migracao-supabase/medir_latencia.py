"""Quanto custa UMA ida ao banco de um projeto, medida de onde roda.

    python scripts/migracao-supabase/medir_latencia.py https://REF.supabase.co CHAVE

Faz 8 consultas pequenas seguidas (a 1ª inclui abrir a conexão). Na VPS em São
Paulo, contra o projeto em Oregon, deu 200–640 ms por consulta; contra um
projeto em São Paulo deve dar poucos milissegundos. É o número que decide se a
migração valeu.
"""
import sys
import time

import httpx


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 1
    url, chave = sys.argv[1].rstrip("/"), sys.argv[2]
    cabecalhos = {"apikey": chave}
    if chave.count(".") == 2:
        cabecalhos["Authorization"] = f"Bearer {chave}"
    tempos = []
    with httpx.Client(timeout=30) as cliente:
        for i in range(8):
            inicio = time.perf_counter()
            r = cliente.get(f"{url}/rest/v1/plans", params={"select": "code", "limit": 1},
                            headers=cabecalhos)
            ms = (time.perf_counter() - inicio) * 1000
            tempos.append(ms)
            print(f"consulta {i + 1}: {ms:6.0f} ms  (HTTP {r.status_code})")
    quentes = sorted(tempos[1:])
    print(f"\nmediana sem a 1ª: {quentes[len(quentes) // 2]:.0f} ms")
    return 0


if __name__ == "__main__":
    sys.exit(main())
