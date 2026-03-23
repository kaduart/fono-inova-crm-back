/**
 * 🛡️ WHATSAPP GUARD - Nível Produção
 * 
 * Blindagem completa contra perda de leads:
 * - Log bruto de TUDO
 * - Captura fail-safe do lead (antes de processar)
 * - Fila com retry automático
 * - Alertas de silêncio e anomalia
 * - Health check
 */

import mongoose from 'mongoose';
import { redisConnection as redis } from '../config/redisConnection.js';
import { getIo } from '../config/socket.js';
import Logger from '../services/utils/Logger.js';
import { sendTemplateMessage } from '../services/whatsappService.js';
import { normalizeE164BR } from '../utils/phone.js';

const logger = new Logger('WhatsAppGuard');

// ============================================================================
// 📝 MODELOS (criados sob demanda se não existirem)
// ============================================================================

const RawWebhookLogSchema = new mongoose.Schema({
    body: { type: mongoose.Schema.Types.Mixed, required: true },
    headers: { type: mongoose.Schema.Types.Mixed },
    receivedAt: { type: Date, default: Date.now },
    processed: { type: Boolean, default: false },
    processedAt: { type: Date },
    error: { type: String }
}, { 
    timestamps: true,
    expireAfterSeconds: 30 * 24 * 60 * 60 // TTL: 30 dias
});

const FailedMessageSchema = new mongoose.Schema({
    wamid: { type: String, required: true },
    from: { type: String, required: true },
    type: { type: String },
    content: { type: String },
    rawBody: { type: mongoose.Schema.Types.Mixed },
    error: { type: String },
    retryCount: { type: Number, default: 0 },
    lastRetryAt: { type: Date },
    resolved: { type: Boolean, default: false }
}, { 
    timestamps: true 
});

const AlertLogSchema = new mongoose.Schema({
    type: { type: String, enum: ['silence', 'anomaly', 'error'], required: true },
    message: { type: String, required: true },
    details: { type: mongoose.Schema.Types.Mixed },
    sentToAdmin: { type: Boolean, default: false }
}, { 
    timestamps: true 
});

// Cria modelos se não existirem (evita erro de recompilação)
const RawWebhookLog = mongoose.models.RawWebhookLog || mongoose.model('RawWebhookLog', RawWebhookLogSchema);
const FailedMessage = mongoose.models.FailedMessage || mongoose.model('FailedMessage', FailedMessageSchema);
const AlertLog = mongoose.models.AlertLog || mongoose.model('AlertLog', AlertLogSchema);

// ============================================================================
// 🚨 SISTEMA DE ALERTAS
// ============================================================================

const ADMIN_PHONE = process.env.ADMIN_ALERT_PHONE; // Seu número pra receber alertas
const ALERT_COOLDOWN = 30 * 60 * 1000; // 30 minutos entre alertas iguais

async function sendAlert(type, message, details = {}) {
    try {
        // Evita spam de alertas
        const lastAlert = await AlertLog.findOne({ type }).sort({ createdAt: -1 });
        if (lastAlert && (Date.now() - lastAlert.createdAt.getTime()) < ALERT_COOLDOWN) {
            logger.info(`[ALERT] Cooldown ativo para ${type}, ignorando`);
            return;
        }

        // Salva no banco
        const alert = await AlertLog.create({
            type,
            message,
            details
        });

        // Envia WhatsApp pro admin (se configurado)
        if (ADMIN_PHONE && type !== 'error') { // erros não mandam WhatsApp (pode ser muito)
            try {
                const emoji = type === 'silence' ? '🚨' : type === 'anomaly' ? '⚠️' : 'ℹ️';
                await sendTemplateMessage({
                    to: normalizeE164BR(ADMIN_PHONE),
                    template: 'alerta_sistema',
                    params: [`${emoji} ${message}`]
                });
                
                await AlertLog.findByIdAndUpdate(alert._id, { sentToAdmin: true });
                logger.info(`[ALERT] WhatsApp enviado para admin: ${message}`);
            } catch (err) {
                logger.error(`[ALERT] Falha ao enviar WhatsApp: ${err.message}`);
            }
        }

        // Log
        logger.warn(`[ALERT] ${type}: ${message}`, details);

        // Socket pro dashboard em tempo real
        const io = getIo();
        if (io) {
            io.emit('system:alert', {
                type,
                message,
                details,
                timestamp: new Date()
            });
        }

    } catch (err) {
        logger.error(`[ALERT] Erro ao enviar alerta: ${err.message}`);
    }
}

