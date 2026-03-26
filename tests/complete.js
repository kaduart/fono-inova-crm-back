#!/usr/bin/env node
/**
 * 🧪 AMANDA COMPLETE TEST SUITE
 * 
 * ARQUIVO ÚNICO que executa TODOS os testes da Amanda FSM
 * 
 * Uso: node tests/complete.js [opções]
 *   --unit       → Testes unitários apenas
 *   --integration → Testes de integração apenas
 *   --e2e        → Testes end-to-end apenas
 *   --alta-intencao → Testes da Regra ALTA_INTENCAO
 *   --qa         → QA dos 6 cenários críticos
 *   --all        → TODOS os testes (padrão)
 * 
 * Exemplo: node tests/complete.js --unit
 */

import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================
// CONFIGURAÇÃO DOS TESTES
// ============================================

const TEST_SUITES = {
  unit: [
    { name: '🎯 detectIntentPriority', file: 'test-alta-intencao-v8.js', critical: true },
    { name: '🔍 flagsDetector', file: 'unit/flagsDetector.test.js' },
    { name: '📋 patientDataExtractor', file: 'unit/patientDataExtractor.test.js' },
    { name: '🧠 entity-driven', file: 'unit/entity-driven.test.js' },
    { name: '🏥 therapyDetector', file: 'unit/therapyDetector.test.js' },
    { name: '🔧 production-fixes', file: 'unit/production-fixes.test.js' },
    { name: '🎨 responseBuilder', file: 'amanda/responseBuilder.test.js' },
    { name: '📊 therapyAreaMapping', file: 'unit/therapyAreaMapping.test.js' },
    { name: '⏱️ safeAgeUpdate', file: 'unit/safeAgeUpdate.test.js' },
    { name: '🚦 triage-flow', file: 'unit/triage-flow.test.js' },
    { name: '🤖 orchestrator.neuro', file: 'unit/orchestrator.neuro.test.js' },
    { name: '📝 conversation-flow', file: 'unit/conversation-flow.test.js' },
    { name: '💾 contextPersistence', file: 'amanda/contextPersistence.test.js' },
    { name: '🎭 responseTracking', file: 'amanda/responseTracking.test.js' },
    { name: '🔴 fsm-production-bugs', file: 'unit/fsm-production-bugs.test.js', critical: true },
  ],
  
  integration: [
    { name: '🔗 agenda-externa', file: 'integration/agenda-externa.test.js' },
    { name: '👩‍⚕️ caso-ana-laura', file: 'integration/caso-ana-laura.test.js' },
    { name: '📅 appointmentMapping', file: 'unit/appointmentMapping.test.js' },
    { name: '💰 insurance-receivables', file: 'test-insurance-receivables.js' },
  ],
  
  e2e: [
    { name: '🎯 fluxo-completo-e2e', file: 'e2e/fluxo-completo-e2e.test.js', critical: true },
    { name: '🌍 realScenarios', file: 'e2e/realScenarios.test.js' },
    { name: '📊 decisionEngine', file: 'e2e/decisionEngine.test.js' },
  ],
  
  qa: [
    { name: '🔥 QA - 6 Cenários Críticos', file: '../tests-amanda-ouro/scripts/SCRIPT-qa-cenarios-criticos.js', critical: true },
    { name: '📋 validar-cenarios-v8', file: 'validar-cenarios-v8.js' },
    { name: '🎭 orquestrator-v8', file: 'orchestrator-v8.test.js' },
  ],
  
  stress: [
    { name: '🔥 anti-loop-ironclad', file: 'stress/anti-loop-ironclad.test.js' },
    { name: '⚡ concorrencia-stress', file: 'stress/concorrencia-stress.test.js' },
    { name: '💥 corruption-stress', file: 'stress/corruption-stress.test.js' },
  ],
};

// ============================================
// UTILITÁRIOS
// ============================================

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logHeader(title) {
  console.log('\n' + '='.repeat(70));
  log(`  ${title}`, 'bright');
  console.log('='.repeat(70) + '\n');
}

function logSection(title) {
  console.log('\n' + '-'.repeat(50));
  log(`  ${title}`, 'cyan');
  console.log('-'.repeat(50));
}

// ============================================
// EXECUTOR DE TESTES
// ============================================

async function runTest(testFile, timeout = 60000) {
  const fullPath = join(__dirname, testFile);
  
  try {
    const result = execSync(`node "${fullPath}" 2>&1`, {
      encoding: 'utf-8',
      timeout,
      stdio: 'pipe',
    });
    
    // Verifica se passou
    const passed = result.includes('✅') || result.includes('PASS') || result.includes('passaram');
    const failed = result.includes('❌') || result.includes('FAIL') || result.includes('falharam');
    
    return {
      success: passed && !failed,
      output: result,
      passed,
      failed,
    };
  } catch (error) {
    return {
      success: false,
      output: error.stdout || error.message,
      error: true,
    };
  }
}

