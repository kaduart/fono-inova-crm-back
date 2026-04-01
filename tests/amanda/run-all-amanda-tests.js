#!/usr/bin/env node
// back/tests/amanda/run-all-amanda-tests.js
/**
 * Amanda Test Runner
 * 
 * Executa todos os testes da Amanda de forma organizada:
 * 1. Contract Tests (síncronos, determinísticos)
 * 2. Unit Tests (lógica isolada)
 * 3. Integration Tests (com Event Store)
 * 4. E2E Tests (fluxos completos - opcional)
 * 5. Stress Tests (carga)
 * 
 * Usage:
 *   node run-all-amanda-tests.js [options]
 * 
 * Options:
 *   --contracts    Roda apenas contract tests
 *   --unit         Roda apenas unit tests
 *   --integration  Roda apenas integration tests
 *   --e2e          Roda apenas E2E tests
 *   --stress       Roda apenas stress tests
 *   --all          Roda todos (padrão)
 *   --verbose      Mostra detalhes completos
 *   --fail-fast    Para no primeiro erro
 */

import { readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================================
// 🎯 CONFIGURAÇÃO
// ============================================================================

const CONFIG = {
  suites: {
    contracts: { path: 'contracts', pattern: /.test.js$/, timeout: 5000 },
    unit: { path: 'unit', pattern: /.test.js$/, timeout: 10000 },
    integration: { path: 'integration', pattern: /.test.js$/, timeout: 30000 },
    e2e: { path: 'e2e', pattern: /.test.js$/, timeout: 60000 },
    stress: { path: 'stress', pattern: /.test.js$/, timeout: 120000 }
  },
  colors: {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m'
  }
};

// ============================================================================
// 🖨️ UTILITÁRIOS DE OUTPUT
// ============================================================================

function print(message, color = 'reset') {
  const ci = process.argv.includes('--ci') || process.env.CI === 'true';
  if (ci) {
    // Modo CI: sem cores, formato simples
    console.log(message);
  } else {
    const c = CONFIG.colors;
    console.log(`${c[color]}${message}${c.reset}`);
  }
}

function printHeader(title) {
  console.log('');
  print('═══════════════════════════════════════════════════════════', 'cyan');
  print(`  ${title}`, 'bright');
  print('═══════════════════════════════════════════════════════════', 'cyan');
}

function printSuite(name, status, duration = null) {
  const ci = process.argv.includes('--ci') || process.env.CI === 'true';
  
  if (ci) {
    // Modo CI: formato parseável
    const statusStr = status.toUpperCase();
    const durationStr = duration ? ` [${duration}ms]` : '';
    console.log(`[${statusStr}] ${name}${durationStr}`);
  } else {
    const icon = status === 'running' ? '⏳' : 
                 status === 'passed' ? '✅' : 
                 status === 'failed' ? '❌' : 
                 status === 'skipped' ? '⏭️' : '⚪';
    
    const color = status === 'passed' ? 'green' : 
                  status === 'failed' ? 'red' : 
                  status === 'running' ? 'yellow' : 'dim';
    
    const durationStr = duration ? ` (${duration}ms)` : '';
    print(`${icon} ${name}${durationStr}`, color);
  }
}

// ============================================================================
// 📊 RESULTADOS
// ============================================================================

class TestResults {
  constructor() {
    this.suites = {};
    this.startTime = Date.now();
  }
  
  addSuite(name, results) {
    this.suites[name] = results;
  }
  
  get summary() {
    const total = Object.values(this.suites).reduce((sum, s) => sum + s.total, 0);
    const passed = Object.values(this.suites).reduce((sum, s) => sum + s.passed, 0);
    const failed = Object.values(this.suites).reduce((sum, s) => sum + s.failed, 0);
    const skipped = Object.values(this.suites).reduce((sum, s) => sum + s.skipped, 0);
    const duration = Date.now() - this.startTime;
    
    return { total, passed, failed, skipped, duration };
  }
  
  printSummary() {
    const s = this.summary;
    
    printHeader('RESUMO FINAL');
    print(`Total de testes: ${s.total}`, 'bright');
    print(`  ✅ Passaram: ${s.passed}`, 'green');
    print(`  ❌ Falharam: ${s.failed}`, s.failed > 0 ? 'red' : 'dim');
    print(`  ⏭️ Pulados: ${s.skipped}`, 'yellow');
    print(`  ⏱️  Duração total: ${s.duration}ms`, 'cyan');
    
    const successRate = s.total > 0 ? ((s.passed / s.total) * 100).toFixed(1) : 0;
    print(`  📊 Taxa de sucesso: ${successRate}%`, successRate >= 90 ? 'green' : successRate >= 70 ? 'yellow' : 'red');
    
    if (s.failed > 0) {
      print('', 'red');
      print('⚠️  ALGUNS TESTES FALHARAM!', 'red');
      print('Verifique os detalhes acima.', 'dim');
      return 1;
    }
    
    print('', 'green');
    print('🎉 TODOS OS TESTES PASSARAM!', 'green');
    return 0;
  }
}

// ============================================================================
// 🏃 RUNNER
// ============================================================================

async function runTestFile(filePath, timeout) {
  return new Promise(async (resolve) => {
    const startTime = Date.now();
    let resolved = false;
    
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve({
          total: 1,
          passed: 0,
          failed: 1,
          skipped: 0,
          error: `Timeout (${timeout}ms)`,
          duration: Date.now() - startTime
        });
      }
    }, timeout);
    
    try {
      // Importa e executa o módulo de teste
      const testModule = await import(filePath + '?t=' + Date.now()); // Cache bust
      
      let total = 0, passed = 0, failed = 0;
      
      // PRIORIDADE 1: Se o módulo exporta run(), usa ele (roda tudo de uma vez)
      if (typeof testModule.run === 'function') {
        const result = await testModule.run();
        total = result.total || 1;
        passed = result.passed || (result.success ? 1 : 0);
        failed = result.failed || (result.success ? 0 : 1);
      }
      // PRIORIDADE 2: Se não tem run() mas tem tests[], itera individualmente
      else if (testModule.tests && Array.isArray(testModule.tests)) {
        for (const test of testModule.tests) {
          if (typeof test.run === 'function') {
            total++;
            try {
              const result = await test.run();
              if (result && result.success) {
                passed++;
              } else {
                failed++;
              }
            } catch (e) {
              failed++;
            }
          }
        }
      }
      
      clearTimeout(timer);
      if (!resolved) {
        resolved = true;
        resolve({
          total,
          passed,
          failed,
          skipped: 0,
          duration: Date.now() - startTime
        });
      }
    } catch (error) {
      clearTimeout(timer);
      if (!resolved) {
        resolved = true;
        resolve({
          total: 1,
          passed: 0,
          failed: 1,
          skipped: 0,
          error: error.message,
          stack: error.stack,
          duration: Date.now() - startTime
        });
      }
    }
  });
}

