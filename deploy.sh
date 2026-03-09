#!/usr/bin/env bash
# deploy.sh — Rebuild e reinicia os containers em produção
# Execute no VPS: bash deploy.sh

set -e

echo "==> Pulling latest code..."
git pull origin main

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
