/**
 * 🎯 Master Test Runner - Executa Todos os Testes
 * 
 * Orquestra:
 * 1. realConversationTester.js - Testes com dados reais
 * 2. fieldPopulationTest.js - Preenchimento de campos
 * 3. psychologicalSalesTest.js - Qualidade de venda psicológica
 * 4. testContextRecovery.js - Recuperação de contexto
 * 
 * Gera relatório unificado em HTML e JSON
 */

import mongoose from 'mongoose';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs/promises';

// Importa todos os testadores
import { ConversationMiner, ConversationSimulator } from './realConversationTester.js';
import { FieldPopulationTester, TEST_SCENARIOS } from './fieldPopulationTest.js';
import { PsychologicalSalesTester, PSYCHOLOGICAL_SCENARIOS } from './psychologicalSalesTest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const C = {
    reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
    blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', bold: '\x1b[1m'
};

function log(text, color = 'reset') {
    console.log(`${C[color]}${text}${C.reset}`);
}

// ============================================
// 📊 ORQUESTRADOR DE TESTES
// ============================================
class MasterTestRunner {
    constructor() {
        this.results = {
            timestamp: new Date().toISOString(),
            summary: {},
            tests: {}
        };
        this.startTime = Date.now();
    }

    async connectDatabase() {
        log('\n🔌 Conectando ao MongoDB...', 'yellow');
        await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/clinica');
        log('✅ Conectado', 'green');
    }

    async disconnectDatabase() {
        await mongoose.disconnect();
        log('\n👋 Desconectado', 'cyan');
    }

    async runSuite(name, runner, options = {}) {
        log(`\n${'='.repeat(70)}`, 'magenta');
        log(`🎬 SUITE: ${name}`, 'magenta');
        log(`${'='.repeat(70)}`, 'magenta');

        const suiteStart = Date.now();
        
        try {
            const result = await runner(options);
            const duration = Date.now() - suiteStart;
            
            this.results.tests[name] = {
                status: 'PASSED',
                duration,
                result
            };

            log(`\n✅ Suite "${name}" completada em ${duration}ms`, 'green');
            return result;

        } catch (error) {
            const duration = Date.now() - suiteStart;
            
            this.results.tests[name] = {
                status: 'FAILED',
                duration,
                error: error.message
            };

            log(`\n❌ Suite "${name}" falhou: ${error.message}`, 'red');
            return null;
        }
    }

    // ============================================
    // 🎮 TESTE 1: Conversas Reais
    // ============================================
    async runRealConversationsTest() {
        return this.runSuite('Conversas Reais', async () => {
            const miner = new ConversationMiner();
            const simulator = new ConversationSimulator();

            // Busca conversas convertidas
            const leads = await miner.findConvertibleConversations(5);
            
            for (const lead of leads) {
                const messages = await miner.getFullConversation(lead._id);
                if (messages.length >= 3) {
                    await simulator.simulateConversation(lead, messages, { delay: 0 });
                }
            }

            return simulator.generateFinalReport();
        });
    }

    // ============================================
    // 📝 TESTE 2: Preenchimento de Campos
    // ============================================
    async runFieldPopulationTest() {
        return this.runSuite('Preenchimento de Campos', async () => {
            const tester = new FieldPopulationTester();

            for (const scenario of TEST_SCENARIOS) {
                await tester.runTest(scenario);
            }

            return tester.generateReport();
        });
    }

    // ============================================
    // 🧠 TESTE 3: Venda Psicológica
    // ============================================
    async runPsychologicalSalesTest() {
        return this.runSuite('Venda Psicológica', async () => {
            const tester = new PsychologicalSalesTester();

            for (const scenario of PSYCHOLOGICAL_SCENARIOS) {
                await tester.runTest(scenario);
            }

            return tester.generateReport();
        });
    }

    // ============================================
    // 📊 GERAÇÃO DE RELATÓRIOS
    // ============================================
    generateUnifiedReport() {
        log(`\n${'='.repeat(70)}`, 'cyan');
        log('📊 GERANDO RELATÓRIO UNIFICADO', 'cyan');
        log(`${'='.repeat(70)}`, 'cyan');

        const totalDuration = Date.now() - this.startTime;
        const suites = Object.values(this.results.tests);
        const passed = suites.filter(s => s.status === 'PASSED').length;
        const failed = suites.filter(s => s.status === 'FAILED').length;

        this.results.summary = {
            totalSuites: suites.length,
            passed,
            failed,
            totalDuration,
            timestamp: new Date().toISOString()
        };

        log(`\n📈 Resumo:`);
        log(`   Total: ${suites.length} suites`);
        log(`   ✅ Passaram: ${passed}`, 'green');
        log(`   ❌ Falharam: ${failed}`, failed > 0 ? 'red' : 'reset');
        log(`   ⏱️ Duração total: ${totalDuration}ms`);

        return this.results;
    }

    async saveReports() {
        const timestamp = Date.now();
        const dir = join(__dirname, 'reports');
        await fs.mkdir(dir, { recursive: true });

        // JSON
        const jsonPath = join(dir, `master-report-${timestamp}.json`);
        await fs.writeFile(jsonPath, JSON.stringify(this.results, null, 2));
        log(`\n💾 JSON salvo: ${jsonPath}`, 'cyan');

        // HTML
        const htmlPath = join(dir, `master-report-${timestamp}.html`);
        const html = this.generateHTML();
        await fs.writeFile(htmlPath, html);
        log(`💾 HTML salvo: ${htmlPath}`, 'cyan');

        return { json: jsonPath, html: htmlPath };
    }