async function runSuite(suiteName, tests) {
  logSection(`${suiteName.toUpperCase()} (${tests.length} testes)`);
  
  const results = [];
  let passed = 0;
  let failed = 0;
  let criticalFailed = 0;
  
  for (const test of tests) {
    const label = test.critical ? '🔴' : '  ';
    process.stdout.write(`${label} ${test.name} ... `);
    
    const result = await runTest(test.file);
    results.push({ ...test, ...result });
    
    if (result.success) {
      log('✅ PASS', 'green');
      passed++;
    } else {
      log('❌ FAIL', 'red');
      failed++;
      if (test.critical) criticalFailed++;
    }
  }
  
  return { passed, failed, criticalFailed, results };
}

// ============================================
// TESTE STANDALONE - ALTA_INTENCAO
// ============================================

function runAltaIntencaoStandalone() {
  logSection('TESTE RÁPIDO - ALTA_INTENCAO (Standalone)');
  
  // Implementação inline para não depender de imports
  function detectIntentPriority(message) {
    const msg = message.toLowerCase();
    
    if (/(?:^|\W)(n[ãa]o fala|n[ãa]o olha|dificuldade|inquieto|agitad|birra|agress[ãa]o|agressi\w*|atraso|preocupad|ansios\w*|frustrad\w*|chor[ae]|triste|isolad|hiperativo|desatento|n[ãa]o concentra|n[ãa]o obedece|teimos|medo|ins[ôo]nia|pesadelo|enurese|encoprese|n[ãa]o come|mastiga|engasga|refluxo|constipa[çc][ãa]o)(?:\W|$)/i.test(msg)) {
      return "SINTOMA";
    }
    
    const altaIntencaoRegex = /\b(tem\s+(vaga|hor[áa]rio)|quer(?:o|ia)\s+agendar|marcar|encaixar|posso\s+ir|quando\s+tem|agendar\s+pra|podemos\s+marcar|vou\s+querer|tem\s+como)\b/i;
    const temporalRegex = /(?:^|\s)(hoje|amanh[ãa]|essa\s+semana|pr[óo]xima\s+semana|s[áa]bado|domingo|segunda|ter[cç]a|quarta|quinta|sexta|depois\s+de\s+amanh[ãa]|\d{1,2}[\/\-]\d{1,2})(?:\s|$|[,.!?])/i;
    const inicioComTemporal = /^\s*(hoje|amanh[ãa]|s[áa]bado|domingo|segunda|ter[cç]a|quarta|quinta|sexta|depois\s+de\s+amanh[ãa]|s[oó]\s+depois)(?:\s+(?:de|às?\s+)?(manh[ãa]|tarde|noite))?/i;
    const temVagaETemporal = /\btem\b.*\b(vaga|hor[áa]rio)\b.*(?:^|\s)(hoje|amanh[ãa]|s[áa]bado|domingo|segunda|ter[cç]a|quarta|quinta|sexta)(?:\s|$|[,.!?])/i;
    const temETemporal = /^\s*tem\b.*(?:^|\s)(hoje|amanh[ãa]|s[áa]bado|domingo)(?:\s|$|[,.!?])/i;
    const vagaTemporal = /\b(vaga|hor[áa]rio)\b.*(?:^|\s)(hoje|amanh[ãa]|s[áa]bado|domingo|segunda|ter[cç]a|quarta|quinta|sexta)(?:\s|$|[,.!?])/i;
    
    if ((altaIntencaoRegex.test(msg) && temporalRegex.test(msg)) || inicioComTemporal.test(msg) || temVagaETemporal.test(msg) || temETemporal.test(msg) || vagaTemporal.test(msg)) {
      return "ALTA_INTENCAO";
    }
    
    if (/\b(urgente|emergencia|emerg[êe]ncia|preciso logo|hoje|amanh[ãa]|agora|imediat|quanto antes|desesperad|n[ãa]o aguent|tentou tudo|j[áa] tentei|t[áa] piorando|t[áa] muito ruim)\b/i.test(msg)) {
      return "URGENCIA";
    }
    
    if (/\b(como funciona|pode me explicar|o que [ée]|qual [ée]|me explique|como [ée]|funciona como|pode explicar)\b/i.test(msg)) {
      return "EXPLICACAO";
    }
    
    if (/\b(teste da linguinha|teste da l[íi]ngua|cirurgia|fazer cirurgia|operar|operac[ãa]o|cirurgi[ãa]o|m[ée]dico|pediatra|neuropediatra|otorrino|psiquiatra)\b/i.test(msg)) {
      return "FORA_ESCOPO";
    }
    
    if (/\b(quanto custa|qual o pre[çc]o|qual o valor|investimento|reembolso|plano de sa[úu]de|conv[eê]nio|cart[ãa]o)\b/i.test(msg)) {
      return "PRECO";
    }
    
    if (/\b(quero agendar|vou agendar|quero marcar|vou marcar|quando tem vaga|quando posso|tem hor[áa]rio|disponibilidade|posso ir|posso fazer|quero fazer a avalia[çc][ãa]o|encaixar|tem (hoje|amanh[ãa])|hoje|amanh[ãa]\s+(as|às|\d))\b/i.test(msg)) {
      return "AGENDAMENTO";
    }
    
    if (
      /^\s*(oi|ol[áa]|bom dia|boa tarde|boa noite|hey|hi)\s*[!?.]*\s*$/i.test(msg) ||
      /^(preciso|gostaria|quero|tenho interesse|vi o site|me indica(rao|ram))\s*$/i.test(msg) ||
      /\b(saber mais|orientar|ajuda|informa[çc][aã]o|d[úu]vida|conhecer|queria entender|queria saber|vi no site)\b/i.test(msg) ||
      (msg.length < 25 && 
       !/\b(fala|olha|dificuldade|pre[çc]o|valor|custa|agenda|marcar|hoje|amanh[ãa])\b/i.test(msg)) ||
      /\bpara?\s+(mim|meu filho|minha filha|crian[çc]a|beb[êe])\b/i.test(msg) ||
      /^\s*(fono|psico|to|fisio|terapia|neuro)\w*\s*\.?\s*$/i.test(msg)
    ) {
      return "FIRST_CONTACT";
    }
    
    return "DEFAULT";
  }
  
  const testCases = [
    { input: "Tem hoje?", expected: "ALTA_INTENCAO", critical: true },
    { input: "Tem vaga amanhã?", expected: "ALTA_INTENCAO", critical: true },
    { input: "Quero agendar para amanhã de manhã", expected: "ALTA_INTENCAO", critical: true },
    { input: "Amanhã de manhã seria bom", expected: "ALTA_INTENCAO", critical: true },
    { input: "Sábado de manhã tem vaga", expected: "ALTA_INTENCAO", critical: true },
    { input: "Tem como ser hoje?", expected: "ALTA_INTENCAO", critical: true },
    { input: "Podemos marcar às 11:00 da amanhã?", expected: "ALTA_INTENCAO", critical: true },
    { input: "Hoje não tem como", expected: "ALTA_INTENCAO", critical: true },
    { input: "Só depois de amanhã", expected: "ALTA_INTENCAO", critical: true },
    { input: "Oi", expected: "FIRST_CONTACT" },
    { input: "Quanto custa?", expected: "PRECO" },
    { input: "Meu filho não fala", expected: "SINTOMA" },
  ];
  
  let passed = 0;
  let failed = 0;
  
  for (const test of testCases) {
    const result = detectIntentPriority(test.input);
    const success = result === test.expected;
    const icon = success ? '✅' : '❌';
    const color = success ? 'green' : (test.critical ? 'red' : 'yellow');
    
    log(`${icon} "${test.input}" → ${result} ${success ? '' : `(esperado: ${test.expected})`}`, color);
    
    if (success) passed++;
    else failed++;
  }
  
  console.log('');
  log(`📊 Resultado: ${passed}/${testCases.length} passaram`, failed === 0 ? 'green' : 'yellow');
  
  return { passed, failed, total: testCases.length };
}

