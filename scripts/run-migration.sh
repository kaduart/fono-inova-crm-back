#!/bin/bash
# Script para executar a migração de appointments
# Uso: ./scripts/run-migration.sh [from-back-dir]

# Determinar diretório do script
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
BACK_DIR="$(dirname "$SCRIPT_DIR")"

# Mudar para o diretório back/ onde o .env está
cd "$BACK_DIR"

echo "🚀 Executando migração de atribuição de leads..."
echo "   Diretório: $(pwd)"
echo ""
echo "Primeiro, vamos fazer um dry run para ver o que será alterado:"
echo ""

node scripts/migrateAppointmentLeadAttribution.js --dry-run --batch-size=50

echo ""
echo "Se os dados acima parecem corretos, execute sem --dry-run:"
echo "  node scripts/migrateAppointmentLeadAttribution.js --batch-size=100"
