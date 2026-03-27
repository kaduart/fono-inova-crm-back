#!/bin/bash

# =============================================================================
# Script de Teste Manual - Arquitetura Financeira v4.0
# =============================================================================
# Uso: ./test-v4-manual.sh [BASE_URL] [TOKEN]
# Exemplo: ./test-v4-manual.sh http://localhost:3000 eyJhbGciOiJIUzI1NiIs...
# =============================================================================

set -e

BASE_URL="${1:-http://localhost:3000}"
TOKEN="${2:-}"
CORRELATION_ID="manual_test_$(date +%s)_$$"

echo "🧪 Testando Arquitetura Financeira v4.0"
echo "========================================"
echo "Base URL: $BASE_URL"
echo "Correlation ID: $CORRELATION_ID"
echo ""

# Cores para output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Função para fazer requests
make_request() {
    local method=$1
    local endpoint=$2
    local data=$3
    local description=$4
    
    echo -e "${YELLOW}▶ $description${NC}"
    echo "  Endpoint: $method $endpoint"
    
    if [ -n "$data" ]; then
        echo "  Body: $data"
    fi
    
    if [ -n "$TOKEN" ]; then
        response=$(curl -s -w "\n%{http_code}" -X "$method" \
            -H "Content-Type: application/json" \
            -H "Authorization: Bearer $TOKEN" \
            -H "x-correlation-id: $CORRELATION_ID" \
            -d "$data" \
            "$BASE_URL$endpoint" 2>/dev/null || echo -e "\n000")
    else
        response=$(curl -s -w "\n%{http_code}" -X "$method" \
            -H "Content-Type: application/json" \
            -H "x-correlation-id: $CORRELATION_ID" \
            -d "$data" \
            "$BASE_URL$endpoint" 2>/dev/null || echo -e "\n000")
    fi
    
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')
    
    if [ "$http_code" -ge 200 ] && [ "$http_code" -lt 300 ]; then
        echo -e "${GREEN}✅ Sucesso (HTTP $http_code)${NC}"
        echo "  Response: $body" | head -c 500
        echo ""
    else
        echo -e "${RED}❌ Erro (HTTP $http_code)${NC}"
        echo "  Response: $body"
    fi
    
    echo ""
    echo "$body"
}

echo "1️⃣  Criando dados de teste..."
echo "=============================="

# Criar paciente
PATIENT_DATA='{
    "fullName": "Paciente Teste v4.0",
    "phone": "11999999999",
    "cpf": "12345678901"
}'

PATIENT_RESPONSE=$(make_request "POST" "/api/patients" "$PATIENT_DATA" "Criando paciente")
PATIENT_ID=$(echo "$PATIENT_RESPONSE" | grep -o '"_id":"[^"]*"' | head -1 | cut -d'"' -f4)

echo "   Patient ID: $PATIENT_ID"
echo ""

# Criar médico
DOCTOR_DATA='{
    "fullName": "Dr. Teste v4.0",
    "email": "drv4@teste.com",
    "cpf": "98765432101",
    "crm": "12345",
    "specialty": "fonoaudiologia"
}'

DOCTOR_RESPONSE=$(make_request "POST" "/api/doctors" "$DOCTOR_DATA" "Criando médico")
DOCTOR_ID=$(echo "$DOCTOR_RESPONSE" | grep -o '"_id":"[^"]*"' | head -1 | cut -d'"' -f4)

echo "   Doctor ID: $DOCTOR_ID"
echo ""

# Criar agendamento
APPOINTMENT_DATA="{
    \"patient\": \"$PATIENT_ID\",
    \"doctor\": \"$DOCTOR_ID\",
    \"date\": \"$(date +%Y-%m-%d)\",
    \"time\": \"10:00\",
    \"duration\": 50,
    \"reason\": \"Teste v4.0\",
    \"specialty\": \"fonoaudiologia\",
    \"sessionType\": \"fonoaudiologia\",
    \"sessionValue\": 150
}"

APPOINTMENT_RESPONSE=$(make_request "POST" "/api/appointments" "$APPOINTMENT_DATA" "Criando agendamento")
APPOINTMENT_ID=$(echo "$APPOINTMENT_RESPONSE" | grep -o '"_id":"[^"]*"' | head -1 | cut -d'"' -f4)

echo "   Appointment ID: $APPOINTMENT_ID"
echo ""

echo "2️⃣  Testando /complete com diferentes cenários"
echo "=============================================="

# Teste 1: Completação normal
echo "---"
echo "📌 Teste 1: Completação normal (auto_per_session)"
make_request "PATCH" "/api/appointments/$APPOINTMENT_ID/complete" "{}" "Completando agendamento normal"

# Verificar Payment criado
echo "   Verificando Payment criado..."
curl -s -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/payments?appointment=$APPOINTMENT_ID" | head -c 1000
echo ""
echo ""

# Criar novo agendamento para teste de saldo devedor
echo "📌 Teste 2: Completação com saldo devedor (manual_balance)"
APPOINTMENT_DATA_2="{
    \"patient\": \"$PATIENT_ID\",
    \"doctor\": \"$DOCTOR_ID\",
    \"date\": \"$(date +%Y-%m-%d)\",
    \"time\": \"11:00\",
    \"duration\": 50,
    \"reason\": \"Teste Saldo Devedor\",
    \"specialty\": \"fonoaudiologia\",
    \"sessionType\": \"fonoaudiologia\",
    \"sessionValue\": 200
}"

APPOINTMENT_RESPONSE_2=$(make_request "POST" "/api/appointments" "$APPOINTMENT_DATA_2" "Criando agendamento para saldo devedor")
APPOINTMENT_ID_2=$(echo "$APPOINTMENT_RESPONSE_2" | grep -o '"_id":"[^"]*"' | head -1 | cut -d'"' -f4)

COMPLETE_DATA='{
    "addToBalance": true,
    "balanceAmount": 200,
    "balanceDescription": "Pagamento pendente - teste manual"
}'

make_request "PATCH" "/api/appointments/$APPOINTMENT_ID_2/complete" "$COMPLETE_DATA" "Completando com saldo devedor"

# Verificar saldo do paciente
echo "   Verificando saldo do paciente..."
curl -s -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/patients/$PATIENT_ID/balance" | head -c 500
echo ""
echo ""

echo "3️⃣  Verificando rastreabilidade"
echo "================================="

# Verificar FinancialEvents
echo "FinancialEvents com correlationId: $CORRELATION_ID"
curl -s -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/financial-events?correlationId=$CORRELATION_ID" | head -c 1000
echo ""
echo ""

echo "========================================"
echo "✅ Testes manuais concluídos!"
echo ""
echo "Verifique no banco de dados:"
echo "  - Payments com paymentOrigin preenchido"
echo "  - Sessions com correlationId"
echo "  - FinancialEvents criados"
echo "========================================"