async function runSuite(suiteName, config, options) {
  const suitePath = join(__dirname, config.path);
  
  if (!existsSync(suitePath)) {
    printSuite(suiteName, 'skipped');
    return { total: 0, passed: 0, failed: 0, skipped: 1 };
  }
  
  printSuite(suiteName, 'running');
  const startTime = Date.now();
  
  const files = readdirSync(suitePath)
    .filter(f => config.pattern.test(f))
    .map(f => join(suitePath, f));
  
  let total = 0;
  let passed = 0;
  let failed = 0;
  let errors = [];
  
  for (const file of files) {
    const result = await runTestFile(file, config.timeout);
    
    // Acumula resultados de todos os testes no arquivo
    total += result.total || 1;
    passed += result.passed || 0;
    failed += result.failed || 0;
    
    if (result.failed > 0 && result.error) {
      errors.push({ file, error: result.error });
      if (!options.ci) {
        print(`  ❌ ${file.replace(__dirname, '')}: ${result.error}`, 'red');
      }
    } else if (options.verbose) {
      print(`  ✅ ${file.replace(__dirname, '')} (${result.passed}/${result.total})`, 'dim');
    }
    
    if (options.failFast && failed > 0) {
      break;
    }
  }
  
  const duration = Date.now() - startTime;
  const status = failed === 0 ? 'passed' : 'failed';
  
  printSuite(`${suiteName} (${passed}/${total})`, status, duration);
  
  return {
    total,
    passed,
    failed,
    skipped: 0,
    errors,
    duration
  };
}

// ============================================================================
// 🎬 MAIN
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const options = {
    contracts: args.includes('--contracts'),
    unit: args.includes('--unit'),
    integration: args.includes('--integration'),
    e2e: args.includes('--e2e'),
    stress: args.includes('--stress'),
    all: args.includes('--all') || args.filter(a => !a.startsWith('--') && !['--ci', '--verbose', '--fail-fast'].includes(a)).length === 0,
    verbose: args.includes('--verbose'),
    failFast: args.includes('--fail-fast'),
    ci: args.includes('--ci') || process.env.CI === 'true'
  };
  
  // Se nenhum suite específico, roda todos
  const runAll = options.all || 
    (!options.contracts && !options.unit && !options.integration && !options.e2e && !options.stress);
  
  printHeader('AMANDA TEST RUNNER');
  print(`Ambiente: ${process.env.NODE_ENV || 'development'}`, 'dim');
  print(`Modo: ${options.verbose ? 'verbose' : 'normal'}`, 'dim');
  print(`Fail-fast: ${options.failFast ? 'sim' : 'não'}`, 'dim');
  
  const results = new TestResults();
  
  // 1. CONTRACT TESTS (mais rápidos, mais determinísticos)
  if (runAll || options.contracts) {
    const suite = await runSuite('Contract Tests', CONFIG.suites.contracts, options);
    results.addSuite('contracts', suite);
    if (options.failFast && suite.failed > 0) {
      return results.printSummary();
    }
  }
  
  // 2. UNIT TESTS
  if (runAll || options.unit) {
    const suite = await runSuite('Unit Tests', CONFIG.suites.unit, options);
    results.addSuite('unit', suite);
    if (options.failFast && suite.failed > 0) {
      return results.printSummary();
    }
  }
  
  // 3. INTEGRATION TESTS
  if (runAll || options.integration) {
    const suite = await runSuite('Integration Tests', CONFIG.suites.integration, options);
    results.addSuite('integration', suite);
    if (options.failFast && suite.failed > 0) {
      return results.printSummary();
    }
  }
  
  // 4. E2E TESTS
  if (runAll || options.e2e) {
    print('', 'yellow');
    print('⚠️  E2E tests podem ser flaky (dependem de estado externo)', 'yellow');
    const suite = await runSuite('E2E Tests', CONFIG.suites.e2e, options);
    results.addSuite('e2e', suite);
    if (options.failFast && suite.failed > 0) {
      return results.printSummary();
    }
  }
  
  // 5. STRESS TESTS
  if (runAll || options.stress) {
    const suite = await runSuite('Stress Tests', CONFIG.suites.stress, options);
    results.addSuite('stress', suite);
  }
  
  return results.printSummary();
}

// Roda se chamado diretamente
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(exitCode => process.exit(exitCode))
    .catch(err => {
      console.error('💥 Erro fatal:', err);
      process.exit(1);
    });
}

export { runSuite, TestResults };