// ============================================================================
// ⏱️ MONITORAMENTO DE SILÊNCIO
// ============================================================================

let silenceMonitorStarted = false;

export function startSilenceMonitor() {
    if (silenceMonitorStarted) return;
    silenceMonitorStarted = true;

    const SILENCE_THRESHOLD = parseInt(process.env.SILENCE_THRESHOLD_MINUTES) || 30;
    
    setInterval(async () => {
        try {
            // Verifica última mensagem recebida
            const lastMessage = await RawWebhookLog.findOne({
                'body.entry.changes.value.messages': { $exists: true }
            }).sort({ receivedAt: -1 });

            if (!lastMessage) {
                // Nunca recebeu mensagem - só alerta se já passou 1h do primeiro webhook
                const firstLog = await RawWebhookLog.findOne().sort({ receivedAt: 1 });
                if (firstLog && (Date.now() - firstLog.receivedAt.getTime()) > 60 * 60 * 1000) {
                    await sendAlert('silence', 
                        `Nenhuma mensagem recebida desde ${firstLog.receivedAt.toLocaleString('pt-BR')}. Verifique webhook ou Meta app.`
                    );
                }
                return;
            }

            const minutesSinceLastMessage = (Date.now() - lastMessage.receivedAt.getTime()) / (1000 * 60);

            if (minutesSinceLastMessage > SILENCE_THRESHOLD) {
                await sendAlert('silence',
                    `Nenhuma mensagem há ${Math.floor(minutesSinceLastMessage)} minutos. Última: ${lastMessage.receivedAt.toLocaleString('pt-BR')}`
                );
            }

            // Alerta de anomalia: volume muito baixo
            const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
            const messagesLastHour = await RawWebhookLog.countDocuments({
                'body.entry.changes.value.messages': { $exists: true },
                receivedAt: { $gte: oneHourAgo }
            });

            // Se durante horário comercial (8h-20h) e menos de 2 mensagens/hora
            const hour = new Date().getHours();
            const isBusinessHours = hour >= 8 && hour <= 20;
            
            if (isBusinessHours && messagesLastHour < 2) {
                const last24h = await RawWebhookLog.countDocuments({
                    'body.entry.changes.value.messages': { $exists: true },
                    receivedAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
                });

                if (last24h > 20) { // Só alerta se normalmente tem volume
                    await sendAlert('anomaly',
                        `Volume anormal: apenas ${messagesLastHour} mensagem(ns) na última hora (esperado: >5)`
                    );
                }
            }

        } catch (err) {
            logger.error(`[SILENCE-MONITOR] Erro: ${err.message}`);
        }
    }, 5 * 60 * 1000); // Roda a cada 5 minutos

    logger.info('[SILENCE-MONITOR] Iniciado - verificando a cada 5 min');
}

// ============================================================================
// 🔄 FILA DE RETRY
// ============================================================================

let retryWorkerStarted = false;

