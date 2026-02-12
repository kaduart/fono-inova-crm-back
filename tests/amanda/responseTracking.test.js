import 'dotenv/config';
import mongoose from 'mongoose';
import {
    healthCheck,
    processPendingResponses,
    identifyNonResponders,
    getResponseAnalytics
} from '../../services/responseTrackingService.js';
import Followup from '../../models/Followup.js';
import Lead from '../../models/Leads.js';

// Cores para logs
const c = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m'
};

function log(color, msg) {
    console.log(`${color}${msg}${c.reset}`);
}

async function runTests() {
    log(c.cyan, '\n╔════════════════════════════════════════════════════╗');
    log(c.cyan, '║   🧪 RESPONSE TRACKING SERVICE TESTS               ║');
    log(c.cyan, '╚════════════════════════════════════════════════════╝\n');

    try {
        // 1. Conexão DB
        if (!process.env.MONGO_URI) {
            throw new Error('MONGO_URI não definido');
        }
        await mongoose.connect(process.env.MONGO_URI);
        log(c.green, '✅ MongoDB conectado');

        const stats = { passed: 0, failed: 0 };

        // =================================================================
        // TESTE 1: Health Check
        // =================================================================
        log(c.blue, '\n[TEST 1] Testing healthCheck()...');
        try {
            // Silencia o console.error do getIo() que roda fora do servidor
            const originalError = console.error;
            console.error = () => { };
            const health = await healthCheck();
            console.error = originalError;

            if (health.checks && typeof health.checks.database === 'boolean') {
                log(c.green, '  ✅ healthCheck retornou estrutura válida');
                log(c.green, `  ✅ Database check: ${health.checks.database}`);
                log(c.yellow, `  ⚠️  Socket check: ${health.checks.socket} (esperado false fora do servidor)`);
                stats.passed++;
            } else {
                throw new Error('Estrutura de retorno inválida');
            }
        } catch (e) {
            console.error = console.error; // restaura caso tenha falhado no meio
            log(c.red, `  ❌ Falha: ${e.message}`);
            stats.failed++;
        }

        // =================================================================
        // TESTE 2: Process Pending Responses (Empty/Normal)
        // =================================================================
        log(c.blue, '\n[TEST 2] Testing processPendingResponses()...');
        try {
            // Testamos apenas se roda sem erro de sintaxe (ex: .option)
            const result = await processPendingResponses({ batchSize: 1, minAge: 0 });

            if (typeof result.processed === 'number') {
                log(c.green, `  ✅ Executado com sucesso (Processed: ${result.processed})`);
                stats.passed++;
            } else {
                throw new Error('Retorno inválido');
            }
        } catch (e) {
            log(c.red, `  ❌ Falha: ${e.message}`);
            stats.failed++;
        }

        // =================================================================
        // TESTE 3: Identify Non Responders
        // =================================================================
        log(c.blue, '\n[TEST 3] Testing identifyNonResponders()...');
        try {
            const coldLeads = await identifyNonResponders({ minAge: 0, minFollowups: 999 }); // 999 pra não pegar ninguém real

            if (Array.isArray(coldLeads)) {
                log(c.green, `  ✅ Query executada com sucesso (Encontrados: ${coldLeads.length})`);
                stats.passed++;
            } else {
                throw new Error('Deveria retornar um array');
            }
        } catch (e) {
            log(c.red, `  ❌ Falha: ${e.message}`);
            stats.failed++;
        }

        // =================================================================
        // TESTE 4: Get Response Analytics
        // =================================================================
        log(c.blue, '\n[TEST 4] Testing getResponseAnalytics()...');
        try {
            const analytics = await getResponseAnalytics(7);

            if (analytics && analytics.overall && analytics.insights) {
                log(c.green, '  ✅ Analytics gerado com sucesso');
                log(c.green, `  ✅ Response Rate: ${analytics.overall.responseRate}%`);
                stats.passed++;
            } else {
                throw new Error('Estrutura de analytics inválida');
            }
        } catch (e) {
            log(c.red, `  ❌ Falha: ${e.message}`);
            stats.failed++;
        }

        // RESUMO
        log(c.cyan, '\n════════════════════════════════════════════════════');
        log(c.cyan, `📊 RESULTADOS: ${stats.passed} Passou | ${stats.failed} Falhou`);

        process.exit(stats.failed > 0 ? 1 : 0);

    } catch (err) {
        log(c.red, `\n⛔ ERRO CRÍTICO NO SETUP: ${err.message}`);
        process.exit(1);
    }
}

runTests();
