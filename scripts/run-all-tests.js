#!/usr/bin/env node
/**
 * 🧪 Script para rodar TODOS os testes do projeto
 * 
 * Executa sequencialmente:
 * 1. Testes Unitários
 * 2. Testes Amanda  
 * 3. Testes de Integração
 * 4. Testes E2E
 * 
 * Não para no primeiro erro - executa tudo e gera relatório final
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m'
};

const results = [];

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function runTests(name, configFile = null) {
  return new Promise((resolve) => {
    log(`\n${'='.repeat(70)}`, 'cyan');
    log(`🧪 EXECUTANDO: ${name}`, 'bright');
    log(`${'='.repeat(70)}\n`, 'cyan');

    const args = ['vitest', 'run'];
    if (configFile) {
      args.push('--config', configFile);
    }

    const startTime = Date.now();
    const child = spawn('npx', args, {
      cwd: process.cwd(),
      stdio: 'inherit',
      shell: true
    });

    child.on('close', (code) => {
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      const success = code === 0;
      
      results.push({
        name,
        success,
        code,
        duration
      });

      resolve(success);
    });
  });
}

async function main() {
  log('\n');
  log('╔════════════════════════════════════════════════════════════════════╗', 'cyan');
  log('║              🚀 RODANDO TODOS OS TESTES DO PROJETO                ║', 'cyan');
  log('╚════════════════════════════════════════════════════════════════════╝', 'cyan');
  log('\n');

  const startTotal = Date.now();

  // 1. Testes Unitários
  await runTests('Testes Unitários', null);

  // 2. Testes Amanda
  await runTests('Testes Amanda', 'vitest.config.amanda.js');

  // 3. Testes Integração
  await runTests('Testes de Integração', 'vitest.config.integration.js');

  // 4. Testes E2E
  await runTests('Testes E2E', 'vitest.config.e2e.js');

  const totalDuration = ((Date.now() - startTotal) / 1000).toFixed(2);

  // Relatório Final
  log('\n');
  log('╔════════════════════════════════════════════════════════════════════╗', 'cyan');
  log('║                    📊 RELATÓRIO FINAL                             ║', 'cyan');
  log('╚════════════════════════════════════════════════════════════════════╝', 'cyan');
  log('\n');

  results.forEach((result, index) => {
    const icon = result.success ? '✅' : '❌';
    const status = result.success ? 'PASSOU' : 'FALHOU';
    const color = result.success ? 'green' : 'red';
    
    log(`${index + 1}. ${icon} ${result.name.padEnd(30)} | ${status.padEnd(10)} | ${result.duration}s`, color);
  });

  const passed = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;

  log('\n');
  log(`${'─'.repeat(70)}`, 'gray');
  log(`📈 Total: ${results.length} suites de teste`, 'bright');
  log(`✅ Passaram: ${passed}`, 'green');
  log(`❌ Falharam: ${failed}`, failed > 0 ? 'red' : 'green');
  log(`⏱️  Tempo Total: ${totalDuration}s`, 'yellow');
  log(`${'─'.repeat(70)}`, 'gray');

  if (failed > 0) {
    log('\n⚠️  ALGUNS TESTES FALHARAM!', 'red');
    log('Verifique os logs acima para mais detalhes.\n', 'yellow');
    process.exit(1);
  } else {
    log('\n🎉 TODOS OS TESTES PASSARAM!\n', 'green');
    process.exit(0);
  }
}

main().catch(err => {
  log(`\n❌ Erro ao executar testes: ${err.message}\n`, 'red');
  process.exit(1);
});
