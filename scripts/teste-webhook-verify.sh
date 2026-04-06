#!/bin/bash

# Simula a verificação do Meta
WEBHOOK_URL="https://fono-inova-crm-back.onrender.com/api/whatsapp/webhook"
TOKEN="fono-inova-verify-2025"
CHALLENGE="123456789"

echo "🧪 Testando verificação do webhook..."
echo "URL: $WEBHOOK_URL"
echo ""

# Faz a requisição igual o Meta faz
RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" \
  "$WEBHOOK_URL?hub.mode=subscribe&hub.verify_token=$TOKEN&hub.challenge=$CHALLENGE")

echo "Resposta:"
echo "$RESPONSE"
echo ""

# Verifica se retornou o challenge
if echo "$RESPONSE" | grep -q "$CHALLENGE"; then
  echo "✅ SUCESSO! Webhook configurado corretamente."
else
  echo "❌ FALHA! Verifique o token ou se o backend está online."
fi
