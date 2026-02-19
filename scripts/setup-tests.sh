#!/bin/bash

# 🧪 Script de Instalação de Dependências de Teste
# Executar: bash scripts/setup-tests.sh

echo "🚀 Instalando dependências de teste..."

# Verificar se está na pasta correta
if [ ! -f "package.json" ]; then
    echo "❌ Erro: Execute este script da pasta back/"
    exit 1
fi

# Instalar dependências de teste
echo "📦 Instalando mongodb-memory-server..."
npm install --save-dev mongodb-memory-server@^9.0.0

echo "📦 Instalando supertest..."
npm install --save-dev supertest@^6.3.0

echo "📦 Verificando vitest..."
npm list vitest || npm install --save-dev vitest@^1.0.0

echo "✅ Dependências instaladas!"
echo ""
echo "🧪 Para executar os testes:"
echo "   npm run test:agenda-externa"
echo ""
echo "📊 Para ver relatório de cobertura:"
echo "   npm run test:agenda-externa:coverage"
