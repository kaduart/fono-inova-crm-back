#!/usr/bin/env node
/**
 * 🧪 RUNNER DE TODOS OS TESTES DA AMANDA
 * 
 * Executa todos os testes em sequência:
 * 1. Testes unitários do flagsDetector (P1-P4)
 * 2. Testes de integração P1-P4
 * 3. Simulação de conversa (27 cenários)
 * 4. 94 cenários reais (se solicitado)
 * 5. Relatório Q&A V8 (para análise humana detalhada)
 * 
 * Uso: node tests/amanda/run-all-tests.js [opções]
 *   --full      Inclui os 94 cenários reais (mais lento)
 *   --unit      Apenas testes unitários
 *   --p1p4      Apenas testes P1-P4
 *   --skip-db   Pula testes que precisam de MongoDB
 *   --qna-v8    💎 Gera relatório Q&A V8 detalhado (PARA ANÁLISE HUMANA)
 *   --report    Salva relatório em arquivo (usado com --qna-v8)
 */

import 'dotenv/config';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const c = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    bold: '\x1b[1m'
};

function log(color, msg) { console.log(`${color}${msg}${c.reset}`); }

// ============================================
// CONFIGURAÇÃO DOS TESTES
// ============================================
const TEST_SUITES = [
    {
        id: 'unit-p1p4',
        name: '🧪 Unitários P1-P4 (flagsDetector)',
        file: '../unit/flagsDetector.p1-p4.test.js',
        needsDB: false,
        critical: true,
        skipIf: (args) => args['--integration-only']
    },
    {
        id: 'integration-p1p4',
        name: '🔬 Integração P1-P4 (Orchestrator)',
        file: 'p1-p4-fixes.test.js',
        needsDB: true,
        critical: true,
        skipIf: (args) => args['--unit'] || args['--skip-db']
    },
    {
        id: 'simulacao',
        name: '🎭 Simulação de Conversa (27 cenários)',
        file: 'simulacao-conversa.test.js',
        needsDB: true,
        critical: false,
        skipIf: (args) => args['--unit'] || args['--p1p4'] || args['--skip-db']
    },
    {
        id: 'scenarios-94',
        name: '📊 94 Cenários Reais',
        file: 'run-94-scenarios.js',
        needsDB: true,
        critical: false,
        skipIf: (args) => !args['--full'] || args['--skip-db']
    },
    {
        id: 'qna-v8',
        name: '💎 Relatório Q&A V8 (Análise Humana)',
        file: '../relatorio-qna-amanda-v8.js',
        needsDB: true,
        critical: false,
        isQNA: true,
        skipIf: (args) => !args['--qna-v8'] || args['--skip-db']
    }
];

