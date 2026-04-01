#!/bin/bash
# =============================================================================
# Validação do Patch Payment.js
# =============================================================================
# Verifica se o patch foi aplicado corretamente
# =============================================================================

echo "============================================================================="
echo "  VALIDAÇÃO DO PATCH PAYMENT.JS"
echo "============================================================================="
echo ""

# Cores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

check_file() {
  local file="$1"
  local pattern="$2"
  local description="$3"
  
  if grep -q "$pattern" "$file"; then
    echo -e "${GREEN}✅${NC} $description"
    return 0
  else
    echo -e "${RED}❌${NC} $description (NÃO ENCONTRADO)"
    return 1
  fi
}

echo "📁 Verificando arquivo: routes/Payment.js"
echo ""

# Verifica imports
check_file "routes/Payment.js" "import.*publishEvent.*from.*eventPublisher" "Import do publishEvent"
check_file "routes/Payment.js" "import.*EventTypes.*from.*eventPublisher" "Import do EventTypes"

echo ""

# Verifica helpers
check_file "routes/Payment.js" "async function emitPaymentEvent" "Helper emitPaymentEvent"
check_file "routes/Payment.js" "async function emitAppointmentEvent" "Helper emitAppointmentEvent"

echo ""

# Verifica eventos nas rotas
check_file "routes/Payment.js" "emitPaymentEvent.*PAYMENT_RECEIVED" "Evento PAYMENT_RECEIVED"
check_file "routes/Payment.js" "emitPaymentEvent.*PAYMENT_UPDATED" "Evento PAYMENT_UPDATED"
check_file "routes/Payment.js" "emitPaymentEvent.*PAYMENT_DELETED" "Evento PAYMENT_DELETED"
check_file "routes/Payment.js" "emitAppointmentEvent.*APPOINTMENT_UPDATED" "Evento APPOINTMENT_UPDATED"

echo ""
echo "============================================================================="
echo "  RESUMO"
echo "============================================================================="
echo ""

# Conta ocorrências
echo "Estatísticas do patch:"
echo "  - Imports de eventos: $(grep -c "publishEvent\|EventTypes" routes/Payment.js)"
echo "  - Chamadas emitPaymentEvent: $(grep -c "emitPaymentEvent" routes/Payment.js)"
echo "  - Chamadas emitAppointmentEvent: $(grep -c "emitAppointmentEvent" routes/Payment.js)"
echo "  - Eventos PAYMENT_RECEIVED: $(grep -c "PAYMENT_RECEIVED" routes/Payment.js)"
echo "  - Eventos PAYMENT_UPDATED: $(grep -c "PAYMENT_UPDATED" routes/Payment.js)"
echo "  - Eventos PAYMENT_DELETED: $(grep -c "PAYMENT_DELETED" routes/Payment.js)"

echo ""

# Verifica se é o arquivo patched
if grep -q "PATCHED WITH EVENTS" routes/Payment.js; then
  echo -e "${GREEN}✅ Arquivo está com o patch aplicado!${NC}"
else
  echo -e "${YELLOW}⚠️  Arquivo pode não ter o patch completo${NC}"
fi

echo ""
echo "============================================================================="
echo "  PRÓXIMO PASSO"
echo "============================================================================="
echo ""
echo "Para testar funcionamento:"
echo "  1. Reinicie o servidor: pm2 restart server"
echo "  2. Crie um pagamento via API"
echo "  3. Verifique os logs: pm2 logs | grep 'PaymentRoutes'"
echo "  4. Confirme que aparece: 'Evento emitido: PAYMENT_RECEIVED'"
echo ""
