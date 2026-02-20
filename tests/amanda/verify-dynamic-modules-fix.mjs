#!/usr/bin/env node
/**
 * 🧪 VERIFICAÇÃO RÁPIDA: DYNAMIC_MODULES
 * 
 * Script standalone para verificar se o erro foi corrigido
 * Uso: node tests/amanda/verify-dynamic-modules-fix.mjs
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('🔍 Verificando correção de DYNAMIC_MODULES...\n');

// Lê o arquivo do orchestrator
const orchestratorPath = join(__dirname, '../../orchestrators/AmandaOrchestrator.js');
const content = readFileSync(orchestratorPath, 'utf-8');

let passed = 0;
let failed = 0;

// Teste 1: Verifica se DYNAMIC_MODULES está definido
console.log('Teste 1: DYNAMIC_MODULES está definido no arquivo?');
if (content.includes('const DYNAMIC_MODULES = {')) {
    console.log('  ✅ PASSOU - DYNAMIC_MODULES encontrado\n');
    passed++;
} else {
    console.log('  ❌ FALHOU - DYNAMIC_MODULES não encontrado\n');
    failed++;
}

// Teste 2: Verifica se tem conteúdo (não é vazio)
console.log('Teste 2: DYNAMIC_MODULES tem conteúdo?');
const match = content.match(/const DYNAMIC_MODULES = \{([\s\S]*?)\};/);
if (match && match[1].length > 100) {
    console.log(`  ✅ PASSOU - DYNAMIC_MODULES tem ${match[1].length} caracteres\n`);
    passed++;
} else {
    console.log('  ❌ FALHOU - DYNAMIC_MODULES parece vazio ou malformado\n');
    failed++;
}

// Teste 3: Verifica módulos críticos
console.log('Teste 3: Módulos críticos existem?');
const criticalModules = [
    'consultoriaModeContext',
    'acolhimentoModeContext',
    'valueProposition',
    'teaTriageContext',
    'priceObjection',
    'schedulingContext'
];

const missingModules = criticalModules.filter(mod => !content.includes(mod));
if (missingModules.length === 0) {
    console.log(`  ✅ PASSOU - Todos os ${criticalModules.length} módulos críticos encontrados\n`);
    passed++;
} else {
    console.log(`  ❌ FALHOU - Módulos faltando: ${missingModules.join(', ')}\n`);
    failed++;
}

// Teste 4: Verifica se useModule está definido
console.log('Teste 4: Função useModule está definida?');
if (content.includes('function useModule(key, ...args)')) {
    console.log('  ✅ PASSOU - useModule encontrado\n');
    passed++;
} else {
    console.log('  ❌ FALHOU - useModule não encontrado\n');
    failed++;
}

// Teste 5: Verifica se não há referência a DYNAMIC_MODULES antes da definição
console.log('Teste 5: Ordem correta (definição antes do uso)?');
const dynamicModulesIndex = content.indexOf('const DYNAMIC_MODULES = {');
const firstUseIndex = content.indexOf('DYNAMIC_MODULES.consultoriaModeContext');

if (dynamicModulesIndex !== -1 && firstUseIndex !== -1 && dynamicModulesIndex < firstUseIndex) {
    console.log('  ✅ PASSOU - DYNAMIC_MODULES definido antes de ser usado\n');
    passed++;
} else {
    console.log('  ❌ FALHOU - Possível problema de ordem\n');
    failed++;
}

// Resumo
console.log('='.repeat(50));
console.log(`Resultado: ${passed} passaram, ${failed} falharam`);
console.log('='.repeat(50));

if (failed > 0) {
    console.log('\n❌ TESTES FALHARAM - Correção incompleta!');
    process.exit(1);
} else {
    console.log('\n✅ TODOS OS TESTES PASSARAM!');
    console.log('O erro "DYNAMIC_MODULES is not defined" foi corrigido.');
    process.exit(0);
}
