#!/bin/bash
# Script pra rodar o teste E2E do fluxo completo

echo "🏥 TESTE E2E - FLUXO DA SECRETÁRIA"
echo "==================================="
echo ""

# Verifica se tem npm
if ! command -v npm &> /dev/null; then
    echo "❌ npm não encontrado"
    exit 1
fi

# Entra na pasta do back
cd "$(dirname "$0")"

echo "📦 Instalando dependências (se necessário)..."
npm install --silent 2>/dev/null

echo ""
echo "🧪 Rodando teste E2E..."
echo ""

# Roda o teste
npx vitest run tests/e2e/v2/fluxo-completo-secretaria.e2e.test.js --reporter=verbose

echo ""
echo "==================================="
echo "✅ Teste finalizado!"
