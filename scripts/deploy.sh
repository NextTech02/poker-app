#!/usr/bin/env bash
# deploy.sh — Rebuild e reinicia os containers em produção
# Execute no VPS: bash scripts/deploy.sh

set -e

# Os .env NÃO são versionados (ficam só na VPS). Um `git pull` normal não toca em
# arquivos não rastreados, mas por segurança fazemos backup antes e restauramos
# caso algo os remova — assim as credenciais nunca se perdem no deploy.
ENV_FILES=(.env backend/.env frontend/.env)

echo "==> Backup dos .env locais..."
for f in "${ENV_FILES[@]}"; do
  if [ -f "$f" ]; then
    cp -f "$f" "$f.deploybak"
    echo "    backup: $f"
  fi
done

echo "==> Pulling latest code..."
git pull origin main

echo "==> Garantindo que os .env continuam presentes..."
for f in "${ENV_FILES[@]}"; do
  if [ ! -f "$f" ] && [ -f "$f.deploybak" ]; then
    cp -f "$f.deploybak" "$f"
    echo "    restaurado: $f"
  fi
done

echo "==> Building images..."
docker compose build --no-cache

echo "==> Restarting containers..."
docker compose up -d

echo "==> Status:"
docker compose ps

echo ""
echo "✓ Deploy concluído!"
echo "  Frontend : http://localhost:3000"
echo "  Backend  : http://localhost:8000"
echo "  API docs : http://localhost:8000/docs"
