#!/usr/bin/env node
/**
 * Script para rodar todos os testes E2E
 * 
 * Uso: node tests/e2e/run-all-e2e.js
 */

import { execSync } from 'child_process';
import process from 'process';

const tests = [
  {
    name: 'Package Flow E2E',
    file: 'tests/e2e/v2/package-flow.v2.e2e.test.js',
    description: 'Fluxo completo: Cria pacote → Agenda → Completa → Valida'
  },
  {
    name: 'Full Flow V2 E2E', 
    file: 'tests/e2e/v2/full-flow.v2.e2e.test.js',
    description: 'Fluxo de paciente e projeção'
  }
];

console.log('🧪 E2E TEST SUITE\n');
console.log('=' .repeat(50));

let passed = 0;
let failed = 0;

for (const test of tests) {
  console.log(`\n📋 ${test.name}`);
  console.log(`   ${test.description}`);
  console.log(`   Arquivo: ${test.file}`);
  console.log('');
  
  try {
    execSync(`npx vitest run ${test.file} --reporter=verbose`, {
      stdio: 'inherit',
      cwd: process.cwd()
    });
    passed++;
    console.log(`\n✅ ${test.name}: PASSOU`);
  } catch (error) {
    failed++;
    console.log(`\n❌ ${test.name}: FALHOU`);
    console.error(error.message);
  }
  
  console.log('-'.repeat(50));
}

console.log('\n' + '='.repeat(50));
console.log('📊 RESUMO');
console.log(`   ✅ Passaram: ${passed}`);
console.log(`   ❌ Falharam: ${failed}`);
console.log(`   📈 Total: ${tests.length}`);
console.log('='.repeat(50));

process.exit(failed > 0 ? 1 : 0);
