#!/bin/bash
export NODE_OPTIONS="--max-old-space-size=2048"
export NODE_ENV="development"
export TZ="America/Sao_Paulo"
cd /home/user/projetos/crm/back
exec node server.js
