#!/bin/bash
# Teste E2E simplificado - requer servidor rodando

echo "🏥 TESTE E2E - FLUXO DA SECRETÁRIA"
echo "==================================="
echo ""
echo "⚠️  REQUER SERVIDOR RODANDO em http://localhost:5000"
echo ""

# Verifica se servidor está rodando
if ! curl -s http://localhost:5000/api/health > /dev/null 2>&1; then
    echo "❌ Servidor não está rodando!"
    echo ""
    echo "Inicie o servidor primeiro:"
    echo "  npm run dev"
    echo ""
    exit 1
fi

echo "✅ Servidor detectado"
echo ""

# Roda o teste
cd "$(dirname "$0")"
npx vitest run tests/e2e/v2/worker-integration.v2.e2e.test.js tests/unit/eventDrivenArchitecture.test.js --reporter=verbose

echo ""
echo "==================================="
