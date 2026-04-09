#!/bin/bash
# 📋 Script de Verificação e Proteção para Produção
# Executa diagnóstico → reconciliação → proteções
# USO: ./VERIFICAR_E_PROTEGER.sh [--skip-diagnose] [--skip-reconcile] [--skip-indexes]

set -e

echo "========================================"
echo "📋 VERIFICAÇÃO E PROTEÇÃO DO SISTEMA"
echo "========================================"
echo ""

# Parse arguments
SKIP_DIAGNOSE=false
SKIP_RECONCILE=false
SKIP_INDEXES=false

for arg in "$@"; do
    case $arg in
        --skip-diagnose) SKIP_DIAGNOSE=true ;;
        --skip-reconcile) SKIP_RECONCILE=true ;;
        --skip-indexes) SKIP_INDEXES=true ;;
    esac
done

# ============================================
# ETAPA 1: DIAGNÓSTICO
# ============================================
if [ "$SKIP_DIAGNOSE" = false ]; then
    echo "🔍 ETAPA 1: Executando diagnóstico..."
    echo "========================================"
    node diagnose-system-health.js
    echo ""
    
    read -p "⚠️  Verifique o relatório acima. Continuar? (s/N): " confirm
    if [[ ! $confirm =~ ^[Ss]$ ]]; then
        echo "⛔ Cancelado pelo usuário"
        exit 1
    fi
    echo ""
fi

# ============================================
# ETAPA 2: RECONCILIAÇÃO (DRY RUN)
# ============================================
if [ "$SKIP_RECONCILE" = false ]; then
    echo "🔧 ETAPA 2a: Reconciliação (DRY RUN)..."
    echo "========================================"
    DRY_RUN=true node reconcile-system-data.js
    echo ""
    
    read -p "⚠️  Verifique o que será corrigido. Executar reconciliação de verdade? (s/N): " confirm
    if [[ $confirm =~ ^[Ss]$ ]]; then
        echo ""
        echo "🔧 ETAPA 2b: Executando reconciliação real..."
        DRY_RUN=false node reconcile-system-data.js
    else
        echo "⏭️  Reconciliação pulada"
    fi
    echo ""
fi

# ============================================
# ETAPA 3: INDEXES (DRY RUN)
# ============================================
if [ "$SKIP_INDEXES" = false ]; then
    echo "🛡️  ETAPA 3a: Verificando indexes (DRY RUN)..."
    echo "========================================"
    DRY_RUN=true node add-unique-indexes.js
    echo ""
    
    read -p "⚠️  Verifique os indexes. Criar de verdade? (s/N): " confirm
    if [[ $confirm =~ ^[Ss]$ ]]; then
        echo ""
        echo "🛡️  ETAPA 3b: Criando indexes..."
        DRY_RUN=false node add-unique-indexes.js
    else
        echo "⏭️  Criação de indexes pulada"
    fi
    echo ""
fi

# ============================================
# RELATÓRIO FINAL
# ============================================
echo "========================================"
echo "✅ PROCESSO CONCLUÍDO"
echo "========================================"
echo ""
echo "📋 Resumo:"
echo "  - Diagnóstico: $([ "$SKIP_DIAGNOSE" = true ] && echo 'PULADO' || echo '✅ EXECUTADO')"
echo "  - Reconciliação: $([ "$SKIP_RECONCILE" = true ] && echo 'PULADO' || echo '✅ EXECUTADO')"
echo "  - Indexes: $([ "$SKIP_INDEXES" = true ] && echo 'PULADO' || echo '✅ EXECUTADO')"
echo ""
echo "🧪 PRÓXIMOS PASSOS:"
echo "  1. Rodar testes unitários: npm test"
echo "  2. Rodar testes de integração: npm run test:integration"
echo "  3. Rodar testes E2E: npm run test:e2e"
echo "  4. Deploy em staging"
echo "  5. Monitorar logs de produção"
echo ""
