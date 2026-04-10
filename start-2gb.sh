#!/bin/bash
# Start server com 2GB garantido - ignora VS Code

unset NODE_OPTIONS
export NODE_OPTIONS="--max-old-space-size=2048"
export NODE_ENV="development"
export TZ="America/Sao_Paulo"

cd /home/user/projetos/crm/back

# Mata servidor anterior
pkill -f "node server.js" 2>/dev/null
sleep 2

# Sobe com memória garantida
exec node server.js
