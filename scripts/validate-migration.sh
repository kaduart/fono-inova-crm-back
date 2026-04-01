#!/bin/bash
# scripts/validate-migration.sh
# Validação contínua da migração 4.0

set -e

echo "🔍 Validando migração 4.0..."

# 1. Health check V2
echo "   1. Health check V2..."
HEALTH=$(curl -sf http://localhost:5000/api/v2/health || echo '{"success":false}')
if echo "$HEALTH" | grep -q '"success":false'; then
  echo "   ❌ Health check V2 falhou"
  exit 1
fi
echo "   ✅ Health check V2 OK"

# 2. Status das filas
echo "   2. Verificando filas..."
QUEUES=$(curl -sf http://localhost:5000/api/v2/health | jq '.checks.queues // {}')
FAILED_QUEUES=$(echo "$QUEUES" | jq '[to_entries[] | select(.value.status != "ok")] | length')
if [ "$FAILED_QUEUES" -gt "0" ]; then
  echo "   ❌ $FAILED_QUEUES fila(s) com problema"
  exit 1
fi
echo "   ✅ Filas OK"

# 3. Verifica DLQ
echo "   3. Verificando DLQ..."
DLQ_COUNT=$(redis-cli LLEN bull:dlq:failed 2>/dev/null || echo "0")
if [ "$DLQ_COUNT" -gt "10" ]; then
  echo "   ⚠️  DLQ tem $DLQ_COUNT mensagens"
else
  echo "   ✅ DLQ OK ($DLQ_COUNT mensagens)"
fi

# 4. Auditoria financeira (se passou mais de 1h)
echo "   4. Verificando auditoria..."
LAST_AUDIT=$(redis-cli GET last_audit_timestamp 2>/dev/null || echo "0")
NOW=$(date +%s)
DIFF=$((NOW - LAST_AUDIT))

if [ "$DIFF" -gt "3600" ]; then
  echo "   🔄 Rodando auditoria..."
  node scripts/audit-financial-integrity.js || true
  redis-cli SET last_audit_timestamp "$NOW" 2>/dev/null || true
else
  echo "   ⏭️  Auditoria recente (há $((DIFF/60)) min)"
fi

# 5. Métricas de migração
echo "   5. Métricas de migração..."
MIGRATION_STATUS=$(curl -sf http://localhost:5000/api/v2/migration/status 2>/dev/null || echo '{}')
echo "$MIGRATION_STATUS" | jq '.' 2>/dev/null || echo "   ⚠️  Métricas não disponíveis"

echo ""
echo "✅ Validação concluída"