    generateHTML() {
        const data = this.results;
        
        return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Relatório de Testes - Amanda AI</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #f5f7fa;
            color: #333;
            line-height: 1.6;
        }
        .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
        header { 
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 40px;
            border-radius: 12px;
            margin-bottom: 30px;
        }
        h1 { font-size: 2.5em; margin-bottom: 10px; }
        .timestamp { opacity: 0.9; }
        .summary-cards {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        .card {
            background: white;
            padding: 25px;
            border-radius: 12px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        .card h3 { color: #667eea; margin-bottom: 15px; }
        .metric { font-size: 2em; font-weight: bold; color: #333; }
        .metric-label { color: #666; font-size: 0.9em; }
        .suite-section {
            background: white;
            padding: 30px;
            border-radius: 12px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            margin-bottom: 20px;
        }
        .suite-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            padding-bottom: 15px;
            border-bottom: 2px solid #f0f0f0;
        }
        .suite-title { font-size: 1.5em; color: #333; }
        .status-badge {
            padding: 8px 16px;
            border-radius: 20px;
            font-weight: bold;
            font-size: 0.9em;
        }
        .status-passed { background: #d4edda; color: #155724; }
        .status-failed { background: #f8d7da; color: #721c24; }
        .progress-bar {
            height: 8px;
            background: #e9ecef;
            border-radius: 4px;
            overflow: hidden;
            margin: 10px 0;
        }
        .progress-fill {
            height: 100%;
            background: linear-gradient(90deg, #667eea 0%, #764ba2 100%);
            transition: width 0.3s ease;
        }
        pre {
            background: #f8f9fa;
            padding: 20px;
            border-radius: 8px;
            overflow-x: auto;
            font-size: 0.9em;
        }
        .error-box {
            background: #f8d7da;
            border: 1px solid #f5c6cb;
            color: #721c24;
            padding: 15px;
            border-radius: 8px;
            margin-top: 15px;
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>🎯 Relatório de Testes - Amanda AI</h1>
            <p class="timestamp">Executado em: ${new Date(data.summary.timestamp).toLocaleString('pt-BR')}</p>
        </header>

        <div class="summary-cards">
            <div class="card">
                <h3>📊 Suites Executadas</h3>
                <div class="metric">${data.summary.totalSuites}</div>
                <div class="metric-label">testes</div>
            </div>
            <div class="card">
                <h3>✅ Passaram</h3>
                <div class="metric" style="color: #28a745;">${data.summary.passed}</div>
                <div class="metric-label">${((data.summary.passed / data.summary.totalSuites) * 100).toFixed(0)}%</div>
            </div>
            <div class="card">
                <h3>❌ Falharam</h3>
                <div class="metric" style="color: #dc3545;">${data.summary.failed}</div>
                <div class="metric-label">${((data.summary.failed / data.summary.totalSuites) * 100).toFixed(0)}%</div>
            </div>
            <div class="card">
                <h3>⏱️ Duração</h3>
                <div class="metric">${(data.summary.totalDuration / 1000).toFixed(1)}s</div>
                <div class="metric-label">tempo total</div>
            </div>
        </div>

        ${Object.entries(data.tests).map(([name, test]) => `
            <div class="suite-section">
                <div class="suite-header">
                    <h2 class="suite-title">${name}</h2>
                    <span class="status-badge status-${test.status.toLowerCase()}">
                        ${test.status === 'PASSED' ? '✅ PASSOU' : '❌ FALHOU'}
                    </span>
                </div>
                <p><strong>Duração:</strong> ${test.duration}ms</p>
                ${test.status === 'PASSED' ? `
                    <div class="progress-bar">
                        <div class="progress-fill" style="width: ${(test.result?.avgScore || test.result?.passed / test.result?.total * 10 || 0) * 10}%"></div>
                    </div>
                    <details>
                        <summary>Ver detalhes</summary>
                        <pre>${JSON.stringify(test.result, null, 2)}</pre>
                    </details>
                ` : `
                    <div class="error-box">
                        <strong>Erro:</strong> ${test.error}
                    </div>
                `}
            </div>
        `).join('')}
    </div>
</body>
</html>`;
    }
}

// ============================================
// 🚀 EXECUÇÃO PRINCIPAL
// ============================================
async function main() {
    const runner = new MasterTestRunner();

    try {
        // Conecta ao banco
        await runner.connectDatabase();

        // Define quais testes rodar
        const testsToRun = process.env.TEST_SUITES?.split(',') || ['all'];

        // Executa suites
        if (testsToRun.includes('all') || testsToRun.includes('real')) {
            await runner.runRealConversationsTest();
        }

        if (testsToRun.includes('all') || testsToRun.includes('fields')) {
            await runner.runFieldPopulationTest();
        }

        if (testsToRun.includes('all') || testsToRun.includes('psychological')) {
            await runner.runPsychologicalSalesTest();
        }

        // Gera relatório
        const report = runner.generateUnifiedReport();

        // Salva
        const paths = await runner.saveReports();

        log(`\n${'='.repeat(70)}`, 'green');
        log('✅ TODOS OS TESTES COMPLETADOS', 'green');
        log(`${'='.repeat(70)}`, 'green');
        log(`\n📁 Relatórios gerados:`, 'cyan');
        log(`   JSON: ${paths.json}`);
        log(`   HTML: ${paths.html}`);

    } catch (error) {
        log(`\n❌ ERRO FATAL: ${error.message}`, 'red');
        console.error(error.stack);
        process.exit(1);
    } finally {
        await runner.disconnectDatabase();
    }
}

// Roda
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}

export { MasterTestRunner };
