#!/usr/bin/env bash
# Análise do AceBlind no SonarQube, com a cobertura das DUAS pontas.
#
# Existe porque um passo é fácil de esquecer e falha em silêncio: o coverage.py
# grava em <source> o caminho ABSOLUTO da máquina que rodou o pytest
# (C:\Users\...\backend\app). O scanner roda dentro de um container, onde esse
# caminho não existe — então o Sonar não casa nenhum arquivo Python, importa
# ZERO e mostra o backend com 0% de cobertura, sem nenhum erro. O projeto já
# apareceu com 61% por causa disso, quando a cobertura real era 88%.
# A linha do `sed` reescreve <source> para um caminho relativo à raiz do repo.
#
# NÃO edite o código enquanto isto roda. O sensor de JS/CSS lê o arquivo duas
# vezes (análise e gravação de métricas); se o número de linhas mudar no meio,
# o scanner morre com IndexOutOfBounds em DefaultFileLinesContext.checkLineRange
# e a análise inteira é perdida depois de ~15 min — sem nada aplicado no
# servidor, e com o painel continuando a mostrar os números da rodada anterior.
#
# Uso:  scripts/sonar-scan.sh [-Dsonar.foo=bar ...]
# Requer: Docker, e o SonarQube respondendo em SONAR_URL.
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SONAR_URL="${SONAR_URL:-http://host.docker.internal:9000}"
: "${SONAR_TOKEN:?defina SONAR_TOKEN (Minha Conta > Segurança no SonarQube)}"

echo "==> Cobertura do backend"
cd "$RAIZ/backend"
venv/Scripts/python.exe -m pytest --cov=app --cov-report=xml:coverage.xml -q

# <<< o passo que não pode faltar
sed -i 's|<source>.*</source>|<source>backend/app</source>|' coverage.xml
grep -q '<source>backend/app</source>' coverage.xml \
  || { echo "ERRO: não consegui reescrever <source> em backend/coverage.xml"; exit 1; }

echo "==> Cobertura do frontend"
cd "$RAIZ/frontend"
CI=true npx react-scripts test --watchAll=false --coverage \
  --coverageReporters=lcov --coverageReporters=text-summary

echo "==> Scanner"
cd "$RAIZ"
docker run --rm \
  --add-host=host.docker.internal:host-gateway \
  -e SONAR_HOST_URL="$SONAR_URL" \
  -e SONAR_TOKEN="$SONAR_TOKEN" \
  -v "$RAIZ:/usr/src" \
  sonarsource/sonar-scanner-cli "$@"

echo
echo "==> Quality gate"
curl -s -u "$SONAR_TOKEN:" \
  "${SONAR_URL/host.docker.internal/localhost}/api/qualitygates/project_status?projectKey=aceblind"
echo
