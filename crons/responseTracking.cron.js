// =====================================================================
// RESPONSE TRACKING CRON - PRODUCTION READY
// =====================================================================
// Executa verificações periódicas de respostas e identifica leads frios
//
// Schedules:
// - A cada 30min: Verifica respostas pendentes
// - Diariamente 20h: Identifica leads frios
// - Diariamente 21h: Gera relatório analytics
//
// Autor: Sistema Amanda 2.0
// Versão: 2.0.0
// =====================================================================

import chalk from 'chalk';
import mongoose from 'mongoose';
import cron from 'node-cron';
import {
    getResponseAnalytics,
    healthCheck,
    identifyNonResponders,
    processPendingResponses
} from '../services/responseTrackingService.js';

// =====================================================================
// CONFIGURAÇÕES
// =====================================================================

const CONFIG = {
    TIMEZONE: 'America/Sao_Paulo',

    // Schedules (cron expressions)
    SCHEDULES: {
        CHECK_RESPONSES: '*/30 * * * *',        // A cada 30min
        IDENTIFY_COLD: '0 20 * * *',            // Todo dia 20h
        DAILY_REPORT: '0 21 * * *',             // Todo dia 21h
        HEALTH_CHECK: '*/15 * * * *'            // A cada 15min
    },

    // Retry em caso de falha
    MAX_RETRIES: 3,
    RETRY_DELAY: 60000, // 1min

    // Timeouts
    TASK_TIMEOUT: 5 * 60 * 1000, // 5min

    // Alertas
    ENABLE_ALERTS: true,
    ALERT_THRESHOLD_ERROR_RATE: 0.3 // 30% de erro = alerta
};

// =====================================================================
// LOGGER ESTRUTURADO
// =====================================================================

const logger = {
    info: (msg, data = {}) => {
        const timestamp = new Date().toLocaleString('pt-BR', { timeZone: CONFIG.TIMEZONE });
        console.log(chalk.blue(`[${timestamp}] [INFO] ${msg}`), JSON.stringify(data, null, 2));
    },
    success: (msg, data = {}) => {
        const timestamp = new Date().toLocaleString('pt-BR', { timeZone: CONFIG.TIMEZONE });
        console.log(chalk.green(`[${timestamp}] [SUCCESS] ${msg}`), JSON.stringify(data, null, 2));
    },
    warn: (msg, data = {}) => {
        const timestamp = new Date().toLocaleString('pt-BR', { timeZone: CONFIG.TIMEZONE });
        console.warn(chalk.yellow(`[${timestamp}] [WARN] ${msg}`), JSON.stringify(data, null, 2));
    },
    error: (msg, error, data = {}) => {
        const timestamp = new Date().toLocaleString('pt-BR', { timeZone: CONFIG.TIMEZONE });
        console.error(
            chalk.red(`[${timestamp}] [ERROR] ${msg}`),
            { error: error?.message || error, stack: error?.stack, ...data }
        );
    },
    cron: (taskName, status) => {
        const timestamp = new Date().toLocaleString('pt-BR', { timeZone: CONFIG.TIMEZONE });
        const color = status === 'START' ? chalk.cyan : status === 'SUCCESS' ? chalk.green : chalk.red;
        console.log(color(`[${timestamp}] [CRON] ${taskName} - ${status}`));
    }
};

// =====================================================================
// CONTROLE DE EXECUÇÃO
// =====================================================================
let isShuttingDown = false;
const taskLocks = new Map();
const taskStats = {
    checkResponses: { runs: 0, errors: 0, lastRun: null, lastDuration: 0 },
    identifyCold: { runs: 0, errors: 0, lastRun: null, lastDuration: 0 },
    dailyReport: { runs: 0, errors: 0, lastRun: null, lastDuration: 0 },
    healthCheck: { runs: 0, errors: 0, lastRun: null, lastDuration: 0 }
};

/**
 * Wrapper para executar tarefas com proteção
 */
