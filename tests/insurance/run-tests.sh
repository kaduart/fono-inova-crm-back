#!/bin/bash
# Insurance Test Runner
# Executa todos os testes do módulo Insurance

echo "=========================================="
echo "🏥 INSURANCE TEST SUITE"
echo "=========================================="
echo ""

# Cores
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Contadores
PASSED=0
FAILED=0

# Função para rodar teste
run_test() {
    local test_file=$1
    local test_name=$2
    
    echo -e "${YELLOW}▶ Rodando: $test_name${NC}"
    
    if node --test "$test_file" 2>&1 | grep -q "^not ok\|FAIL"; then
        echo -e "${RED}✗ FALHOU: $test_name${NC}"
        ((FAILED++))
    else
        echo -e "${GREEN}✅ PASSOU: $test_name${NC}"
        ((PASSED++))
    fi
    echo ""
}

# ============================================
# EXECUTAR TESTES
# ============================================

# 1. Testes Unitários
run_test "tests/insurance/insuranceDomain.test.js" "Domain Logic (Unitário)"

# 2. Testes de Integração
run_test "tests/insurance/insuranceIntegration.test.js" "Fluxo Completo (Integração)"

# 3. Testes de Stress
run_test "tests/insurance/insuranceStress.test.js" "Concorrência & Performance (Stress)"

# ============================================
# RESUMO
# ============================================
echo "=========================================="
echo "📊 RESUMO"
echo "=========================================="
echo -e "${GREEN}✅ Passaram: $PASSED${NC}"
echo -e "${RED}❌ Falharam: $FAILED${NC}"
echo ""

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}🎉 TODOS OS TESTES PASSARAM!${NC}"
    exit 0
else
    echo -e "${RED}💥 ALGUNS TESTES FALHARAM${NC}"
    exit 1
fi
