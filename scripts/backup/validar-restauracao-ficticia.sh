#!/usr/bin/env bash
# Ensaio do procedimento de backup e restauração com DADOS FICTÍCIOS, em dois
# MongoDB descartáveis (Docker, loopback). Repete os passos do backup-noturno.yml:
# mongodump --archive --gzip, cifra com gpg, decifra, mongorestore --stopOnError.
# Depois compara contagem, conteúdo (sha256) e índices de cada coleção.
#
# Valida o PROCEDIMENTO. NÃO prova que o backup real de produção está bom
# (ele falha por auth desde 02/11; ver docs/BACKUP_RESTAURACAO.md).
#
#   scripts/backup/validar-restauracao-ficticia.sh
#   KEEP=1 scripts/backup/validar-restauracao-ficticia.sh   # mantém os contêineres
set -euo pipefail
cd "$(dirname "$0")/../.."

PO=${PO:-27417}; PD=${PD:-27418}
O=crm-backup-origem; D=crm-backup-destino
DB=crm_backup_ficticio
W=$(mktemp -d)
PASS="senha-ficticia-$(date +%s)"   # nunca a senha real
cleanup() { rm -rf "$W"; [ "${KEEP:-0}" = 1 ] || docker rm -f "$O" "$D" >/dev/null 2>&1 || true; }
trap cleanup EXIT

up() { docker rm -f "$1" >/dev/null 2>&1 || true
  docker run -d --name "$1" -p "127.0.0.1:$2:27017" mongo:7 >/dev/null
  for _ in $(seq 1 30); do docker exec "$1" mongosh --quiet --eval 'db.runCommand({ping:1}).ok' >/dev/null 2>&1 && return; sleep 1; done
  echo "Mongo $1 não subiu"; exit 1; }

echo "== 1. Dois Mongo descartáveis: origem 127.0.0.1:$PO, destino 127.0.0.1:$PD"
up "$O" "$PO"; up "$D" "$PD"
UO="mongodb://127.0.0.1:$PO/?directConnection=true"; UD="mongodb://127.0.0.1:$PD/?directConnection=true"

echo "== 2. Dados fictícios na origem"
node scripts/backup/restauracao-ficticia.mjs seed "$UO" "$DB"
node scripts/backup/restauracao-ficticia.mjs digest "$UO" "$DB" "$W/origem.json" >/dev/null

echo "== 3. mongodump --archive --gzip (como no backup noturno)"
docker exec "$O" mongodump --quiet --db "$DB" --archive=/tmp/dump.archive.gz --gzip
docker cp -q "$O:/tmp/dump.archive.gz" "$W/dump.archive.gz"
echo "   tamanho: $(stat -c%s "$W/dump.archive.gz") bytes"

echo "== 4. Cifra e decifra com gpg (senha fictícia)"
gpg --batch --quiet --yes --pinentry-mode loopback --passphrase "$PASS" --symmetric --cipher-algo AES256 -o "$W/dump.gpg" "$W/dump.archive.gz"
gpg --batch --quiet --yes --pinentry-mode loopback --passphrase "$PASS" -d -o "$W/check.archive.gz" "$W/dump.gpg"
cmp -s "$W/dump.archive.gz" "$W/check.archive.gz" && echo "   decifrado igual ao original"

echo "== 5. mongorestore --stopOnError no destino vazio"
docker cp -q "$W/check.archive.gz" "$D:/tmp/check.archive.gz"
docker exec "$D" mongorestore --quiet --archive=/tmp/check.archive.gz --gzip --stopOnError

echo "== 6. Comparação origem x destino"
node scripts/backup/restauracao-ficticia.mjs digest "$UD" "$DB" "$W/destino.json"
node scripts/backup/restauracao-ficticia.mjs compare "$W/origem.json" "$W/destino.json"

echo "== 7. Casos que precisam falhar"
fail=0
if gpg --batch --quiet --pinentry-mode loopback --passphrase "senha-errada" -d -o /dev/null "$W/dump.gpg" 2>/dev/null; then echo "   ERRO: senha errada decifrou"; fail=1; else echo "   senha errada: recusada (ok)"; fi
head -c 2000 "$W/check.archive.gz" > "$W/truncado.archive.gz"
docker cp -q "$W/truncado.archive.gz" "$D:/tmp/truncado.archive.gz"
docker exec "$D" mongosh --quiet --eval "db.getSiblingDB('${DB}_truncado').dropDatabase()" >/dev/null
if docker exec "$D" mongorestore --quiet --archive=/tmp/truncado.archive.gz --gzip --stopOnError --nsFrom "$DB.*" --nsTo "${DB}_truncado.*" 2>/dev/null; then
  node scripts/backup/restauracao-ficticia.mjs digest "$UD" "${DB}_truncado" "$W/truncado.json" >/dev/null
  if node scripts/backup/restauracao-ficticia.mjs compare "$W/origem.json" "$W/truncado.json" 2>/dev/null; then echo "   ERRO: arquivo truncado passou na comparação"; fail=1
  else echo "   arquivo truncado: restore incompleto, a comparação pegou (ok)"; fi
else echo "   arquivo truncado: mongorestore falhou (ok)"; fi

[ $fail = 0 ] && echo "== restauração fictícia validada" || { echo "== falhou"; exit 1; }
