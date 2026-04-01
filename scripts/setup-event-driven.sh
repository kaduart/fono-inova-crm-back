#!/bin/bash
# setup-event-driven.sh
# Script de setup para arquitetura event-driven

set -e

echo "🚀 Setup Arquitetura Event-Driven"
echo "=================================="

# Cores
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 1. Verificar dependências
echo -e "${YELLOW}Verificando dependências...${NC}"

if ! command -v redis-cli &> /dev/null; then
    echo "⚠️  Redis CLI não encontrado. Instalando..."
    
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        sudo apt-get update
        sudo apt-get install -y redis-tools
    elif [[ "$OSTYPE" == "darwin"* ]]; then
        brew install redis
    fi
fi

# 2. Verificar se Redis está rodando
echo -e "${YELLOW}Verificando Redis...${NC}"

if redis-cli ping &> /dev/null; then
    echo -e "${GREEN}✅ Redis está rodando${NC}"
else
    echo "⚠️  Redis não está rodando. Iniciando..."
    
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        sudo systemctl start redis
    elif [[ "$OSTYPE" == "darwin"* ]]; then
        brew services start redis
    else
        echo "❌ Por favor inicie o Redis manualmente"
        exit 1
    fi
fi

# 3. Instalar dependências do BullMQ
echo -e "${YELLOW}Instalando dependências...${NC}"
npm install bullmq ioredis --save

# 4. Criar diretórios se não existirem
echo -e "${YELLOW}Criando estrutura de diretórios...${NC}"
mkdir -p infrastructure/queue infrastructure/events workers services

# 5. Verificar variáveis de ambiente
echo -e "${YELLOW}Verificando variáveis de ambiente...${NC}"

if [ -f .env ]; then
    if ! grep -q "REDIS_HOST" .env; then
        echo "" >> .env
        echo "# Redis Configuration" >> .env
        echo "REDIS_HOST=localhost" >> .env
        echo "REDIS_PORT=6379" >> .env
        echo -e "${GREEN}✅ Variáveis Redis adicionadas ao .env${NC}"
    fi
else
    echo "❌ Arquivo .env não encontrado"
    exit 1
fi

# 6. Testar conexão com Redis
echo -e "${YELLOW}Testando conexão com Redis...${NC}"
if redis-cli ping | grep -q "PONG"; then
    echo -e "${GREEN}✅ Conexão com Redis OK${NC}"
else
    echo "❌ Não foi possível conectar ao Redis"
    exit 1
fi

echo ""
echo "=================================="
echo -e "${GREEN}✅ Setup completo!${NC}"
echo ""
echo "Próximos passos:"
echo "1. Inicie os workers: node workers/index.js"
echo "2. Inicie a API: npm run dev"
echo "3. Teste: curl -X PATCH http://localhost:5000/api/appointments/:id/complete"
echo ""
echo "Monitoramento:"
echo "- Redis CLI: redis-cli monitor"
echo "- Filas: redis-cli keys 'bull:*'"
echo "=================================="
