// =====================================================================
// GMB CRON - Publicação Automática no Google Meu Negócio
// =====================================================================
// Executa publicação de posts agendados para o Google Business Profile
//
// Schedules:
// - A cada 5 minutos: Verifica e publica posts agendados
// - Diariamente 8h: Gera post do dia automaticamente
//
// =====================================================================

import chalk from 'chalk';
import mongoose from 'mongoose';
import cron from 'node-cron';
import * as gmbService from '../services/gmbService.js';

// =====================================================================
// CONFIGURAÇÕES
// =====================================================================

const CONFIG = {
    TIMEZONE: 'America/Sao_Paulo',

    // Schedules (cron expressions)
    SCHEDULES: {
        PUBLISH_SCHEDULED: '*/5 * * * *',      // A cada 5 minutos
        GENERATE_DAILY: '0 8 * * *',           // Todo dia 8h da manhã
        GENERATE_WEEKLY: '0 9 * * 1',          // Toda segunda 9h
        HEALTH_CHECK: '0 */6 * * *'            // A cada 6 horas
    },

    // Retry em caso de falha
    MAX_RETRIES: 3,
    RETRY_DELAY: 30000, // 30s

    // Timeouts
    TASK_TIMEOUT: 2 * 60 * 1000, // 2min
};

// =====================================================================
// LOGGER
// =====================================================================

const logger = {
    info: (msg, data = {}) => {
        const timestamp = new Date().toLocaleString('pt-BR', { timeZone: CONFIG.TIMEZONE });
        console.log(chalk.blue(`[${timestamp}] [GMB] ${msg}`), JSON.stringify(data, null, 2));
    },
    success: (msg, data = {}) => {
        const timestamp = new Date().toLocaleString('pt-BR', { timeZone: CONFIG.TIMEZONE });
        console.log(chalk.green(`[${timestamp}] [GMB] ${msg}`), JSON.stringify(data, null, 2));
    },
    warn: (msg, data = {}) => {
        const timestamp = new Date().toLocaleString('pt-BR', { timeZone: CONFIG.TIMEZONE });
        console.warn(chalk.yellow(`[${timestamp}] [GMB] ${msg}`), JSON.stringify(data, null, 2));
    },
    error: (msg, error, data = {}) => {
        const timestamp = new Date().toLocaleString('pt-BR', { timeZone: CONFIG.TIMEZONE });
        console.error(
            chalk.red(`[${timestamp}] [GMB] ${msg}`),
            { error: error?.message || error, ...data }
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

async function runTask(taskName, taskFn, options = {}) {
    if (isShuttingDown) {
        logger.warn(`Tarefa ${taskName} ignorada: sistema em shutdown`);
        return;
    }
    
    const { timeout = CONFIG.TASK_TIMEOUT, retries = CONFIG.MAX_RETRIES } = options;

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
            const result = await Promise.race([
                taskFn(),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Task timeout')), timeout)
                )
            ]);

            const duration = Date.now() - startTime;
            logger.cron(taskName, 'SUCCESS');
            logger.success(`Tarefa concluída: ${taskName}`, { duration: `${duration}ms` });

            taskLocks.delete(taskName);
            return result;

        } catch (error) {
            lastError = error;
            logger.error(`Tentativa ${attempt}/${retries} falhou: ${taskName}`, error);

            if (attempt < retries) {
                await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_DELAY));
            }
        }
    }

    logger.cron(taskName, 'FAILED');
    logger.error(`Tarefa falhou após ${retries} tentativas: ${taskName}`, lastError);
    taskLocks.delete(taskName);
    throw lastError;
}

// =====================================================================
// TAREFAS
// =====================================================================

/**
 * TASK 1: Publicar posts agendados
 * Executa a cada 5 minutos
 */
async function taskPublishScheduled() {
    logger.info('Verificando posts agendados para publicar...');
    
    const results = await gmbService.publishScheduledPosts(5);
    
    if (results.published > 0) {
        logger.success(`${results.published} post(s) publicado(s) no GMB!`, {
            published: results.published,
            failed: results.failed
        });
    } else if (results.processed === 0) {
        logger.info('Nenhum post agendado para publicar');
    }
    
    if (results.failed > 0) {
        logger.warn(`${results.failed} post(s) falharam`, { errors: results.errors });
    }
    
    return results;
}

/**
 * TASK 2: Gerar post do dia
 * Executa diariamente às 8h
 */
