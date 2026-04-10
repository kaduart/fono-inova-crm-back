#!/bin/bash
# 🚀 START PRODUÇÃO - Ignora VS Code e limites

# Limpa qualquer NODE_OPTIONS anterior
unset NODE_OPTIONS

# Exporta apenas o que precisamos
export NODE_OPTIONS="--max-old-space-size=2048"
export NODE_ENV="production"
export TZ="America/Sao_Paulo"

# Vai pro diretório
cd /home/user/projetos/crm/back

# Mata processo anterior se existir
pkill -f "node server.js" 2>/dev/null
sleep 2

# Sobe o servidor
exec node server.js
