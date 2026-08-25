#!/usr/bin/env bash
# deploy-landing.sh — sobe SÓ a landing page.
#
# Existe separado do scripts/deploy.sh porque o deploy completo faz
# `docker compose build --no-cache` em tudo: reconstrói o React (minutos) e
# reinicia o backend. Trocar uma palavra na landing não pode custar isso, nem
# derrubar quem está operando um torneio no meio da noite.
#
# O container do app e o do backend NÃO são tocados aqui.
#
# Uso, no VPS:  bash scripts/deploy-landing.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "==> Puxando o código..."
git pull origin main

echo "==> Reconstruindo a imagem da landing..."
docker compose build landing

echo "==> Subindo..."
docker compose up -d landing

echo "==> Conferindo que a página responde..."
# Pela porta publicada, do HOST — não com `docker compose exec` dentro do
# container. A versão anterior chamava `wget` lá dentro e dava ERRO com o nginx
# funcionando perfeitamente: o que ela testava era a existência do wget na
# imagem, não a página. Aqui o teste percorre o mesmo caminho do túnel.
PORTA="${PORTA_LANDING:-3003}"

conferir() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS -o /dev/null "http://127.0.0.1:${PORTA}/"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O /dev/null "http://127.0.0.1:${PORTA}/"
  else
    echo "    (sem curl nem wget no host — pulando a conferência)"
    return 0
  fi
}

for i in $(seq 1 15); do
  if conferir; then
    echo "    ok, a landing respondeu na porta ${PORTA}"
    break
  fi
  if [ "$i" = "15" ]; then
    echo "    ERRO: a landing não respondeu na porta ${PORTA}. Os logs:"
    docker compose logs --tail=30 landing
    exit 1
  fi
  sleep 1
done

echo
echo "✓ Landing atualizada."
echo "  Confira em https://aceblind.net (ou no host que o túnel aponta para ela)."
