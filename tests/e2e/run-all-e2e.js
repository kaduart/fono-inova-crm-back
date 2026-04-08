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
    name: '🔴 CRÍTICO: Complete deve atualizar Caixa',
    file: 'tests/e2e/complete-to-cash.e2e.test.js',
    description: 'INVARIANTE: Se payment.status=paid, valor DEVE estar no daily closing'
  },
  {
    name: '🔴 CRÍTICO: Criação de Pacote de Convênio',
    file: 'tests/e2e/convenio-package-flow.e2e.test.js',
    description: 'Valida POST /api/convenio-packages cria payments com campos corretos'
  },
  {
    name: 'Package Flow E2E',
    file: 'tests/e2e/v2/package-flow.v2.e2e.test.js',
    description: 'Fluxo completo: Cria pacote → Agenda → Completa → Valida'
  },
  {
    name: 'Full Flow V2 E2E', 
    file: 'tests/e2e/v2/full-flow.v2.e2e.test.js',
    description: 'Fluxo de paciente e projeção'
  },
  {
    name: 'Appointment Payment Flow E2E',
    file: 'tests/e2e/appointment-payment-flow.e2e.test.js',
    description: 'Fluxo de agendamento com pagamento'
  },
  {
    name: 'Clinical to Billing E2E',
    file: 'tests/e2e/clinical-to-billing.e2e.test.js',
    description: 'Integração clínico-financeiro'
  }
];

console.log('🧪 E2E TEST SUITE - CRM FonoInova\n');
console.log('=' .repeat(60));

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
  }
  
  console.log('-'.repeat(60));
}

console.log('\n' + '='.repeat(60));
console.log('📊 RESUMO FINAL');
console.log(`   ✅ Passaram: ${passed}`);
console.log(`   ❌ Falharam: ${failed}`);
console.log(`   📈 Total: ${tests.length}`);

if (failed === 0) {
  console.log('\n🎉 TODOS OS TESTES PASSARAM!');
} else {
  console.log('\n⚠️  ALGUNS TESTES FALHARAM - VERIFIQUE OS ERROS ACIMA');
}

console.log('='.repeat(60));

process.exit(failed > 0 ? 1 : 0);