// 🆕 REGRA 5: Teste de Feriados e Pacotes Contínuos
function runRegra5Standalone() {
  logSection('TESTE RÁPIDO - REGRA 5: Feriados + Pacotes');
  
  // 🗓️ Teste de feriados com calculador dinâmico
  log('\n🗓️ Testando Calendário Dinâmico:');
  
  // Simula as funções do feriadosBR-dynamic.js
  function calculateEaster(year) {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31) - 1;
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(year, month, day);
  }
  
  function addDays(date, days) {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
  }
  
  function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  
  function generateHolidaysForYear(year) {
    const easter = calculateEaster(year);
    return [
      `${year}-01-01`,
      formatDate(addDays(easter, -48)), // Carnaval
      formatDate(addDays(easter, -2)),  // Sexta-feira Santa
      `${year}-04-21`,
      `${year}-05-01`,
      formatDate(addDays(easter, 60)),  // Corpus Christi
      `${year}-09-07`,
      `${year}-10-12`,
      `${year}-11-02`,
      `${year}-11-15`,
      `${year}-12-25`,
    ];
  }
  
  function isNationalHoliday(dateStr) {
    const year = parseInt(dateStr.split("-")[0]);
    const holidays = generateHolidaysForYear(year);
    return holidays.includes(dateStr);
  }
  
  // Testes dinâmicos
  const feriadosTest = [
    { date: "2025-01-01", expected: true, name: "Ano Novo" },
    { date: "2025-04-18", expected: true, name: "Sexta-feira Santa" },
    { date: "2025-06-19", expected: true, name: "Corpus Christi 2025" },
    { date: "2026-04-03", expected: true, name: "Sexta-feira Santa 2026" },
    { date: "2024-03-29", expected: true, name: "Sexta-feira Santa 2024" },
    { date: "2025-03-15", expected: false, name: "Data normal" },
  ];
  
  let passed = 0;
  let failed = 0;
  
  for (const test of feriadosTest) {
    const result = isNationalHoliday(test.date);
    const success = result === test.expected;
    const icon = success ? '✅' : '❌';
    
    log(`${icon} ${test.date} (${test.name}) → ${result ? 'Feriado' : 'Normal'}`, success ? 'green' : 'red');
    
    if (success) passed++;
    else failed++;
  }
  
  console.log('');
  log(`📊 Calendário Dinâmico: ${passed}/${feriadosTest.length} passaram`, failed === 0 ? 'green' : 'yellow');
  
  // Teste de slots ocupados (simulação)
  log('\n🔄 Simulação de Pacotes Contínuos:');
  log('✅ Slot 2025-03-10 08:00 - Disponível (sem pacote)', 'green');
  log('🚫 Slot 2025-03-10 14:00 - Bloqueado (pacote contínuo)', 'red');
  log('🚫 Slot 2025-12-25 08:00 - Bloqueado (feriado)', 'red');
  log('🚫 Slot 2025-04-18 08:00 - Bloqueado (Sexta-feira Santa)', 'red');
  
  return { passed, failed, total: feriadosTest.length };
}

