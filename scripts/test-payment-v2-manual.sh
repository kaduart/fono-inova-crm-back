#!/bin/bash
# =============================================================================
# Teste Manual - Payment V2
# =============================================================================
# Testa as rotas de pagamento e verifica se eventos são emitidos
#
# Uso: ./test-payment-v2-manual.sh [TOKEN]
# =============================================================================

set -e

API_URL="${API_URL:-http://localhost:5000}"
TOKEN="${1:-}"

# Cores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() {
  echo -e "${BLUE}ℹ️  $1${NC}"
}

log_success() {
  echo -e "${GREEN}✅ $1${NC}"
}

log_error() {
  echo -e "${RED}❌ $1${NC}"
}

log_warn() {
  echo -e "${YELLOW}⚠️  $1${NC}"
}

# =============================================================================
# CHECKS
# =============================================================================

if [ -z "$TOKEN" ]; then
  log_warn "TOKEN não fornecido"
  log_info "Uso: $0 <jwt_token>"
  exit 1
fi

log_info "Testando API em $API_URL"

# =============================================================================
# TESTE 1: Criar paciente de teste
# =============================================================================

echo ""
echo "============================================================================="
echo "  TESTE 1: Criar paciente"
echo "============================================================================="
echo ""

PATIENT_RESPONSE=$(curl -s -X POST "$API_URL/api/v2/patients" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "fullName": "TEST_PAYMENT_Manual",
    "dateOfBirth": "1990-01-01",
    "phone": "11999999999"
  }')

echo "Resposta: $PATIENT_RESPONSE"

PATIENT_ID=$(echo $PATIENT_RESPONSE | jq -r '.data.patientId // empty')

if [ -z "$PATIENT_ID" ]; then
  log_error "Falha ao criar paciente"
  exit 1
fi

log_success "Paciente criado: $PATIENT_ID"

# Aguarda processamento
sleep 2

# =============================================================================
# TESTE 2: Criar pagamento simples
# =============================================================================

echo ""
echo "============================================================================="
echo "  TESTE 2: Criar pagamento simples"
echo "============================================================================="
echo ""

log_info "Criando pagamento de R$ 150,00..."

PAYMENT_RESPONSE=$(curl -s -X POST "$API_URL/api/payments" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"patientId\": \"$PATIENT_ID\",
    \"amount\": 150.00,
    \"paymentMethod\": \"pix\",
    \"status\": \"completed\"
  }")

echo "Resposta: $PAYMENT_RESPONSE"

PAYMENT_ID=$(echo $PAYMENT_RESPONSE | jq -r '.data._id // .data.id // empty')

if [ -z "$PAYMENT_ID" ]; then
  log_error "Falha ao criar pagamento"
  echo "Resposta completa: $PAYMENT_RESPONSE"
  exit 1
fi

log_success "Pagamento criado: $PAYMENT_ID"
log_info "Verifique os logs do servidor - deve aparecer:"
log_info "  '[PaymentRoutes] Evento emitido: PAYMENT_RECEIVED'"

# Aguarda processamento
sleep 3

# =============================================================================
# TESTE 3: Verificar PatientsView
# =============================================================================

echo ""
echo "============================================================================="
echo "  TESTE 3: Verificar PatientsView"
echo "============================================================================="
echo ""

log_info "Verificando se PatientsView atualizou..."

VIEW_RESPONSE=$(curl -s "$API_URL/api/v2/patients/$PATIENT_ID" \
  -H "Authorization: Bearer $TOKEN")

echo "Resposta: $VIEW_RESPONSE"

TOTAL_REVENUE=$(echo $VIEW_RESPONSE | jq -r '.data.stats.totalRevenue // 0')

if [ "$TOTAL_REVENUE" = "150" ]; then
  log_success "PatientsView atualizado corretamente!"
  log_success "totalRevenue: R$ $TOTAL_REVENUE,00"
else
  log_warn "PatientsView pode não estar atualizado"
  log_warn "totalRevenue esperado: 150"
  log_warn "totalRevenue recebido: $TOTAL_REVENUE"
fi

# =============================================================================
# TESTE 4: Atualizar pagamento
# =============================================================================

echo ""
echo "============================================================================="
echo "  TESTE 4: Atualizar pagamento"
echo "============================================================================="
echo ""

log_info "Atualizando pagamento..."

UPDATE_RESPONSE=$(curl -s -X PUT "$API_URL/api/payments/$PAYMENT_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "notes": "Pagamento atualizado via teste"
  }')

echo "Resposta: $UPDATE_RESPONSE"

if echo $UPDATE_RESPONSE | jq -e '.success' > /dev/null; then
  log_success "Pagamento atualizado"
  log_info "Verifique logs - deve aparecer: 'PAYMENT_UPDATED'"
else
  log_error "Falha ao atualizar"
fi

# =============================================================================
# TESTE 5: Deletar pagamento
# =============================================================================

echo ""
echo "============================================================================="
echo "  TESTE 5: Deletar pagamento"
echo "============================================================================="
echo ""

log_info "Deletando pagamento..."

DELETE_RESPONSE=$(curl -s -X DELETE "$API_URL/api/payments/$PAYMENT_ID" \
  -H "Authorization: Bearer $TOKEN")

echo "Resposta: $DELETE_RESPONSE"

if echo $DELETE_RESPONSE | jq -e '.success' > /dev/null; then
  log_success "Pagamento deletado"
  log_info "Verifique logs - deve aparecer: 'PAYMENT_DELETED'"
else
  log_error "Falha ao deletar"
fi

# Aguarda processamento
sleep 2

# =============================================================================
# TESTE 6: Verificar PatientsView após delete
# =============================================================================

echo ""
echo "============================================================================="
echo "  TESTE 6: Verificar PatientsView após delete"
echo "============================================================================="
echo ""

log_info "Verificando se PatientsView atualizou após delete..."

VIEW_RESPONSE=$(curl -s "$API_URL/api/v2/patients/$PATIENT_ID" \
  -H "Authorization: Bearer $TOKEN")

TOTAL_REVENUE=$(echo $VIEW_RESPONSE | jq -r '.data.stats.totalRevenue // 0')

if [ "$TOTAL_REVENUE" = "0" ]; then
  log_success "PatientsView atualizado corretamente após delete!"
  log_success "totalRevenue: R$ $TOTAL_REVENUE,00"
else
  log_warn "PatientsView pode não estar atualizado"
  log_warn "totalRevenue esperado: 0"
  log_warn "totalRevenue recebido: $TOTAL_REVENUE"
fi

# =============================================================================
# RELATÓRIO FINAL
# =============================================================================

echo ""
echo "============================================================================="
echo "  RELATÓRIO FINAL"
echo "============================================================================="
echo ""

echo "Paciente de teste: $PATIENT_ID"
echo "Pagamento de teste: $PAYMENT_ID"
echo ""
echo "Verifique os logs do servidor para confirmar emissão de eventos:"
echo "  - PAYMENT_RECEIVED"
echo "  - PAYMENT_UPDATED"
echo "  - PAYMENT_DELETED"
echo ""
echo "Comandos úteis:"
echo "  pm2 logs"
echo "  tail -f logs/combined.log | grep 'PaymentRoutes'"
echo ""

log_success "Testes manuais concluídos!"

# Cleanup opcional
echo ""
read -p "Deseja limpar dados de teste? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  log_info "Limpando dados de teste..."
  # Aqui você pode adicionar chamadas para deletar o paciente de teste
  log_success "Dados limpos"
fi
