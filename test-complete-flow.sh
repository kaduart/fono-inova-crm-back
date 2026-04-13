#!/bin/bash

# ============================================
# TESTE COMPLETE FLOW - PARTICULAR DEBT
# ============================================
# Valida o núcleo financeiro do sistema V2

BASE_URL="http://localhost:5000/api"
TOKEN="${TOKEN:-$1}"

echo "🔥 TESTE COMPLETE FLOW - ENGINE FINANCEIRA"
echo "=========================================="
echo ""

if [ -z "$TOKEN" ]; then
    echo "❌ Token não fornecido"
    echo "   Uso: ./test-complete-flow.sh <token>"
    echo "   Ou: export TOKEN=<token>; ./test-complete-flow.sh"
    exit 1
fi

# ============================================
# PASSO 1: Criar package particular per-session
# ============================================
echo "📦 PASSO 1: Criando package particular per-session..."

create_response=$(curl -s -X POST "$BASE_URL/v2/packages" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "patientId": "67c78192fd684406e67992c7",
    "clinicId": "67c77f94fd684406e67992b5",
    "professionalId": "67c77feafd684406e67992bd",
    "type": "therapy",
    "modality": "inPerson",
    "paymentType": "per-session",
    "totalSessions": 2,
    "sessionValue": 180,
    "schedule": [
      {
        "date": "2026-04-15T14:00:00.000Z",
        "professionalId": "67c77feafd684406e67992bd",
        "modality": "inPerson"
      },
      {
        "date": "2026-04-22T14:00:00.000Z",
        "professionalId": "67c77feafd684406e67992bd",
        "modality": "inPerson"
      }
    ]
  }')

package_id=$(echo $create_response | grep -o '"packageId":"[^"]*"' | cut -d'"' -f4)

if [ -z "$package_id" ]; then
    package_id=$(echo $create_response | grep -o '"_id":"[^"]*"' | head -1 | cut -d'"' -f4)
fi

if [ -z "$package_id" ]; then
    echo "❌ Erro ao criar package"
    echo "   Resposta: $create_response"
    exit 1
fi

echo "   ✅ Package criado: ${package_id:0:20}..."
echo ""

# Aguardar processamento
sleep 2

# ============================================
# PASSO 2: Buscar package e pegar appointmentId
# ============================================
echo "📋 PASSO 2: Buscando sessão scheduled..."

get_response=$(curl -s "$BASE_URL/v2/packages/$package_id" \
  -H "Authorization: Bearer $TOKEN")

appointment_id=$(echo $get_response | grep -o '"appointmentId":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ -z "$appointment_id" ]; then
    echo "❌ appointmentId não encontrado"
    echo "   Resposta: $get_response"
    exit 1
fi

echo "   ✅ Appointment ID: ${appointment_id:0:20}..."
echo ""

# ============================================
# PASSO 3: Completar sessão (NÃO PAGO)
# ============================================
echo "💰 PASSO 3: Completando sessão (gera dívida)..."

complete_response=$(curl -s -X PATCH "$BASE_URL/v2/appointments/$appointment_id/complete" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "notes": "Sessão particular realizada - teste de dívida",
    "evolution": "Fonoterapia realizada com sucesso"
  }')

complete_status=$(echo $complete_response | grep -o '"status":[^,}]*' | head -1 | cut -d':' -f2 | tr -d '"')

echo "   Status HTTP: $(echo $complete_response | grep -o 'status":[0-9]*' | head -1 | grep -o '[0-9]*')"
echo "   Status retornado: $complete_status"

if echo "$complete_response" | grep -q "202"; then
    echo "   ✅ 202 Accepted - Processamento async iniciado"
elif echo "$complete_response" | grep -q '"success":true'; then
    echo "   ✅ Sucesso"
else
    echo "   ⚠️ Resposta: $complete_response"
fi

echo ""
echo "⏳ Aguardando processamento..."
sleep 3

# ============================================
# PASSO 4: Verificar impacto financeiro
# ============================================
echo "🔍 PASSO 4: Verificando impacto financeiro..."

get_pkg_response=$(curl -s "$BASE_URL/v2/packages/$package_id" \
  -H "Authorization: Bearer $TOKEN")

# Extrair valores
balance=$(echo $get_pkg_response | grep -o '"balance":[0-9.]*' | head -1 | cut -d':' -f2)
total_paid=$(echo $get_pkg_response | grep -o '"totalPaid":[0-9.]*' | head -1 | cut -d':' -f2)
sessions_done=$(echo $get_pkg_response | grep -o '"sessionsDone":[0-9]*' | head -1 | cut -d':' -f2)
remaining=$(echo $get_pkg_response | grep -o '"sessionsRemaining":[0-9]*' | head -1 | cut -d':' -f2)
financial_status=$(echo $get_pkg_response | grep -o '"financialStatus":"[^"]*"' | head -1 | cut -d'"' -f4)

echo ""
echo "📊 RESULTADO FINANCEIRO:"
echo "─────────────────────────────────────────"
echo "   Sessions Done: ${sessions_done:-0}"
echo "   Sessions Remaining: ${remaining:-0}"
echo "   Total Paid: R$ ${total_paid:-0}"
echo "   Balance (Dívida): R$ ${balance:-0}"
echo "   Financial Status: ${financial_status:-unknown}"
echo ""

# ============================================
# VALIDAÇÕES
# ============================================
echo "🧮 VALIDAÇÕES:"
echo "─────────────────────────────────────────"

errors=0

# Validação 1: balance > 0
if [ "${balance:-0}" != "0" ] && [ "${balance:-0}" != "0.0" ]; then
    echo "   ✅ Balance > 0 (dívida gerada)"
else
    echo "   ❌ Balance = 0 (esperava dívida)"
    ((errors++))
fi

# Validação 2: sessionsDone = 1
if [ "$sessions_done" = "1" ]; then
    echo "   ✅ Sessions Done = 1"
else
    echo "   ❌ Sessions Done = $sessions_done (esperava 1)"
    ((errors++))
fi

# Validação 3: totalPaid = 0
if [ "${total_paid:-0}" = "0" ] || [ "${total_paid:-0}" = "0.0" ]; then
    echo "   ✅ Total Paid = 0 (não pago)"
else
    echo "   ❌ Total Paid = $total_paid (esperava 0)"
    ((errors++))
fi

# Validação 4: financialStatus = unpaid
if [ "$financial_status" = "unpaid" ]; then
    echo "   ✅ Financial Status = 'unpaid'"
else
    echo "   ⚠️  Financial Status = '$financial_status' (esperava 'unpaid')"
fi

echo ""

# ============================================
# RESULTADO FINAL
# ============================================
if [ $errors -eq 0 ]; then
    echo "🎉🎉🎉 ENGINE FINANCEIRA VALIDADA! 🎉🎉🎉"
    echo ""
    echo "✅ Todas as validações passaram:"
    echo "   - Dívida gerada corretamente"
    echo "   - Contadores atualizados"
    echo "   - Estado financeiro consistente"
    echo ""
    echo "💀 PRÓXIMO PASSO: Expandir para outros cenários"
    exit 0
else
    echo "❌❌❌ FALHAS DETECTADAS: $errors ❌❌❌"
    echo ""
    echo "Investigar engine financeira antes de continuar"
    exit 1
fi