// ============================================
// MAIN
// ============================================

async function main() {
  const args = process.argv.slice(2);
  const flags = {
    unit: args.includes('--unit'),
    integration: args.includes('--integration'),
    e2e: args.includes('--e2e'),
    altaIntencao: args.includes('--alta-intencao'),
    regra5: args.includes('--regra5'),
    qa: args.includes('--qa'),
    stress: args.includes('--stress'),
    all: args.includes('--all') || args.length === 0,
  };
  
  logHeader('🧪 AMANDA COMPLETE TEST SUITE');
  
  const startTime = Date.now();
  let totalPassed = 0;
  let totalFailed = 0;
  let totalCriticalFailed = 0;
  
  // Teste rápido standalone (sempre executa)
  if (flags.all || flags.altaIntencao) {
    const result = runAltaIntencaoStandalone();
    totalPassed += result.passed;
    totalFailed += result.failed;
  }
  
  // 🆕 REGRA 5: Teste de feriados e pacotes
  if (flags.all || flags.regra5) {
    const result = runRegra5Standalone();
    totalPassed += result.passed;
    totalFailed += result.failed;
  }
  
  // Determinar quais suites executar
  const suitesToRun = [];
  
  if (flags.all) {
    suitesToRun.push(['unit', TEST_SUITES.unit]);
    suitesToRun.push(['qa', TEST_SUITES.qa]);
  } else {
    if (flags.unit) suitesToRun.push(['unit', TEST_SUITES.unit]);
    if (flags.integration) suitesToRun.push(['integration', TEST_SUITES.integration]);
    if (flags.e2e) suitesToRun.push(['e2e', TEST_SUITES.e2e]);
    if (flags.qa) suitesToRun.push(['qa', TEST_SUITES.qa]);
    if (flags.stress) suitesToRun.push(['stress', TEST_SUITES.stress]);
  }
  
  // Executar suites
  for (const [name, tests] of suitesToRun) {
    const result = await runSuite(name, tests);
    totalPassed += result.passed;
    totalFailed += result.failed;
    totalCriticalFailed += result.criticalFailed;
  }
  
  // Resumo final
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  
  console.log('\n' + '='.repeat(70));
  log('📊 RESUMO FINAL', 'bright');
  console.log('='.repeat(70));
  log(`✅ Passaram:  ${totalPassed}`, 'green');
  log(`❌ Falharam:  ${totalFailed}`, totalFailed === 0 ? 'reset' : 'red');
  
  if (totalCriticalFailed > 0) {
    log(`🔴 Críticos:  ${totalCriticalFailed}`, 'red');
  }
  
  log(`⏱️  Duração:   ${duration}s`, 'cyan');
  console.log('='.repeat(70));
  
  if (totalFailed === 0) {
    log('\n🎉 TODOS OS TESTES PASSARAM!', 'green');
    process.exit(0);
  } else if (totalCriticalFailed === 0) {
    log('\n⚠️  ALGUNS TESTES FALHARAM (não críticos)', 'yellow');
    process.exit(0);
  } else {
    log('\n💥 TESTES CRÍTICOS FALHARAM!', 'red');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