async function runTask(taskName, taskFn, options = {}) {
    if (isShuttingDown) {
        logger.warn(`Tarefa ${taskName} ignorada: sistema em shutdown`);
        return;
    }
    const {
        timeout = CONFIG.TASK_TIMEOUT,
        retries = CONFIG.MAX_RETRIES
    } = options;

    // Prevent concurrent execution
    if (taskLocks.get(taskName)) {
        logger.warn(`Tarefa ${taskName} já está rodando - pulando execução`);
        return;
    }

    taskLocks.set(taskName, true);
    logger.cron(taskName, 'START');

    const startTime = Date.now();
    let lastError;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            // Execute com timeout
            const result = await Promise.race([
                taskFn(),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Task timeout')), timeout)
                )
            ]);

            // Sucesso
            const duration = Date.now() - startTime;
            taskStats[taskName].runs++;
            taskStats[taskName].lastRun = new Date();
            taskStats[taskName].lastDuration = duration;

            logger.cron(taskName, 'SUCCESS');
            logger.success(`Tarefa concluída: ${taskName}`, {
                duration: `${duration}ms`,
                attempt: attempt > 1 ? attempt : undefined
            });

            taskLocks.delete(taskName);
            return result;

        } catch (error) {
            lastError = error;
            taskStats[taskName].errors++;

            logger.error(`Tentativa ${attempt}/${retries} falhou: ${taskName}`, error);

            if (attempt < retries) {
                await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_DELAY));
            }
        }
    }

    // Todas tentativas falharam
    logger.cron(taskName, 'FAILED');
    logger.error(`Tarefa falhou após ${retries} tentativas: ${taskName}`, lastError);

    // Alerta se taxa de erro muito alta
    if (CONFIG.ENABLE_ALERTS) {
        const errorRate = taskStats[taskName].errors / (taskStats[taskName].runs || 1);
        if (errorRate >= CONFIG.ALERT_THRESHOLD_ERROR_RATE) {
            sendAlert(taskName, errorRate);
        }
    }

    taskLocks.delete(taskName);
    throw lastError;
}

/**
 * Envia alerta quando taxa de erro é alta
 */
function sendAlert(taskName, errorRate) {
    logger.error('🚨 ALERTA: Taxa de erro elevada', new Error('High error rate'), {
        taskName,
        errorRate: `${(errorRate * 100).toFixed(1)}%`,
        threshold: `${CONFIG.ALERT_THRESHOLD_ERROR_RATE * 100}%`,
        stats: taskStats[taskName]
    });

    // TODO: Integrar com sistema de alertas (Slack, email, etc)
}

// =====================================================================
// TAREFAS AGENDADAS
// =====================================================================

/**
 * TASK 1: Verificar respostas pendentes
 * Executa a cada 30 minutos
 */
async function taskCheckResponses() {
    logger.info('Iniciando verificação de respostas pendentes...');

    const result = await processPendingResponses({
        batchSize: 50,
        minAge: 24 // horas
    });

    if (result.error) {
        throw new Error(result.error);
    }

    logger.success('Verificação concluída', {
        processed: result.processed,
        responded: result.responded,
        errors: result.errors,
        responseRate: result.processed > 0
            ? `${((result.responded / result.processed) * 100).toFixed(1)}%`
            : 'N/A'
    });

    // Alertar se muitos erros
    if (result.errors > result.processed * 0.2) {
        logger.warn('Alta taxa de erros no processamento', {
            errors: result.errors,
            total: result.processed,
            errorRate: `${((result.errors / result.processed) * 100).toFixed(1)}%`
        });
    }

    return result;
}

/**
 * TASK 2: Identificar leads frios
 * Executa diariamente às 20h
 */
async function taskIdentifyCold() {
    logger.info('Iniciando identificação de leads frios...');

    const nonResponders = await identifyNonResponders({
        minAge: 48, // horas
        minFollowups: 2,
        scorePenalty: 30
    });

    logger.success('Identificação concluída', {
        leadsFrios: nonResponders.length
    });

    // Log detalhado dos leads frios
    if (nonResponders.length > 0) {
        logger.info('Leads marcados como frios:', {
            top5: nonResponders.slice(0, 5).map(l => ({
                leadId: l.leadId,
                followups: l.totalFollowups,
                dias: l.daysSinceFirst
            }))
        });
    }

    // Alertar se muitos leads frios
    if (nonResponders.length > 20) {
        logger.warn('Número elevado de leads frios identificados', {
            count: nonResponders.length
        });
    }

    return nonResponders;
}

/**
 * TASK 3: Relatório diário de analytics
 * Executa diariamente às 21h
 */
