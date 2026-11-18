#!/usr/bin/env bash
# Evidência em tempo de execução (não só leitura da flag): sobe cada forma real
# de iniciar o CRM contra Mongo e Redis DESCARTÁVEIS em loopback, espera o boot
# e conta quantas vezes "[OutboxDispatcher] Iniciado" aparece no log de cada
# processo. Sem .env, sem credenciais reais, crons e WhatsApp real desligados.
#
#   scripts/e2e/contar-dispatchers-por-processo.sh
#   MONGO_URI_TESTE=... REDIS_URL_TESTE=... (padrão: 127.0.0.1:27217 e 127.0.0.1:6479/9)
set -uo pipefail
cd "$(dirname "$0")/../.."
[ -f .env ] && { echo "Existe .env neste diretório; recuso rodar (poderia apontar para produção)."; exit 2; }

M=${MONGO_URI_TESTE:-mongodb://127.0.0.1:27217/crm_dispatchers_evidencia?directConnection=true}
R=${REDIS_URL_TESTE:-redis://127.0.0.1:6479/9}
for u in "$M" "$R"; do case "$u" in *127.0.0.1*|*localhost*) ;; *) echo "só loopback: $u"; exit 2;; esac; done
WAIT=${WAIT:-40}
OUT=$(mktemp -d)

base_env=(env -i PATH="$PATH" HOME="$HOME" NODE_ENV=development MONGODB_URI="$M" MONGO_URI="$M" REDIS_URL="$R"
  JWT_SECRET=segredo-ficticio OPENAI_API_KEY=sk-ficticio ANTHROPIC_API_KEY=sk-ant-ficticio GEMINI_API_KEY=ficticio
  INTERNAL_BASE_URL=http://127.0.0.1:5099 ENABLE_CRONS=false PORT=5099 PUPPETEER_SKIP_DOWNLOAD=true)

run() { # nome, comando..., extra env antes do --
  local name=$1; shift
  ( "$@" >"$OUT/$name.log" 2>&1 & echo $! >"$OUT/$name.pid"; wait ) &
  sleep "$WAIT"
  pkill -TERM -P "$(cat "$OUT/$name.pid")" 2>/dev/null; kill -TERM "$(cat "$OUT/$name.pid")" 2>/dev/null
  sleep 2; pkill -KILL -P "$(cat "$OUT/$name.pid")" 2>/dev/null; kill -KILL "$(cat "$OUT/$name.pid")" 2>/dev/null
  local n; n=$(grep -ac '\[OutboxDispatcher\] Iniciado' "$OUT/$name.log")
  local grupos; grupos=$(grep -aoE '\[Registry\] start: [a-z]+' "$OUT/$name.log" | awk '{print $3}' | sort | tr '\n' ' ')
  if ! grep -aqE '\[Registry\] start|Back pronto na porta' "$OUT/$name.log"; then
    printf '%-58s NÃO SUBIU (ver %s)\n' "$name" "$OUT/$name.log"; return; fi
  printf '%-58s dispatchers=%s  grupos: %s\n' "$name" "$n" "${grupos:-nenhum}"
}

echo "== cada processo roda ${WAIT}s; logs em $OUT"
run "server.js ENABLE_WORKERS=false (API como no render.yaml)" "${base_env[@]}" ENABLE_WORKERS=false node server.js
run "server.js ENABLE_WORKERS=true sem WORKER_GROUP (monolito)" "${base_env[@]}" ENABLE_WORKERS=true node server.js
run "whatsapp-only.js (Start Command do crm-worker)" "${base_env[@]}" ENABLE_WORKERS=true node workers/entrypoints/whatsapp-only.js
run "reconciliation-worker.js" "${base_env[@]}" ENABLE_WORKERS=true WORKER_GROUP=reconciliation node workers/entrypoints/reconciliation-worker.js
run "whatsapp-only.js com ENABLE_RECONCILIATION_OUTBOX=false" "${base_env[@]}" ENABLE_WORKERS=true ENABLE_RECONCILIATION_OUTBOX=false node workers/entrypoints/whatsapp-only.js