async function taskGenerateDaily() {
    logger.info('Gerando post do dia...');
    
    const result = await gmbService.createDailyPost({
        generateImage: true,
        publishImmediately: false
    });
    
    if (result.success) {
        logger.success('Post do dia gerado!', {
            especialidade: result.especialidade.nome,
            scheduledAt: result.post.scheduledAt
        });
    }
    
    return result;
}

/**
 * TASK 3: Health check da conexão GMB
 */
async function taskHealthCheck() {
    logger.info('Verificando conexão com GMB...');
    
    const health = await gmbService.checkGMBConnection();
    
    if (health.connected) {
        logger.success('Conexão GMB OK', { accounts: health.accounts?.length || 0 });
    } else {
        logger.error('Problema na conexão GMB', new Error(health.error));
    }
    
    return health;
}

// =====================================================================
// INICIALIZAÇÃO
// =====================================================================

async function connectDatabase() {
    if (!process.env.MONGO_URI) {
        throw new Error('MONGO_URI não definido');
    }

    const maxRetries = 5;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await mongoose.connect(process.env.MONGO_URI, {
                serverSelectionTimeoutMS: 10000,
                socketTimeoutMS: 45000,
            });
            logger.success('MongoDB conectado');
            return;
        } catch (error) {
            logger.error(`Tentativa ${attempt}/${maxRetries} falhou`, error);
            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, 5000 * attempt));
            }
        }
    }
    throw new Error('Falha ao conectar MongoDB');
}

function setupGracefulShutdown() {
    const shutdown = async (signal) => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        
        logger.warn(`Recebido sinal ${signal} - iniciando shutdown...`);
        
        const timeout = setTimeout(() => {
            logger.error('Timeout no shutdown - forçando saída');
            process.exit(1);
        }, 30000);

        try {
            while (taskLocks.size > 0) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            await mongoose.connection.close();
            clearTimeout(timeout);
            logger.success('Shutdown completo');
            process.exit(0);
        } catch (error) {
            logger.error('Erro durante shutdown', error);
            process.exit(1);
        }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

function scheduleTasks() {
    logger.info('Agendando tarefas GMB...', { timezone: CONFIG.TIMEZONE });

    // 1. Publicar agendados - a cada 5 min
    cron.schedule(CONFIG.SCHEDULES.PUBLISH_SCHEDULED, async () => {
        await runTask('publishScheduled', taskPublishScheduled);
    }, { timezone: CONFIG.TIMEZONE });

    // 2. Gerar post diário - 8h da manhã
    cron.schedule(CONFIG.SCHEDULES.GENERATE_DAILY, async () => {
        await runTask('generateDaily', taskGenerateDaily);
    }, { timezone: CONFIG.TIMEZONE });

    // 3. Health check - a cada 6h
    cron.schedule(CONFIG.SCHEDULES.HEALTH_CHECK, async () => {
        await runTask('healthCheck', taskHealthCheck, { retries: 1 });
    }, { timezone: CONFIG.TIMEZONE });

    logger.success('Tarefas GMB agendadas!', {
        tasks: ['publishScheduled (5min)', 'generateDaily (8h)', 'healthCheck (6h)']
    });
}

// =====================================================================
// MAIN
// =====================================================================

async function main() {
    console.log(chalk.cyan.bold(`
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   📍 GMB CRON - Google Meu Negócio                           ║
║                                                               ║
║   Status: Inicializando...                                   ║
║   Timezone: ${CONFIG.TIMEZONE}                               ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
    `));

    try {
        setupGracefulShutdown();
        await connectDatabase();
        
        // Health check inicial
        await taskHealthCheck();
        
        scheduleTasks();

        console.log(chalk.green.bold(`
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   ✅ GMB CRON INICIADO COM SUCESSO                           ║
║                                                               ║
║   Tarefas:                                                   ║
║   • Publicar agendados: a cada 5 minutos                     ║
║   • Gerar post diário: todo dia 8h                           ║
║   • Health check: a cada 6 horas                             ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
        `));

        process.stdin.resume();
    } catch (error) {
        logger.error('Falha crítica na inicialização', error);
        process.exit(1);
    }
}

main().catch(error => {
    console.error('❌ Erro fatal no GMB Cron:', error);
    process.exit(1);
});

export { taskPublishScheduled, taskGenerateDaily, taskHealthCheck };
