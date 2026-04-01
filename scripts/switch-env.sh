#!/bin/bash
# scripts/switch-env.sh
# Alterna rapidamente entre ambientes

AMBIENTE=$1

if [ -z "$AMBIENTE" ]; then
  echo "Uso: ./scripts/switch-env.sh [production|development]"
  echo ""
  echo "Ambientes disponíveis:"
  echo "  production  → crm_production (DADOS REAIS)"
  echo "  development → crm_development (TESTES)"
  exit 1
fi

if [ "$AMBIENTE" != "production" ] && [ "$AMBIENTE" != "development" ]; then
  echo "❌ Ambiente inválido: $AMBIENTE"
  echo "Use: production ou development"
  exit 1
fi

ENV_FILE=".env.$AMBIENTE"

if [ ! -f "$ENV_FILE" ]; then
  echo "❌ Arquivo $ENV_FILE não encontrado"
  echo "Execute primeiro: node scripts/setup-environments.js"
  exit 1
fi

# Backup do .env atual
if [ -f ".env" ]; then
  cp .env .env.backup
fi

# Copia o ambiente escolhido
cp $ENV_FILE .env

echo "✅ Ambiente alterado para: $AMBIENTE"
echo ""
echo "Banco atual:"
grep "MONGO_URI" .env | head -1
echo ""
echo "Para iniciar o servidor:"
echo "  npm run dev"