export function startRetryWorker() {
    if (retryWorkerStarted) return;
    retryWorkerStarted = true;

    const RETRY_INTERVALS = [30, 120, 300, 600]; // segundos: 30s, 2min, 5min, 10min

    setInterval(async () => {
        try {
            const failedMessages = await FailedMessage.find({
                resolved: false,
                retryCount: { $lt: RETRY_INTERVALS.length }
            }).sort({ createdAt: -1 }).limit(10);

            for (const failed of failedMessages) {
                const nextRetryIndex = failed.retryCount;
                const secondsSinceLastRetry = failed.lastRetryAt 
                    ? (Date.now() - failed.lastRetryAt.getTime()) / 1000 
                    : Infinity;

                // Só tenta se já passou o tempo adequado
                if (secondsSinceLastRetry < RETRY_INTERVALS[nextRetryIndex]) {
                    continue;
                }

                logger.info(`[RETRY] Tentativa ${failed.retryCount + 1} para ${failed.wamid}`);

                try {
                    // Reprocessa a mensagem
                    const { processInboundMessage } = await import('../controllers/whatsappController.js');
                    
                    // Reconstrói a mensagem do rawBody
                    const msg = failed.rawBody?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
                    const value = failed.rawBody?.entry?.[0]?.changes?.[0]?.value;

                    if (msg) {
                        await processInboundMessage(msg, value);
                        
                        // Sucesso!
                        failed.resolved = true;
                        await failed.save();
                        
                        logger.info(`[RETRY] ✅ Sucesso para ${failed.wamid}`);
                        
                        // Notifica
                        const io = getIo();
                        if (io) {
                            io.emit('system:retry_success', {
                                wamid: failed.wamid,
                                from: failed.from,
                                retryCount: failed.retryCount + 1
                            });
                        }
                    }

                } catch (err) {
                    failed.retryCount++;
                    failed.lastRetryAt = new Date();
                    failed.error = err.message;
                    await failed.save();
                    
                    logger.error(`[RETRY] ❌ Falha ${failed.retryCount} para ${failed.wamid}: ${err.message}`);
                }
            }

        } catch (err) {
            logger.error(`[RETRY-WORKER] Erro: ${err.message}`);
        }
    }, 30 * 1000); // Verifica a cada 30 segundos

    logger.info('[RETRY-WORKER] Iniciado');
}

// ============================================================================
// 🛡️ MIDDLEWARE PRINCIPAL - whatsappGuard
// ============================================================================

export async function whatsappGuard(req, res, next) {
    const startTime = Date.now();
    
    try {
        // 🥇 1. LOG BRUTO (NUNCA FALHA)
        let rawLog;
        try {
            rawLog = await RawWebhookLog.create({
                body: req.body,
                headers: req.headers,
                receivedAt: new Date()
            });
        } catch (logErr) {
            // Se não conseguir logar, ainda assim continua
            logger.error(`[GUARD] Falha ao criar log bruto: ${logErr.message}`);
        }

        const change = req.body.entry?.[0]?.changes?.[0];
        const value = change?.value;
        const msg = value?.messages?.[0];

        // Se não é mensagem (status delivery, etc), apenas passa adiante
        if (!msg) {
            if (rawLog) {
                await RawWebhookLog.findByIdAndUpdate(rawLog._id, { processed: true, processedAt: new Date() });
            }
            return next();
        }

        const from = normalizeE164BR(msg.from);
        const wamid = msg.id;

        logger.info(`[GUARD] Mensagem recebida: ${wamid} de ${from}`);

        // 🥈 2. CAPTURA FAIL-SAFE DO LEAD (antes de qualquer processamento)
        try {
            const Lead = mongoose.models.Lead;
            if (Lead) {
                await Lead.updateOne(
                    { 'contact.phone': from },
                    {
                        $setOnInsert: {
                            'contact.phone': from,
                            origin: 'WhatsApp',
                            createdAt: new Date(),
                            lastMessageAt: new Date()
                        },
                        $set: {
                            lastMessageAt: new Date(),
                            lastInboundMessage: msg.text?.body || `[${msg.type}]`,
                            'metadata.guardCaptured': true
                        }
                    },
                    { upsert: true }
                );
                logger.info(`[GUARD] Lead capturado/atualizado: ${from}`);
            }
        } catch (leadErr) {
            logger.error(`[GUARD] Falha ao capturar lead (crítico!): ${leadErr.message}`);
            // Salva para retry manual depois
            await FailedMessage.create({
                wamid,
                from,
                type: msg.type,
                content: msg.text?.body,
                rawBody: req.body,
                error: `Lead capture failed: ${leadErr.message}`
            });
        }

        // 🥉 3. Atualiza log como processado
        if (rawLog) {
            await RawWebhookLog.findByIdAndUpdate(rawLog._id, { processed: true, processedAt: new Date() });
        }

        // ✅ Passa pro controller normal
        next();

    } catch (err) {
        logger.error(`[GUARD] Erro crítico: ${err.message}`);
        
        // Mesmo com erro, tenta salvar o lead
        try {
            const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
            if (msg?.from) {
                await FailedMessage.create({
                    wamid: msg.id,
                    from: normalizeE164BR(msg.from),
                    type: msg.type,
                    content: msg.text?.body,
                    rawBody: req.body,
                    error: `Guard error: ${err.message}`
                });
            }
        } catch {}

        // SEMPRE responde 200 pro Meta (nunca deixar retry infinito)
        res.sendStatus(200);
    }
}

