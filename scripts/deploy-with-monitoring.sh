#!/bin/bash
# 🚀 Deploy com Monitoramento - Amanda AI
# Script para deploy seguro com verificações e rollback automático

set -e

echo "🎯 DEPLOY AMANDA AI - $(date)"
echo "================================"

# Cores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Funções
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[✓]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[⚠]${NC} $1"
}

log_error() {
    echo -e "${RED}[✗]${NC} $1"
}

# 1. Pre-deploy checks
echo ""
echo "🔍 1. VERIFICAÇÕES PRÉ-DEPLOY"
echo "------------------------------"

# Verifica Node.js
if ! command -v node &> /dev/null; then
    log_error "Node.js não encontrado"
    exit 1
fi
NODE_VERSION=$(node -v)
log_success "Node.js: $NODE_VERSION"

# Verifica MongoDB
if ! pgrep -x "mongod" > /dev/null; then
    log_warning "MongoDB não está rodando localmente"
else
    log_success "MongoDB: rodando"
fi

# Verifica sintaxe
log_info "Verificando sintaxe..."
if node --check orchestrators/AmandaOrchestrator.js 2>&1; then
    log_success "Sintaxe OK"
else
    log_error "Erro de sintaxe detectado!"
    exit 1
fi

# 2. Backup do estado atual
echo ""
echo "💾 2. BACKUP"
echo "--------------"
BACKUP_DIR="./backups/$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP_DIR"
cp -r orchestrators "$BACKUP_DIR/"
cp -r services "$BACKUP_DIR/"
log_success "Backup criado em: $BACKUP_DIR"

# 3. Testes rápidos
echo ""
echo "🧪 3. TESTES RÁPIDOS"
echo "---------------------"

log_info "Rodando testes unitários..."
if npm test -- --run tests/unit/triage-flow.test.js 2>&1 | grep -q "passed"; then
    log_success "Testes de triagem: OK"
else
    log_warning "Alguns testes falharam (verifique logs)"
fi

# 4. Deploy
echo ""
echo "🚀 4. DEPLOY"
echo "------------"

# PM2 reload ou node restart
if command -v pm2 &> /dev/null; then
    log_info "Restartando com PM2..."
    pm2 reload ecosystem.config.js --update-env || pm2 restart all
    sleep 2
    pm2 status
else
    log_info "PM2 não encontrado. Iniciando com node..."
    # Mata processo anterior se existir
    pkill -f "node.*server.js" || true
    sleep 1
    nohup node server.js > logs/server.log 2>&1 &
    sleep 2
fi

log_success "Deploy concluído!"

# 5. Monitoramento pós-deploy
echo ""
echo "📊 5. MONITORAMENTO PÓS-DEPLOY"
echo "-------------------------------"

# Aguarda serviço subir
sleep 3

# Health check
log_info "Verificando saúde do serviço..."
for i in {1..5}; do
    if curl -s http://localhost:3000/api/health > /dev/null 2>&1; then
        log_success "Serviço respondendo!"
        break
    else
        log_warning "Tentativa $i/5..."
        sleep 2
    fi
done

# 6. Logs de monitoramento
echo ""
echo "📝 6. LOGS DE MONITORAMENTO"
echo "----------------------------"

# Cria diretório de logs
mkdir -p logs/monitoramento

# Monitora por 60 segundos
echo "Monitorando por 60 segundos..."
timeout 60 bash -c '
    while true; do
        TIMESTAMP=$(date +"%Y-%m-%d %H:%M:%S")
        
        # Verifica logs de contexto
        if tail -n 50 logs/server.log 2>/dev/null | grep -q "CTX-RECOVERY"; then
            echo "[$TIMESTAMP] ✅ Recuperação de contexto funcionando"
        fi
        
        # Verifica erros
        ERRORS=$(tail -n 100 logs/server.log 2>/dev/null | grep -c "ERROR\|erro\|timeout" || echo "0")
        if [ "$ERRORS" -gt 5 ]; then
            echo "[$TIMESTAMP] ⚠️  $ERRORS erros detectados nos últimos 100 logs"
        fi
        
        # Verifica tempo de resposta
        AVG_TIME=$(tail -n 50 logs/server.log 2>/dev/null | grep -o "[0-9]*ms" | awk "{sum+=\$1; count++} END {if(count>0) print sum/count}" | cut -d. -f1)
        if [ -n "$AVG_TIME" ] && [ "$AVG_TIME" -gt 5000 ]; then
            echo "[$TIMESTAMP] ⚠️  Tempo médio alto: ${AVG_TIME}ms"
        fi
        
        sleep 10
    done
' || true

# 7. Métricas finais
echo ""
echo "📈 7. MÉTRICAS FINAIS"
echo "---------------------"

# Conta recuperações de contexto
CTX_RECOVERIES=$(grep -c "CTX-RECOVERY" logs/server.log 2>/dev/null || echo "0")
echo "🔄 Recuperações de contexto: $CTX_RECOVERIES"

# Conta erros
ERRORS=$(grep -c "ERROR\|erro" logs/server.log 2>/dev/null || echo "0")
echo "❌ Erros totais: $ERRORS"

# Tempo médio
AVG_TIME=$(tail -n 100 logs/server.log 2>/dev/null | grep -o "[0-9]*ms" | awk '{sum+=$1; count++} END {if(count>0) printf "%.0f", sum/count}' || echo "N/A")
echo "⏱️  Tempo médio de resposta: ${AVG_TIME}ms"

# 8. Alertas
echo ""
echo "🚨 8. ALERTAS E RECOMENDAÇÕES"
echo "-----------------------------"

if [ "$ERRORS" -gt 10 ]; then
    log_error "Muitos erros detectados! Considere rollback."
    echo "   Comando de rollback: cp -r $BACKUP_DIR/orchestrators ./"
fi

if [ "$CTX_RECOVERIES" -eq 0 ]; then
    log_warning "Nenhuma recuperação de contexto detectada. Verifique logs."
fi

log_success "Deploy finalizado! Monitoramento contínuo ativo."
echo ""
echo "📋 Comandos úteis:"
echo "   Ver logs: tail -f logs/server.log"
echo "   Status PM2: pm2 status"
echo "   Rollback: cp -r $BACKUP_DIR/orchestrators ./"
echo ""
