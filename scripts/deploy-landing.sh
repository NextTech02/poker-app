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
# Espera o nginx aceitar conexão. Sem isto o script diria "pronto" enquanto o
# container ainda está subindo, e um erro de configuração passaria batido.
for i in $(seq 1 15); do
  if docker compose exec -T landing wget -q -O /dev/null http://localhost/ 2>/dev/null; then
    echo "    ok, a landing está servindo"
    break
  fi
  if [ "$i" = "15" ]; then
    echo "    ERRO: a landing não respondeu. Os logs:"
    docker compose logs --tail=30 landing
    exit 1
  fi
  sleep 1
done

echo
echo "✓ Landing atualizada."
echo "  Confira em https://aceblind.net (ou no host que o túnel aponta para ela)."