// ============================================
// EXECUTOR DE TESTE
// ============================================
function runTest(testFile, timeout = 120000) {
    return new Promise((resolve) => {
        const fullPath = join(__dirname, testFile);
        const child = spawn('node', [fullPath], {
            stdio: ['inherit', 'pipe', 'pipe'],
            env: process.env
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        child.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        const timeoutId = setTimeout(() => {
            child.kill('SIGTERM');
            resolve({ 
                success: false, 
                exitCode: -1, 
                stdout, 
                stderr: stderr + '\n[TIMEOUT] Teste excedeu ' + (timeout/1000) + 's' 
            });
        }, timeout);

        child.on('close', (code) => {
            clearTimeout(timeoutId);
            resolve({ 
                success: code === 0, 
                exitCode: code, 
                stdout, 
                stderr 
            });
        });

        child.on('error', (err) => {
            clearTimeout(timeoutId);
            resolve({ 
                success: false, 
                exitCode: -2, 
                stdout, 
                stderr: stderr + '\n[ERROR] ' + err.message 
            });
        });
    });
}

function parseArgs() {
    const args = {};
    process.argv.slice(2).forEach(arg => {
        if (arg.startsWith('--')) {
            const [key, value] = arg.split('=');
            args[key] = value || true;
        }
    });
    return args;
}

function extractSummary(stdout, testId) {
    // Tenta extrair resumo do output
    const lines = stdout.split('\n');
    const summary = {
        passed: 0,
        failed: 0,
        total: 0,
        rate: '0%'
    };

    for (const line of lines) {
        // Padrões comuns de resumo
        const passMatch = line.match(/(?:✅|Passaram):\s*(\d+)\/(\d+)/);
        const failMatch = line.match(/(?:❌|Falharam):\s*(\d+)/);
        const rateMatch = line.match(/Taxa:\s*([\d.]+)%/);

        if (passMatch) {
            summary.passed = parseInt(passMatch[1]);
            summary.total = parseInt(passMatch[2]);
        }
        if (failMatch) {
            summary.failed = parseInt(failMatch[1]);
        }
        if (rateMatch) {
            summary.rate = rateMatch[1] + '%';
        }
    }

    return summary;
}

// ============================================
// MODO Q&A V8 - Relatório Detalhado
// ============================================
async function runQNAV8Mode() {
    console.log(`${c.cyan}
╔════════════════════════════════════════════════════════════════╗
║  💎 RELATÓRIO Q&A V8 - Análise Humana Detalhada                ║
╠════════════════════════════════════════════════════════════════╣
║  Gera relatório completo de Perguntas & Respostas              ║
║  Para análise minuciosa e ajustes finos na Amanda              ║
╚════════════════════════════════════════════════════════════════╝
${c.reset}\n`);

    const qnaScript = join(__dirname, '../relatorio-qna-amanda-v8.js');
    
    if (!fs.existsSync(qnaScript)) {
        log(c.red, `❌ Script não encontrado: ${qnaScript}`);
        log(c.yellow, `   Certifique-se de que o arquivo existe em: back/tests/relatorio-qna-amanda-v8.js`);
        process.exit(1);
    }

    log(c.blue, '🚀 Iniciando geração do relatório Q&A...');
    log(c.yellow, '   (Isso pode levar alguns minutos - são 7 cenários com chamadas reais à Amanda)\n');
    
    const result = await runTest('../relatorio-qna-amanda-v8.js', 600000);
    
    console.log('\n' + c.cyan + '═'.repeat(64) + c.reset);
    
    if (result.success) {
        log(c.green, '✅ Relatório Q&A gerado com sucesso!\n');
        
        // Tenta encontrar o arquivo gerado
        const testReportsDir = join(process.cwd(), 'tests-amanda-ouro');
        if (fs.existsSync(testReportsDir)) {
            const files = fs.readdirSync(testReportsDir)
                .filter(f => f.startsWith('RELATORIO-QNA-V8'))
                .sort()
                .reverse();
            
            if (files.length > 0) {
                const latest = files[0];
                const fullPath = join(testReportsDir, latest);
                
                log(c.green, `📄 Arquivo gerado:`);
                log(c.white, `   ${fullPath}\n`);
                
                // Mostra preview
                const content = fs.readFileSync(fullPath, 'utf-8');
                const lines = content.split('\n').slice(0, 30);
                log(c.gray, '📝 Preview do relatório:');
                lines.forEach(l => console.log(c.gray + '   ' + l + c.reset));
                if (content.split('\n').length > 30) {
                    log(c.gray, '   ... (mais conteúdo no arquivo)\n');
                }
                
                console.log('\n' + c.yellow + '💡 Próximos passos:' + c.reset);
                console.log('   1. Abra o arquivo .md em um editor Markdown');
                console.log('   2. Analise cada cenário (Lead → Amanda)');
                console.log('   3. Preencha sua avaliação nos campos indicados');
                console.log('   4. Anote ajustes necessários para cada cenário');
                console.log('   5. Use para guiar as correções na Amanda\n');
            }
        }
    } else {
        log(c.red, '❌ Falha ao gerar relatório Q&A\n');
        if (result.stderr) {
            log(c.gray, 'Erros:');
            console.log(result.stderr.slice(-500));
        }
        process.exit(1);
    }
}

// ============================================
// MAIN
// ============================================
async function main() {
    const args = parseArgs();

    // MODO ESPECIAL: Q&A V8
    if (args['--qna-v8']) {
        await runQNAV8Mode();
        return;
    }

    console.log(`${c.cyan}
╔════════════════════════════════════════════════════════════════╗
║  🧪 AMANDA TEST RUNNER - Suite Completa                        ║
╠════════════════════════════════════════════════════════════════╣
║  Modo: ${args['--full'] ? 'COMPLETO (com 94 cenários)' : 'PADRÃO'}                                    ║
║  MongoDB: ${args['--skip-db'] ? 'DESATIVADO' : 'ATIVO'}                                   ║
╚════════════════════════════════════════════════════════════════╝
${c.reset}`);

    const results = [];
    const startTime = Date.now();

    for (const suite of TEST_SUITES) {
        // Verifica se deve pular
        if (suite.skipIf && suite.skipIf(args)) {
            log(c.yellow, `\n⏭️  ${suite.name} [PULADO]`);
            continue;
        }

        log(c.cyan, `\n${'─'.repeat(64)}`);
        log(c.bold + c.cyan, `  ${suite.name}`);
        log(c.cyan, `${'─'.repeat(64)}`);

        const testStart = Date.now();
        const result = await runTest(suite.file, suite.needsDB ? 180000 : 60000);
        const duration = ((Date.now() - testStart) / 1000).toFixed(1);

        const summary = extractSummary(result.stdout, suite.id);

        if (result.success) {
            log(c.green, `  ✅ SUCESSO em ${duration}s`);
            if (summary.total > 0) {
                log(c.green, `     ${summary.passed}/${summary.total} testes passaram (${summary.rate})`);
            }
        } else {
            log(c.red, `  ❌ FALHA em ${duration}s (exit code: ${result.exitCode})`);
            if (summary.failed > 0) {
                log(c.red, `     ${summary.failed}/${summary.total} testes falharam`);
            }
        }

        // Mostra erros se houver
        if (!result.success && result.stderr) {
            const errorLines = result.stderr.split('\n').filter(l => l.trim() && !l.includes('ExperimentalWarning'));
            if (errorLines.length > 0) {
                log(c.gray, `  💥 Últimos erros:`);
                errorLines.slice(-3).forEach(l => log(c.gray, `     ${l.substring(0, 80)}`));
            }
        }

        results.push({
            suite: suite.name,
            success: result.success,
            critical: suite.critical,
            summary,
            duration
        });
    }

    // RELATÓRIO FINAL
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    const criticalFailed = results.filter(r => r.critical && !r.success).length;
    const totalFailed = results.filter(r => !r.success).length;
    const totalRun = results.length;

    console.log(`\n${c.cyan}${'═'.repeat(64)}${c.reset}`);
    console.log(`${c.bold}📊 RELATÓRIO FINAL${c.reset}`);
    console.log(`${c.cyan}${'═'.repeat(64)}${c.reset}`);

    console.log(`\n✅ Suites: ${totalRun - totalFailed}/${totalRun} passaram`);
    console.log(`🔴 Críticas falhas: ${criticalFailed}`);
    console.log(`⏱️  Tempo total: ${totalTime}s`);

    console.log(`\n📋 Detalhes:`);
    results.forEach(r => {
        const icon = r.success ? '✅' : (r.critical ? '🔴' : '⚠️');
        const status = r.success ? 'OK' : 'FALHOU';
        console.log(`   ${icon} ${r.suite}: ${status} (${r.duration}s)`);
        if (r.summary.total > 0) {
            console.log(`      └─ ${r.summary.passed}/${r.summary.total} (${r.summary.rate})`);
        }
    });

    // RECOMENDAÇÕES
    console.log(`\n${c.yellow}💡 Recomendações:${c.reset}`);
    if (criticalFailed > 0) {
        log(c.red, '   🔴 Há falhas em testes CRÍTICOS! Não deployar sem corrigir.');
    } else if (totalFailed > 0) {
        log(c.yellow, '   ⚠️  Alguns testes não-críticos falharam. Revisar antes de deployar.');
    } else {
        log(c.green, '   ✅ Todos os testes passaram! Pronto para deploy.');
    }

    // Sugestões
    if (!args['--full']) {
        log(c.blue, '   💡 Para testes completos incluindo 94 cenários reais, use: --full');
    }
    if (!args['--qna-v8']) {
        log(c.blue, '   💡 Para relatório Q&A detalhado (análise humana), use: --qna-v8');
    }
    if (!args['--skip-db'] && results.some(r => r.suite.includes('94') && !r.success)) {
        log(c.blue, '   💡 Se os testes de DB estiverem lentos, use: --skip-db');
    }

    process.exit(criticalFailed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error(`${c.red}💥 Erro fatal:${c.reset}`, err);
    process.exit(1);
});
