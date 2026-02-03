#!/bin/bash

# 🧪 AMANDA FLOW TESTS - Script de Execução
# Uso: ./run-tests.sh [opções]

set -e

# Cores
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  🧪 AMANDA FLOW TESTS - Execução de Testes${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
echo ""

# Verifica se está no diretório correto
if [ ! -f "flows.test.js" ]; then
    echo -e "${RED}❌ Erro: Execute este script do diretório tests/amanda/${NC}"
    exit 1
fi

# Verifica Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ Node.js não encontrado${NC}"
    exit 1
fi

echo -e "${YELLOW}📋 Cenários de teste:${NC}"
echo "  1. 💰 Primeiro contato perguntando preço"
echo "  2. 👋 Primeiro contato só 'Oi'"
echo "  3. 🔥 Nunca repetir pergunta de idade"
echo "  4. 📅 Fluxo completo de agendamento"
echo "  5. 🔄 Fluxo multi-passos (contexto preservado)"
echo "  6. 📍 Pergunta endereço"
echo "  7. 🏥 Pergunta convênio"
echo ""

# Executa os testes
echo -e "${BLUE}⏳ Executando testes...${NC}"
echo ""

cd ../../
if node tests/amanda/bootstrap.js; then
    echo ""
    echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}  ✅ TODOS OS TESTES PASSARAM!${NC}"
    echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
    exit 0
else
    echo ""
    echo -e "${RED}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${RED}  ❌ ALGUNS TESTES FALHARAM${NC}"
    echo -e "${RED}═══════════════════════════════════════════════════════════════${NC}"
    exit 1
fi
