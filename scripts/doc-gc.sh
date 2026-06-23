#!/bin/bash
# doc-gc.sh — Documentation Garbage Collector
#
# Classifica todos os .md em:
#   INDEXED    → aparece em CLAUDE.md, DOMAIN_INVARIANTS ou ARCHITECTURE_FLOW
#   REFERENCED → citado em outros .md (mas não no índice)
#   DEPRECATED → contém marcador explícito de deprecação
#   DEAD       → nenhuma das anteriores
#
# Uso: bash back/scripts/doc-gc.sh [--output report.md]
#
# Saída padrão: tabela markdown no stdout
# Saída alternativa: arquivo com --output

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

INDEX_FILES=(
  "$ROOT/CLAUDE.md"
  "$ROOT/back/docs/DOMAIN_INVARIANTS.md"
  "$ROOT/back/docs/ARCHITECTURE_FLOW.md"
)

OUTPUT_FILE=""
if [[ "$1" == "--output" && -n "$2" ]]; then
  OUTPUT_FILE="$2"
fi

# ─── Coleta todos os .md ───────────────────────────────────────────────────
mapfile -t ALL_MDS < <(find "$ROOT" \
  -name "*.md" \
  -not -path "*/node_modules/*" \
  -not -path "*/.git/*" \
  | sort)

# ─── Helpers ──────────────────────────────────────────────────────────────

is_indexed() {
  local name="$1"
  for idx in "${INDEX_FILES[@]}"; do
    if grep -q "$name" "$idx" 2>/dev/null; then
      return 0
    fi
  done
  return 1
}

count_md_refs() {
  local filepath="$1"
  local name
  name=$(basename "$filepath" .md)
  grep -rl "$name" "$ROOT" \
    --include="*.md" \
    --exclude-dir=node_modules \
    --exclude-dir=.git \
    2>/dev/null \
    | grep -v "$filepath" \
    | wc -l | tr -d ' '
}

count_code_refs() {
  local filepath="$1"
  local name
  name=$(basename "$filepath" .md)
  grep -rl "$name" "$ROOT" \
    --include="*.js" \
    --include="*.ts" \
    --include="*.mjs" \
    --exclude-dir=node_modules \
    2>/dev/null \
    | wc -l | tr -d ' '
}

has_deprecation_marker() {
  local filepath="$1"
  grep -iqE \
    "deprecated|superseded|replaced.by|substituído por|migrado para|não usar mais|LEGACY" \
    "$filepath" 2>/dev/null
}

# ─── Contadores de status ──────────────────────────────────────────────────
count_indexed=0
count_referenced=0
count_deprecated=0
count_dead=0

# ─── Gera linhas ──────────────────────────────────────────────────────────
generate_report() {
  echo "# Relatório — Documentation Garbage Collector"
  echo "> Gerado em: $(date '+%Y-%m-%d %H:%M')"
  echo "> Root: $ROOT"
  echo ""
  echo "## Legenda"
  echo "- 🟢 **INDEXED** — citado em CLAUDE.md / DOMAIN_INVARIANTS / ARCHITECTURE_FLOW"
  echo "- 🟡 **REFERENCED** — citado em outros .md ou no código"
  echo "- 🔴 **DEPRECATED** — contém marcador explícito de deprecação"
  echo "- ⚫ **DEAD** — nenhuma referência encontrada"
  echo ""
  echo "| Status | Arquivo | Refs .md | Refs código |"
  echo "|--------|---------|----------|-------------|"

  for filepath in "${ALL_MDS[@]}"; do
    relpath="${filepath#$ROOT/}"
    name=$(basename "$filepath" .md)

    md_refs=$(count_md_refs "$filepath")
    code_refs=$(count_code_refs "$filepath")

    if is_indexed "$name"; then
      status="🟢 INDEXED"
      ((count_indexed++))
    elif [[ "$md_refs" -gt 1 || "$code_refs" -gt 0 ]]; then
      status="🟡 REFERENCED"
      ((count_referenced++))
    elif has_deprecation_marker "$filepath"; then
      status="🔴 DEPRECATED"
      ((count_deprecated++))
    else
      status="⚫ DEAD"
      ((count_dead++))
    fi

    echo "| $status | \`$relpath\` | $md_refs | $code_refs |"
  done

  local total=${#ALL_MDS[@]}
  echo ""
  echo "## Resumo"
  echo "| Status | Qtd |"
  echo "|--------|-----|"
  echo "| 🟢 INDEXED | $count_indexed |"
  echo "| 🟡 REFERENCED | $count_referenced |"
  echo "| 🔴 DEPRECATED | $count_deprecated |"
  echo "| ⚫ DEAD | $count_dead |"
  echo "| **Total** | **$total** |"
}

# ─── Saída ────────────────────────────────────────────────────────────────
if [[ -n "$OUTPUT_FILE" ]]; then
  generate_report > "$OUTPUT_FILE"
  echo "Relatório salvo em: $OUTPUT_FILE"
else
  generate_report
fi
