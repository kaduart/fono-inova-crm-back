#!/bin/bash
# 🚀 Script para rodar E2E de Appointment + Payment V2

set -e

echo "🧪 E2E V2 - Appointment + Payment Async"
echo "═══════════════════════════════════════════════════"

# Verifica se servidor está rodando
echo "📡 Verificando servidor..."
if ! curl -s http://localhost:5000/api/health > /dev/null 2>&1; then
    echo "❌ Servidor não está rodando em localhost:5000"
    echo "   Inicie o servidor antes de rodar os testes"
    exit 1
fi
echo "✅ Servidor online"

# Verifica variáveis
echo ""
echo "🔧 Configuração:"
echo "   TEST_URL: ${TEST_URL:-http://localhost:5000}"
echo "   TEST_TOKEN: ${TEST_TOKEN:-eyJhbGci... (default)}"
echo ""

# Roda os testes
echo "🚀 Rodando testes E2E..."
echo "═══════════════════════════════════════════════════"

# Teste 1: Fluxo da Secretária V2 (completo)
echo ""
echo "📋 Teste 1: Fluxo da Secretária V2"
echo "───────────────────────────────────────────────────"
npx vitest run tests/e2e/v2/fluxo-secretaria-v2.e2e.test.js --reporter=verbose

# Teste 2: Appointment + Payment Async (específico)
echo ""
echo "📋 Teste 2: Appointment + Payment Async"
echo "───────────────────────────────────────────────────"
echo 'Teste 2 removido - usar fluxo-secretaria-v2.e2e.test.js'

echo ""
echo "═══════════════════════════════════════════════════"
echo "✅ Todos os testes E2E V2 finalizados"