async function taskDailyReport() {
    logger.info('Gerando relatório diário...');

    const analytics = await getResponseAnalytics(7); // últimos 7 dias

    if (!analytics) {
        throw new Error('Falha ao gerar analytics');
    }

    logger.success('Relatório gerado', {
        periodo: analytics.metadata.period,
        taxa_resposta: `${analytics.overall.responseRate}%`,
        total_followups: analytics.overall.total,
        respondidos: analytics.overall.responded,
        tempo_medio_resposta: `${analytics.overall.avgResponseTime}min`,
        melhor_horario: analytics.insights.bestHour,
        melhor_origem: analytics.insights.bestOrigin
    });

    // Log das recomendações
    if (analytics.insights.recommendations.length > 0) {
        logger.info('📊 Recomendações:', {
            recomendacoes: analytics.insights.recommendations
        });
    }

    // TODO: Enviar relatório por email/Slack

    return analytics;
}

/**
 * TASK 4: Health check do sistema
 * Executa a cada 15 minutos
 */
async function taskHealthCheck() {
    const health = await healthCheck();
    const checks = health.checks || {};
    const { database, socket, recentActivity } = checks;

    const coreHealthy = database && socket;

    // 🔴 1) Problema real de infra (DB ou socket)
    if (!coreHealthy) {
        logger.error(
            'Sistema não está saudável (problema de infraestrutura)',
            new Error('Health check failed'),
            { checks }
        );

        if (CONFIG.ENABLE_ALERTS) {
            try {
                // erro crítico → taxa 1.0
                await sendAlert('healthCheck', 1.0);
            } catch (e) {
                logger.error('[HealthCheck] Falha ao enviar alerta', e);
            }
        }

        return {
            ...health,
            healthy: false,
        };
    }

    // 🟡 2) Infra ok, mas sem atividade recente → só aviso
    if (!recentActivity) {
        logger.warn(
            '[HealthCheck] Nenhuma atividade recente de Followups nas últimas 24h (pode ser normal)',
            { checks }
        );

        // aqui você decide se quer marcar como healthy ou não;
        // eu colocaria true, porque infra tá ok:
        return {
            ...health,
            healthy: true,
        };
    }

    // 🟢 3) Tudo certo
    logger.info('✓ Sistema saudável (DB + socket + atividade recente)', checks);

    return {
        ...health,
        healthy: true,
    };
}

// =====================================================================
// INICIALIZAÇÃO
// =====================================================================

/**
 * Conecta ao MongoDB com retry
 */
/**
 * Conecta ao MongoDB com retry
 */
async function connectDatabase() {
    // ✅ VALIDAÇÃO ADICIONADA
    if (!process.env.MONGO_URI) {
        const error = new Error('❌ MONGO_URI não definido no arquivo .env');
        logger.error('Erro crítico de configuração', error, {
            hint: 'Adicione MONGO_URI=mongodb://... no seu .env'
        });
        throw error;
    }

    const maxRetries = 5;
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await mongoose.connect(process.env.MONGO_URI, {
                serverSelectionTimeoutMS: 10000,
                socketTimeoutMS: 45000,
            });

            return;

        } catch (error) {
            lastError = error;
            logger.error(`Tentativa ${attempt}/${maxRetries} de conexão falhou`, error);

            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, 5000 * attempt));
            }
        }
    }

    logger.error('Falha crítica ao conectar MongoDB após todas tentativas', lastError);
    process.exit(1);
}

/**
 * Graceful shutdown
 */
