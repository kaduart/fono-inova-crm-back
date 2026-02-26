// =====================================================================
// GMB CRON - Geração automática de posts do Google Meu Negócio
// =====================================================================
// Publicação via Make (Integromat) — ver makeService.js
//
// Schedules:
// - Diariamente 8h: Gera post do dia automaticamente
// - Diariamente 8h05: Envia posts agendados para o Make publicar
//
// =====================================================================

import chalk from 'chalk';
import mongoose from 'mongoose';
import cron from 'node-cron';
import * as gmbService from '../services/gmbService.js';
import * as makeService from '../services/makeService.js';
import GmbPost from '../models/GmbPost.js';

// =====================================================================
// CONFIGURAÇÕES
// =====================================================================

const CONFIG = {
    TIMEZONE: 'America/Sao_Paulo',

    SCHEDULES: {
        GENERATE_DAILY: '0 8 * * *',      // Todo dia 8h da manhã
        SEND_TO_MAKE:   '5 8,12,15,19 * * *',  // 8h05, 12h05, 15h05, 19h05 — envia para Make publicar
    },

    MAX_RETRIES: 3,
    RETRY_DELAY: 30000,
    TASK_TIMEOUT: 2 * 60 * 1000,
};

// =====================================================================
// LOGGER
// =====================================================================

const logger = {
    info: (msg, data = {}) => {
        const timestamp = new Date().toLocaleString('pt-BR', { timeZone: CONFIG.TIMEZONE });
        console.log(chalk.blue(`[${timestamp}] [GMB] ${msg}`), Object.keys(data).length ? JSON.stringify(data) : '');
    },
    success: (msg, data = {}) => {
        const timestamp = new Date().toLocaleString('pt-BR', { timeZone: CONFIG.TIMEZONE });
        console.log(chalk.green(`[${timestamp}] [GMB] ${msg}`), Object.keys(data).length ? JSON.stringify(data) : '');
    },
    warn: (msg, data = {}) => {
        const timestamp = new Date().toLocaleString('pt-BR', { timeZone: CONFIG.TIMEZONE });
        console.warn(chalk.yellow(`[${timestamp}] [GMB] ${msg}`), Object.keys(data).length ? JSON.stringify(data) : '');
    },
    error: (msg, error, data = {}) => {
        const timestamp = new Date().toLocaleString('pt-BR', { timeZone: CONFIG.TIMEZONE });
        console.error(chalk.red(`[${timestamp}] [GMB] ${msg}`), { error: error?.message || error, ...data });
    },
};

// =====================================================================
// CONTROLE DE EXECUÇÃO
// =====================================================================
let isShuttingDown = false;
const taskLocks = new Map();

async function runTask(taskName, taskFn, options = {}) {
    if (isShuttingDown) return;

    const { timeout = CONFIG.TASK_TIMEOUT, retries = CONFIG.MAX_RETRIES } = options;

    if (taskLocks.get(taskName)) {
        logger.warn(`Tarefa ${taskName} já está rodando — pulando`);
        return;
    }

    taskLocks.set(taskName, true);
    logger.info(`→ ${taskName} iniciada`);

    let lastError;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const result = await Promise.race([
                taskFn(),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Task timeout')), timeout)
                )
            ]);
            logger.success(`✓ ${taskName} concluída`);
            taskLocks.delete(taskName);
            return result;
        } catch (error) {
            lastError = error;
            logger.error(`Tentativa ${attempt}/${retries} falhou: ${taskName}`, error);
            if (attempt < retries) {
                await new Promise(r => setTimeout(r, CONFIG.RETRY_DELAY));
            }
        }
    }

    taskLocks.delete(taskName);
    throw lastError;
}

// =====================================================================
// TAREFAS
// =====================================================================

/**
 * TASK 1: Gerar post do dia
 * Verifica se já existe post hoje antes de gerar
 */
