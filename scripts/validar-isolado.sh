#!/usr/bin/env bash
# Validação isolada das proteções do CRM (dead-letters, pagamentos, envios e
# Event Store). Sobe MongoDB (replica set de 1 nó) e Redis DESCARTÁVEIS em
# Docker, em portas de loopback próprias, roda as suítes node:test com dados
# fictícios e remove tudo no fim. Não lê .env, não fala com Atlas, Render,
# WhatsApp ou e-mail reais.
#
#   scripts/validar-isolado.sh
#   KEEP=1 scripts/validar-isolado.sh   # mantém os contêineres
set -euo pipefail
cd "$(dirname "$0")/.."

MPORT=${MPORT:-27217}
RPORT=${RPORT:-6479}
M=crm-validar-mongo
R=crm-validar-redis
URI="mongodb://127.0.0.1:${MPORT}/?directConnection=true"
cleanup() { [ "${KEEP:-0}" = 1 ] || docker rm -f "$M" "$R" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== Mongo 7 (replica set) em 127.0.0.1:${MPORT} e Redis em 127.0.0.1:${RPORT}"
docker rm -f "$M" "$R" >/dev/null 2>&1 || true
docker run -d --name "$M" -p "127.0.0.1:${MPORT}:27017" mongo:7 --replSet rs0 --bind_ip_all >/dev/null
docker run -d --name "$R" -p "127.0.0.1:${RPORT}:6379" redis:7-alpine >/dev/null
for _ in $(seq 1 30); do docker exec "$M" mongosh --quiet --eval 'db.runCommand({ping:1}).ok' >/dev/null 2>&1 && break; sleep 1; done
docker exec "$M" mongosh --quiet --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]}).ok' >/dev/null
for _ in $(seq 1 30); do [ "$(docker exec "$M" mongosh --quiet --eval 'db.hello().isWritablePrimary')" = true ] && break; sleep 1; done
for _ in $(seq 1 30); do docker exec "$R" redis-cli ping >/dev/null 2>&1 && break; sleep 1; done

export MONGO_TEST_URI="$URI" MONGO_TXN_TEST_URI="$URI" REDIS_TEST_URL="redis://127.0.0.1:${RPORT}"
fail=0
run() {
  local name=$1; shift
  printf '\n== %s\n' "$name"
  if out=$("$@" 2>&1); then st=OK; else st=FALHOU; fail=1; fi
  echo "$out" | grep -E '^# (pass|fail)|^not ok' || echo "$out" | tail -5
  echo "-> $st"
}
run "Dead-letters com auth (12)"                         npm run -s test:observability-auth
run "Observabilidade: público mínimo, staff e admin (6)" env REDIS_URL="redis://127.0.0.1:${RPORT}" npm run -s test:observability-acesso
run "Pagamentos: idempotência e atomicidade (15)"        npm run -s test:pagamentos-idempotencia
run "Recebimento (/receive) pela camada HTTP (9)"        env REDIS_URL="redis://127.0.0.1:${RPORT}" npm run -s test:recebimento-idempotente
run "Rotas financeiras paralelas e B-1 pela HTTP (21)"   env REDIS_URL="redis://127.0.0.1:${RPORT}" npm run -s test:pagamentos-rotas-paralelas
run "Posse do reaper compartilhada Node/KAS (7)"          npm run -s test:reaper-posse-compartilhada
run "Envios: anti-reenvio, provedor simulado (9)"        npm run -s test:envios-anti-reenvio
run "Envios: fila do WhatsApp Web com o guard (6)"       npm run -s test:envios-whatsapp-web
run "Envios: manual com Idempotency-Key e e-mail convênio (9)" npm run -s test:envios-manual-email
run "Envios: inventário dos caminhos de envio (6)"       npm run -s test:envios-inventario
run "Dispatchers: contagem pelo código (3)"              npm run -s test:dispatchers-contagem
run "Dispatchers: dois ao mesmo tempo (2)"               env REDIS_TEST_URL="redis://127.0.0.1:${RPORT}/7" npm run -s test:dispatchers-concorrentes
run "Event Store: posse, BullMQ real, versões mistas, retry auditado (45)" npm run -s test:eventstore-validacao
run "Worker de WhatsApp com o guard (vitest, 6)"         npx vitest run tests/unit/whatsappSendWorker.deliveryGuard.test.js

echo
[ $fail = 0 ] && echo "== tudo passou" || { echo "== houve falhas (ver acima)"; exit 1; }
