#!/bin/bash
# run-e2e-test.sh
# Script para executar teste E2E Clinical → Billing

set -e

echo "═══════════════════════════════════════════════════════════════"
echo "🧪 CRM E2E Test: Clinical → Billing Event Flow"
echo "═══════════════════════════════════════════════════════════════"

# Cores
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Verificar variáveis de ambiente
if [ -z "$TEST_DB_URI" ]; then
    export TEST_DB_URI="mongodb://localhost:27017/crm_test_e2e"
    echo -e "${YELLOW}⚠️  TEST_DB_URI não definido, usando padrão: $TEST_DB_URI${NC}"
fi

if [ -z "$REDIS_URL" ]; then
    export REDIS_URL="redis://localhost:6379"
    echo -e "${YELLOW}⚠️  REDIS_URL não definido, usando padrão: $REDIS_URL${NC}"
fi

echo ""
echo "📋 Configuração:"
echo "   Database: $TEST_DB_URI"
echo "   Redis: $REDIS_URL"
echo ""

# Verificar serviços
echo "🔍 Verificando serviços..."

# MongoDB
if mongosh --eval "db.adminCommand('ping')" > /dev/null 2>&1; then
    echo -e "${GREEN}✓${NC} MongoDB: OK"
else
    echo -e "${RED}✗${NC} MongoDB: Não disponível"
    echo "   Inicie o MongoDB: mongod --dbpath /path/to/db"
    exit 1
fi

# Redis
if redis-cli ping > /dev/null 2>&1; then
    echo -e "${GREEN}✓${NC} Redis: OK"
else
    echo -e "${RED}✗${NC} Redis: Não disponível"
    echo "   Inicie o Redis: redis-server"
    exit 1
fi

echo ""
echo "🚀 Executando teste E2E..."
echo "═══════════════════════════════════════════════════════════════"
echo ""

# Executar teste Vitest
cd /home/user/projetos/crm/back
npx vitest run tests/e2e/clinical-to-billing.e2e.test.js --reporter=verbose

TEST_RESULT=$?

echo ""
echo "═══════════════════════════════════════════════════════════════"

if [ $TEST_RESULT -eq 0 ]; then
    echo -e "${GREEN}✅ E2E Test PASSED${NC}"
    echo ""
    echo "Arquitetura Event-Driven validada:"
    echo "  ✓ Clinical → Event Store"
    echo "  ✓ Event Store → Billing (se worker rodando)"
    echo "  ✓ CorrelationId end-to-end"
else
    echo -e "${RED}❌ E2E Test FAILED${NC}"
    echo ""
    echo "Verifique:"
    echo "  1. MongoDB está rodando"
    echo "  2. Redis está rodando"
    echo "  3. Variáveis de ambiente configuradas"
    echo "  4. Dependências instaladas (npm install)"
fi

echo "═══════════════════════════════════════════════════════════════"

exit $TEST_RESULT