async function taskGenerateDaily() {
    logger.info('Verificando se já existe post do dia...');

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const existing = await GmbPost.countDocuments({
        createdAt: { $gte: today, $lt: tomorrow },
        status: { $in: ['ready', 'scheduled', 'published'] }
    });

    if (existing > 0) {
        logger.info('Post do dia já existe — pulando geração');
        return;
    }

    const result = await gmbService.createDailyPost({ generateImage: true });

    if (result.success) {
        logger.success('Post do dia gerado!', { especialidade: result.especialidade.nome });
    }

    return result;
}

/**
 * TASK 2: Enviar posts agendados para o Make publicar
 * Busca posts com status 'scheduled' cujo scheduledAt já passou e envia ao Make
 */
async function taskSendToMake() {
    if (!makeService.isMakeConfigured()) {
        logger.warn('Make não configurado (MAKE_WEBHOOK_URL ausente) — pulando');
        return;
    }

    logger.info('Buscando posts agendados para enviar ao Make...');

    const posts = await GmbPost.findScheduledForPublish(5);

    if (posts.length === 0) {
        logger.info('Nenhum post agendado para publicar');
        return;
    }

    let sent = 0, failed = 0;

    for (const post of posts) {
        try {
            await makeService.sendPostToMake(post);
            post.status = 'published';
            post.publishedAt = new Date();
            post.publishedBy = 'cron';
            await post.save();
            sent++;
            logger.success(`Post enviado ao Make: ${post.title?.substring(0, 40)}`);
        } catch (error) {
            await post.markFailed(error.message);
            failed++;
            logger.error(`Falha ao enviar post ao Make`, error, { postId: post._id });
        }

        // Pausa entre envios
        await new Promise(r => setTimeout(r, 2000));
    }

    logger.success(`Make: ${sent} enviados, ${failed} falharam`);
    return { sent, failed };
}

// =====================================================================
// INICIALIZAÇÃO
// =====================================================================

async function connectDatabase() {
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI não definido');

    for (let attempt = 1; attempt <= 5; attempt++) {
        try {
            await mongoose.connect(process.env.MONGO_URI, {
                serverSelectionTimeoutMS: 10000,
                socketTimeoutMS: 45000,
            });
            logger.success('MongoDB conectado');
            return;
        } catch (error) {
            logger.error(`MongoDB tentativa ${attempt}/5`, error);
            if (attempt < 5) await new Promise(r => setTimeout(r, 5000 * attempt));
        }
    }
    throw new Error('Falha ao conectar MongoDB');
}

function setupGracefulShutdown() {
    const shutdown = async (signal) => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        logger.warn(`Sinal ${signal} — iniciando shutdown...`);

        const timeout = setTimeout(() => process.exit(1), 30000);
        try {
            while (taskLocks.size > 0) await new Promise(r => setTimeout(r, 1000));
            await mongoose.connection.close();
            clearTimeout(timeout);
            process.exit(0);
        } catch {
            process.exit(1);
        }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

function scheduleTasks() {
    logger.info('Agendando tarefas GMB...', { timezone: CONFIG.TIMEZONE });

    cron.schedule(CONFIG.SCHEDULES.GENERATE_DAILY, async () => {
        await runTask('generateDaily', taskGenerateDaily);
    }, { timezone: CONFIG.TIMEZONE });

    cron.schedule(CONFIG.SCHEDULES.SEND_TO_MAKE, async () => {
        await runTask('sendToMake', taskSendToMake);
    }, { timezone: CONFIG.TIMEZONE });

    logger.success('Tarefas GMB agendadas!', {
        tasks: ['generateDaily (8h)', 'sendToMake (8h05, 12h05, 15h05, 19h05)']
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
║   Publicação via Make (Integromat)                           ║
║   Timezone: ${CONFIG.TIMEZONE}                               ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
    `));

    try {
        setupGracefulShutdown();
        await connectDatabase();
        scheduleTasks();

        logger.success('GMB Cron iniciado', {
            makeConfigurado: makeService.isMakeConfigured()
        });

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

export { taskGenerateDaily, taskSendToMake };