function setupGracefulShutdown() {
    const shutdown = async (signal) => {
        if (isShuttingDown) return;
        isShuttingDown = true;

        logger.warn(`Recebido sinal ${signal} - iniciando shutdown...`);

        // Esperar tarefas em execução terminarem
        const timeout = setTimeout(() => {
            logger.error('Timeout no shutdown - forçando saída', new Error('Shutdown timeout'));
            process.exit(1);
        }, 30000); // 30s

        try {
            // Aguardar tarefas ativas
            while (taskLocks.size > 0) {
                logger.info('Aguardando tarefas ativas terminarem...', {
                    active: Array.from(taskLocks.keys())
                });
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            // Fechar conexão MongoDB
            await mongoose.connection.close();
            logger.success('MongoDB desconectado com sucesso');

            // Mostrar estatísticas finais
            logger.info('Estatísticas finais:', taskStats);

            clearTimeout(timeout);
            logger.info('Processo finalizado com shutdown gracioso');
            process.exit(0);

        } catch (error) {
            logger.error('Erro durante shutdown', error);
            process.exit(1);
        }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

/**
 * Monitora erros não capturados
 */
function setupErrorHandlers() {
    process.on('unhandledRejection', (reason, promise) => {
        logger.error('Unhandled Promise Rejection', reason, { promise });
    });

    process.on('uncaughtException', (error) => {
        if (isShuttingDown) {
            logger.warn('Erro durante shutdown — ignorado', { message: error.message });
            return;
        }

        logger.error('Uncaught Exception', error);
        process.exit(1);
    });

}

// =====================================================================
// AGENDAMENTO DAS TAREFAS
// =====================================================================

/**
 * Agenda todas as tarefas cron
 */
function scheduleTasks() {
    logger.info('Agendando tarefas cron...', {
        timezone: CONFIG.TIMEZONE,
        schedules: CONFIG.SCHEDULES
    });

    // 1. Verificar respostas - a cada 30min
    cron.schedule(CONFIG.SCHEDULES.CHECK_RESPONSES, async () => {
        await runTask('checkResponses', taskCheckResponses);
    }, {
        timezone: CONFIG.TIMEZONE
    });

    // 2. Identificar leads frios - diariamente 20h
    cron.schedule(CONFIG.SCHEDULES.IDENTIFY_COLD, async () => {
        await runTask('identifyCold', taskIdentifyCold);
    }, {
        timezone: CONFIG.TIMEZONE
    });

    // 3. Relatório diário - diariamente 21h
    cron.schedule(CONFIG.SCHEDULES.DAILY_REPORT, async () => {
        await runTask('dailyReport', taskDailyReport);
    }, {
        timezone: CONFIG.TIMEZONE
    });

    // 4. Health check - a cada 15min
    cron.schedule(CONFIG.SCHEDULES.HEALTH_CHECK, async () => {
        await runTask('healthCheck', taskHealthCheck, {
            retries: 1, // Sem retry para health check
            timeout: 30000 // 30s
        });
    }, {
        timezone: CONFIG.TIMEZONE
    });

    logger.success('Tarefas agendadas com sucesso', {
        tasks: Object.keys(CONFIG.SCHEDULES).length
    });
}

/**
 * Executa uma rodada inicial de verificações
 */
async function runInitialChecks() {
    logger.info('Executando verificações iniciais...');

    try {
        // Health check imediato
        await taskHealthCheck();

        // Verificar respostas pendentes
        await runTask('checkResponses', taskCheckResponses);

        logger.success('Verificações iniciais concluídas');

    } catch (error) {
        logger.error('Erro nas verificações iniciais', error);
        // Não falha o startup - apenas loga
    }
}

// =====================================================================
// MAIN
// =====================================================================

async function main() {

    console.log(chalk.cyan.bold(`
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   📊 RESPONSE TRACKING CRON - AMANDA 2.0                     ║
║                                                               ║
║   Status: Inicializando...                                   ║
║   Timezone: ${CONFIG.TIMEZONE}                               ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
    `));

    try {
        // 1. Setup handlers
        setupErrorHandlers();
        setupGracefulShutdown();

        //await validateDependencies();

        // 2. Conectar banco
        await connectDatabase();

        // 3. Verificações iniciais
        await runInitialChecks();

        // 4. Agendar tarefas
        scheduleTasks();

        console.log(chalk.green.bold(`
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   ✅ SISTEMA INICIADO COM SUCESSO                            ║
║                                                               ║
║   Tarefas ativas:                                            ║
║   • Verificar respostas: a cada 30min                        ║
║   • Identificar frios: diariamente 20h                       ║
║   • Relatório diário: diariamente 21h                        ║
║   • Health check: a cada 15min                               ║
║                                                               ║
║   Pressione Ctrl+C para parar                                ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
        `));

        // Manter processo vivo
        process.stdin.resume();

    } catch (error) {
        logger.error('Falha crítica na inicialização', error);
        process.exit(1);
    }
}



main().catch(error => {
    console.error('❌ Erro fatal no Response Tracking Cron:', error);
});


// =====================================================================
// EXPORTS (para testes)
// =====================================================================

export {
    CONFIG, taskCheckResponses, taskDailyReport,
    taskHealthCheck, taskIdentifyCold, taskStats
};
