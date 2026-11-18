#!/usr/bin/env bash
# Validação front + back dos pagamentos, ponta a ponta, isolada.
#
# Sobe Mongo (replica set) e Redis DESCARTÁVEIS em Docker (loopback), o servidor
# isolado do back (rotas de pagamento + worker) num laço que o reinicia quando
# ele cai (mantendo o banco), e roda a suíte e2e do FRONT contra ele.
# Dados fictícios; não lê .env; nada sai da máquina.
#
#   FRONT_DIR=../fono-inova-crm-front scripts/e2e/validar-front-back.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
BACK_DIR=$PWD
FRONT_DIR=${FRONT_DIR:-$BACK_DIR/../fono-inova-crm-front}
MPORT=${MPORT:-27317}; RPORT=${RPORT:-6579}; PORT=${PORT:-5066}
M=crm-e2e-mongo; R=crm-e2e-redis
LOG=$(mktemp -d)/servidor.log
LOOP_PID=
cleanup() {
  [ -n "$LOOP_PID" ] && kill "$LOOP_PID" 2>/dev/null || true
  pkill -f "servidor-pagamentos-isolado.mjs.*" -P "$LOOP_PID" 2>/dev/null || true
  pkill -f "PORT=$PORT" 2>/dev/null || true
  [ "${KEEP:-0}" = 1 ] || docker rm -f "$M" "$R" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker rm -f "$M" "$R" >/dev/null 2>&1 || true
docker run -d --name "$M" -p "127.0.0.1:${MPORT}:27017" mongo:7 --replSet rs0 --bind_ip_all >/dev/null
docker run -d --name "$R" -p "127.0.0.1:${RPORT}:6379" redis:7-alpine >/dev/null
for _ in $(seq 1 30); do docker exec "$M" mongosh --quiet --eval 'db.runCommand({ping:1}).ok' >/dev/null 2>&1 && break; sleep 1; done
docker exec "$M" mongosh --quiet --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]}).ok' >/dev/null
for _ in $(seq 1 30); do [ "$(docker exec "$M" mongosh --quiet --eval 'db.hello().isWritablePrimary')" = true ] && break; sleep 1; done

export E2E_MONGO_URI="mongodb://127.0.0.1:${MPORT}/crm_e2e?directConnection=true" REDIS_URL="redis://127.0.0.1:${RPORT}" PORT
(
  first=1
  while true; do
    if [ $first = 1 ]; then E2E_KEEP_DB=0 node scripts/e2e/servidor-pagamentos-isolado.mjs >>"$LOG" 2>&1 || true; first=0
    else E2E_KEEP_DB=1 node scripts/e2e/servidor-pagamentos-isolado.mjs >>"$LOG" 2>&1 || true; fi
    echo "[laço] servidor saiu; reiniciando com o mesmo banco" >>"$LOG"
    sleep 0.5
  done
) &
LOOP_PID=$!
for _ in $(seq 1 60); do grep -q '"pronto":true' "$LOG" 2>/dev/null && break; sleep 1; done
LINE=$(grep -m1 '"pronto":true' "$LOG")
TOKEN=$(echo "$LINE" | sed -E 's/.*"token":"([^"]+)".*/\1/')
PATIENT=$(echo "$LINE" | sed -E 's/.*"patientId":"([^"]+)".*/\1/')

echo "== servidor isolado em 127.0.0.1:${PORT} (log: $LOG)"
cd "$FRONT_DIR"
OUT=$(mktemp)
if E2E_API_BASE="http://127.0.0.1:${PORT}/api" E2E_TOKEN="$TOKEN" E2E_PATIENT="$PATIENT" \
     npx vitest run src/services/__e2e__ --reporter=verbose >"$OUT" 2>&1; then st=0; else st=1; fi
grep -E '^\s+(✓|×|↓)|Tests |AssertionError|Error:' "$OUT" | grep -v 'socket hang up\|dispatchError\|emitErrorEvent\|ECONNREFUSED' || true
[ $st = 0 ] && echo "== front + back: tudo passou" || { echo "== front + back: falhas (saída: $OUT; servidor: $LOG)"; exit 1; }