// ============================================================================
// ❤️ HEALTH CHECK
// ============================================================================

export async function healthCheck(req, res) {
    const checks = {
        database: false,
        redis: false,
        lastWebhook: null,
        failedMessages: 0,
        timestamp: new Date()
    };

    try {
        // Check MongoDB
        await mongoose.connection.db.admin().ping();
        checks.database = true;
    } catch (err) {
        logger.error(`[HEALTH] MongoDB: ${err.message}`);
    }

    try {
        // Check Redis
        if (redis) {
            await redis.ping();
            checks.redis = true;
        }
    } catch (err) {
        logger.error(`[HEALTH] Redis: ${err.message}`);
    }

    // Estatísticas
    checks.lastWebhook = await RawWebhookLog.findOne().sort({ receivedAt: -1 }).select('receivedAt');
    checks.failedMessages = await FailedMessage.countDocuments({ resolved: false });

    const isHealthy = checks.database && (checks.redis || !redis);

    res.status(isHealthy ? 200 : 503).json({
        status: isHealthy ? 'healthy' : 'degraded',
        ...checks,
        uptime: process.uptime()
    });
}

// ============================================================================
// 📊 DASHBOARD DE MONITORAMENTO
// ============================================================================

export async function getGuardStats(req, res) {
    try {
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const last24h = new Date(now - 24 * 60 * 60 * 1000);

        const stats = await Promise.all([
            // Total de webhooks hoje
            RawWebhookLog.countDocuments({ receivedAt: { $gte: today } }),
            
            // Total de webhooks últimas 24h
            RawWebhookLog.countDocuments({ receivedAt: { $gte: last24h } }),
            
            // Mensagens processadas
            RawWebhookLog.countDocuments({ 
                receivedAt: { $gte: last24h },
                processed: true 
            }),
            
            // Falhas pendentes
            FailedMessage.countDocuments({ resolved: false }),
            
            // Falhas resolvidas hoje
            FailedMessage.countDocuments({ 
                resolved: true,
                updatedAt: { $gte: today }
            }),
            
            // Últimos alertas
            AlertLog.find().sort({ createdAt: -1 }).limit(10).lean(),
            
            // Volume por hora (últimas 6h)
            RawWebhookLog.aggregate([
                { $match: { receivedAt: { $gte: new Date(now - 6 * 60 * 60 * 1000) } } },
                {
                    $group: {
                        _id: { $hour: '$receivedAt' },
                        count: { $sum: 1 }
                    }
                },
                { $sort: { _id: 1 } }
            ])
        ]);

        res.json({
            success: true,
            stats: {
                webhooksToday: stats[0],
                webhooks24h: stats[1],
                processed24h: stats[2],
                pendingFailures: stats[3],
                resolvedToday: stats[4],
                recentAlerts: stats[5],
                hourlyVolume: stats[6]
            }
        });

    } catch (err) {
        logger.error(`[STATS] Erro: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
}

// ============================================================================
// 🚀 INICIALIZAÇÃO
// ============================================================================

export function initWhatsAppGuard() {
    startSilenceMonitor();
    startRetryWorker();
    logger.info('🛡️ WhatsApp Guard inicializado');
}
