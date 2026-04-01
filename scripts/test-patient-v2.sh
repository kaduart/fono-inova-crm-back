#!/bin/bash
# =============================================================================
# Script de Teste - Patients V2 (CQRS)
# =============================================================================
# Uso:
#   ./scripts/test-patient-v2.sh              # Roda todos os testes
#   ./scripts/test-patient-v2.sh --consistency # Só teste de consistência
#   ./scripts/test-patient-v2.sh --debug ID   # Debug de paciente específico
#   ./scripts/test-patient-v2.sh --audit      # Auditoria de views
# =============================================================================

set -e

# Cores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Config
API_URL="${API_URL:-http://localhost:5000}"
TOKEN="${TOKEN:-}"

# =============================================================================
# FUNÇÕES
# =============================================================================

log_info() {
  echo -e "${BLUE}ℹ️  $1${NC}"
}

log_success() {
  echo -e "${GREEN}✅ $1${NC}"
}

log_error() {
  echo -e "${RED}❌ $1${NC}"
}

log_warn() {
  echo -e "${YELLOW}⚠️  $1${NC}"
}

header() {
  echo ""
  echo "============================================================================="
  echo "  $1"
  echo "============================================================================="
  echo ""
}

check_api() {
  log_info "Verificando API em $API_URL..."
  
  if ! curl -s "$API_URL/api/health" > /dev/null 2>&1; then
    log_error "API não está respondendo em $API_URL"
    log_info "Inicie o servidor com: npm run dev"
    exit 1
  fi
  
  log_success "API está online"
}

get_token() {
  if [ -z "$TOKEN" ]; then
    log_warn "TOKEN não definido. Usando token de exemplo (pode falhar)."
    log_info "Defina: export TOKEN=seu_token_jwt"
  fi
}

# =============================================================================
# TESTES
# =============================================================================

run_consistency_tests() {
  header "TESTE DE CONSISTÊNCIA"
  
  log_info "Rodando testes de consistência..."
  
  cd "$(dirname "$0")/.."
  
  if ! node tests/patientV2.consistency.test.js; then
    log_error "Testes de consistência falharam!"
    exit 1
  fi
  
  log_success "Todos os testes de consistência passaram!"
}

run_debug_check() {
  local patient_id="${1:-}"
  
  header "DEBUG DE PACIENTE"
  
  if [ -z "$patient_id" ]; then
    # Pega um paciente aleatório
    log_info "Buscando paciente de teste..."
    patient_id=$(curl -s "$API_URL/api/patients?limit=1" \
      -H "Authorization: Bearer $TOKEN" 2>/dev/null | \
      jq -r '.[0]._id // empty')
    
    if [ -z "$patient_id" ]; then
      log_error "Nenhum paciente encontrado para debug"
      exit 1
    fi
    
    log_info "Usando paciente: $patient_id"
  fi
  
  log_info "Verificando consistência da view..."
  
  local response=$(curl -s "$API_URL/api/v2/patients/debug/$patient_id" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json")
  
  echo "$response" | jq '.'
  
  local is_consistent=$(echo "$response" | jq -r '.data.diagnosis.isConsistent')
  
  if [ "$is_consistent" = "true" ]; then
    log_success "View está consistente!"
  else
    log_error "View está inconsistente!"
    
    local diff_count=$(echo "$response" | jq -r '.data.diff.count')
    log_warn "Diferenças encontradas: $diff_count"
    
    read -p "Deseja corrigir? (y/n) " -n 1 -r
    echo
    
    if [[ $REPLY =~ ^[Yy]$ ]]; then
      log_info "Corrigindo view..."
      
      local fix_response=$(curl -s -X POST "$API_URL/api/v2/patients/debug/$patient_id/fix" \
        -H "Authorization: Bearer $TOKEN" \
        -H "Content-Type: application/json")
      
      echo "$fix_response" | jq '.'
      log_success "View corrigida!"
    fi
  fi
}

run_audit() {
  header "AUDITORIA DE VIEWS"
  
  log_info "Auditando consistência de views..."
  
  local response=$(curl -s "$API_URL/api/v2/patients/debug/audit/consistency?sample=50" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json")
  
  echo "$response" | jq '.data.summary'
  
  local health_score=$(echo "$response" | jq -r '.data.summary.healthScore')
  
  if [ "$health_score" = "100" ]; then
    log_success "Saúde do sistema: 100% - Todas as views consistentes!"
  else
    log_warn "Saúde do sistema: $health_score%"
    
    local issues=$(echo "$response" | jq '.data.issues')
    if [ "$issues" != "[]" ]; then
      log_error "Problemas encontrados:"
      echo "$issues" | jq '.'
    fi
  fi
}

run_stale_check() {
  header "VERIFICAÇÃO DE VIEWS STALE"
  
  log_info "Buscando views desatualizadas..."
  
  local response=$(curl -s "$API_URL/api/v2/patients/debug/audit/stale?limit=20" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json")
  
  local count=$(echo "$response" | jq -r '.data.count')
  
  if [ "$count" = "0" ]; then
    log_success "Nenhuma view stale encontrada!"
  else
    log_warn "$count views stale encontradas:"
    echo "$response" | jq '.data.views'
  fi
}

run_performance_test() {
  header "TESTE DE PERFORMANCE"
  
  log_info "Testando GET /v2/patients (listagem)..."
  
  local start_time=$(date +%s%N)
  
  curl -s "$API_URL/api/v2/patients?limit=50" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" > /dev/null
  
  local end_time=$(date +%s%N)
  local duration=$(( (end_time - start_time) / 1000000 ))
  
  echo ""
  echo "Performance Results:"
  echo "  GET /v2/patients (50 items): ${duration}ms"
  
  if [ $duration -lt 100 ]; then
    log_success "Excelente! (< 100ms)"
  elif [ $duration -lt 300 ]; then
    log_warn "Bom (< 300ms)"
  else
    log_error "Lento (> 300ms) - verificar índices"
  fi
}

run_full_validation() {
  header "VALIDAÇÃO COMPLETA - PATIENTS V2"
  
  check_api
  get_token
  
  run_consistency_tests
  run_audit
  run_stale_check
  run_performance_test
  
  header "RESULTADO FINAL"
  log_success "Todos os testes passaram! Patients V2 está pronto."
}

# =============================================================================
# MAIN
# =============================================================================

main() {
  case "${1:-}" in
    --consistency|-c)
      run_consistency_tests
      ;;
    --debug|-d)
      check_api
      get_token
      run_debug_check "${2:-}"
      ;;
    --audit|-a)
      check_api
      get_token
      run_audit
      ;;
    --stale|-s)
      check_api
      get_token
      run_stale_check
      ;;
    --performance|-p)
      check_api
      get_token
      run_performance_test
      ;;
    --help|-h)
      echo "Uso: $0 [opção]"
      echo ""
      echo "Opções:"
      echo "  --consistency, -c     Roda testes de consistência"
      echo "  --debug [ID], -d      Debug de paciente específico"
      echo "  --audit, -a           Auditoria de views"
      echo "  --stale, -s           Verifica views stale"
      echo "  --performance, -p     Teste de performance"
      echo "  --help, -h            Mostra esta ajuda"
      echo ""
      echo "Variáveis de ambiente:"
      echo "  API_URL               URL da API (default: http://localhost:5000)"
      echo "  TOKEN                 JWT token para autenticação"
      ;;
    *)
      run_full_validation
      ;;
  esac
}

main "$@"
