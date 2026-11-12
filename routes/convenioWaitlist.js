// routes/convenioWaitlist.js
// Lista de INTERESSE em convênios (GEAP/IPASGO/Bradesco) — cadastro público vindo do site + gestão pelo CRM.
import express from 'express';
import rateLimit from 'express-rate-limit';
import moment from 'moment-timezone';
import {
    CONVENIO_LABELS,
    CONVENIOS_WAITLIST,
    WAITLIST_ACTIVE_STATUS,
    WAITLIST_STATUS,
    waitlistActiveKey,
} from '../constants/convenioWaitlist.js';
import { auth, authorize } from '../middleware/auth.js';
import validateId from '../middleware/validateId.js';
import ConvenioWaitlist from '../models/ConvenioWaitlist.js';
import { parseWaitlistPayload } from '../utils/convenioWaitlistPayload.js';
import { sendApiError } from '../errors/buildErrorResponse.js';
import { AppError } from '../errors/AppError.js';
import WhatsAppScanRun from '../models/WhatsAppScanRun.js';
import { patientMatchesByPhone } from '../services/convenioWaitlistWhatsapp.js';

// Varredura recente ainda em andamento: não enfileira outra para o mesmo convênio.
const SCAN_STALE_MS = 2 * 60 * 60 * 1000;
const SCAN_DEEP_STALE_MS = 7 * 24 * 60 * 60 * 1000; // a profunda pode levar dias (worker só roda em horário comercial)
const CHAT_ACTIVITY_FRESH_MS = 20 * 60 * 1000; // conferência da "última conversa" vale 20 min para a prévia do envio em massa

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isDuplicateKeyError = (err) => err?.code === 11000;

/**
 * Rate limit do cadastro público, por IP do visitante.
 * A chave é `req.ip`; atrás do proxy do Render ela só é o IP real do visitante se o app estiver com
 * `trust proxy` configurado (ver config/trustProxy.js). NÃO ler X-Forwarded-For manualmente aqui.
 */
const buildSubmitLimiter = (options = {}) => rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Muitas tentativas. Tente novamente em alguns minutos.' },
    handler: (req, res, _next, limiterOptions) => {
        console.warn('⚠️ [WAITLIST] limite de cadastros atingido para o IP', req.ip);
        res.status(limiterOptions.statusCode).json(limiterOptions.message);
    },
    ...options,
});

export const createConvenioWaitlistRouter = ({ submitLimit = {} } = {}) => {
    const router = express.Router();
    const submitLimiter = buildSubmitLimiter(submitLimit);

    // =====================================================================
    // 🌐 PÚBLICO (sem auth) — cadastro vindo do site
    // =====================================================================
    router.post('/', submitLimiter, async (req, res) => {
        try {
            const parsed = parseWaitlistPayload(req.body);
            if (!parsed.ok) {
                return sendApiError(res, new AppError('BAD_REQUEST', parsed.message, { status: 400 }), req);
            }
            const data = parsed.value;
            const now = new Date();
            const activeKey = waitlistActiveKey(data.phone, data.convenio);

            const latestFields = {};
            if (data.especialidade) latestFields.especialidade = data.especialidade;
            if (data.idadeCrianca !== null) latestFields.idadeCrianca = data.idadeCrianca;
            if (data.periodo) latestFields.periodo = data.periodo;

            // Upsert ATÔMICO pela chave do cadastro ativo (índice único parcial): dois POSTs simultâneos
            // da mesma pessoa/convênio resultam em exatamente um documento ativo.
            const buildUpdate = () => ({
                $setOnInsert: {
                    name: data.name,
                    phone: data.phone,
                    convenio: data.convenio,
                    status: 'aguardando',
                    activeKey,
                    email: data.email,
                    source: data.source,
                    consent: { accepted: true, acceptedAt: now, version: data.consentVersion },
                },
                ...(Object.keys(latestFields).length ? { $set: latestFields } : {}),
                $inc: { requestCount: 1 },
                $push: {
                    submissions: {
                        $each: [{
                            especialidade: data.especialidade,
                            idadeCrianca: data.idadeCrianca,
                            periodo: data.periodo,
                            consentVersion: data.consentVersion,
                            at: now,
                        }],
                        $slice: -20,
                    },
                },
            });

            const upsert = () => ConvenioWaitlist.findOneAndUpdate({ activeKey }, buildUpdate(), {
                upsert: true,
                new: true,
                setDefaultsOnInsert: true,
                runValidators: true,
                includeResultMetadata: true,
            });

            let result;
            try {
                result = await upsert();
            } catch (err) {
                // Dois upserts simultâneos: o perdedor recebe E11000 do índice único; repetir cai no update
                if (!isDuplicateKeyError(err)) throw err;
                result = await upsert();
            }

            const doc = result.value;
            const duplicate = Boolean(result.lastErrorObject?.updatedExisting);

            // Reenvio: completa o e-mail (opcional) só se o cadastro ativo ainda não tinha
            if (duplicate && data.email) {
                await ConvenioWaitlist.updateOne({ _id: doc._id, email: null }, { $set: { email: data.email } });
            }

            if (!duplicate) {
                console.log(`📋 [WAITLIST] Novo interesse ${CONVENIO_LABELS[data.convenio]}: ${doc._id}`);
            }
            return res.status(duplicate ? 200 : 201).json({ success: true, id: doc._id, duplicate });
        } catch (err) {
            console.error('❌ [WAITLIST] Erro ao registrar interesse:', err);
            return sendApiError(
              res,
              new AppError('INTERNAL_ERROR', 'Erro interno ao registrar interesse', {
                status: 500,
              }),
              req
            );
        }
    });

    // =====================================================================
    // 🔒 PROTEGIDO — gestão pelo CRM (admin / secretary)
    // =====================================================================
    router.use(auth);

    /**
     * GET /api/convenio-waitlist/summary
     * Totais por convênio e status (cabeçalho da página do CRM)
     */
    router.get('/summary', authorize(['admin', 'secretary']), async (req, res) => {
        try {
            const rows = await ConvenioWaitlist.aggregate([
                { $group: { _id: { convenio: '$convenio', status: '$status' }, count: { $sum: 1 } } },
            ]);

            const porConvenio = {};
            CONVENIOS_WAITLIST.forEach((slug) => {
                porConvenio[slug] = { label: CONVENIO_LABELS[slug], total: 0 };
                WAITLIST_STATUS.forEach((status) => { porConvenio[slug][status] = 0; });
            });

            let total = 0;
            rows.forEach(({ _id, count }) => {
                if (!porConvenio[_id.convenio]) return;
                porConvenio[_id.convenio][_id.status] = count;
                porConvenio[_id.convenio].total += count;
                total += count;
            });

            // Vendas & Marketing: quanto tempo as famílias ativas estão esperando e quantas já agendaram no mês
            const now = Date.now();
            const monthStart = moment().tz('America/Sao_Paulo').startOf('month').toDate();
            const ageRows = await ConvenioWaitlist.aggregate([
                { $match: { $or: [{ status: { $in: WAITLIST_ACTIVE_STATUS } }, { status: 'agendado', updatedAt: { $gte: monthStart } }] } },
                { $group: {
                    _id: '$convenio',
                    active: { $sum: { $cond: [{ $in: ['$status', WAITLIST_ACTIVE_STATUS] }, 1, 0] } },
                    aged30: { $sum: { $cond: [{ $and: [{ $in: ['$status', WAITLIST_ACTIVE_STATUS] }, { $lte: ['$createdAt', new Date(now - 30 * 864e5)] }] }, 1, 0] } },
                    waitMsSum: { $sum: { $cond: [{ $in: ['$status', WAITLIST_ACTIVE_STATUS] }, { $subtract: [new Date(now), '$createdAt'] }, 0] } },
                    scheduledMonth: { $sum: { $cond: [{ $eq: ['$status', 'agendado'] }, 1, 0] } },
                } },
            ]);
            const insights = { active: 0, aged30: 0, scheduledMonth: 0, avgDays: 0, potentialMonthly: 0, porConvenio: {} };
            let waitMs = 0;
            ageRows.forEach((r) => {
                if (!porConvenio[r._id]) return;
                insights.porConvenio[r._id] = {
                    active: r.active, aged30: r.aged30, scheduledMonth: r.scheduledMonth,
                    avgDays: r.active ? Math.round(r.waitMsSum / r.active / 864e5) : 0,
                };
                insights.active += r.active; insights.aged30 += r.aged30; insights.scheduledMonth += r.scheduledMonth;
                waitMs += r.waitMsSum;
            });
            insights.avgDays = insights.active ? Math.round(waitMs / insights.active / 864e5) : 0;
            // Pacote 1x/semana: R$ 180/sessão (~R$ 720/mês) por família
            insights.potentialMonthly = insights.active * 720;

            return res.json({ total, porConvenio, insights });
        } catch (err) {
            console.error('❌ [WAITLIST] Erro no resumo:', err);
            return sendApiError(
              res,
              new AppError('INTERNAL_ERROR', 'Erro ao buscar resumo da lista de interesse', {
                status: 500,
              }),
              req
            );
        }
    });

    /**
     * POST /api/convenio-waitlist/whatsapp-scan  Body: { convenio } | { deep: true }
     * Enfileira a varredura SÓ LEITURA do WhatsApp Web (fila whatsapp-scan, roda no crm-worker).
     * - { convenio }: busca rápida (lupa do WhatsApp, só o que está no navegador, ~2 meses).
     * - { deep: true }: conversa por conversa, puxando o histórico antigo do celular, os 4 convênios
     *   de uma vez. Retoma sozinha se o worker reiniciar. Depois da 1ª completa é INCREMENTAL: só lê as
     *   mensagens a partir da última busca concluída (minutos em vez de horas). { deep: true, full: true } relê tudo.
     * Quem falou do convênio entra na lista como 'aguardando' (channel whatsapp_web). Idempotente:
     * se já há uma varredura do mesmo tipo na fila/rodando, devolve ela em vez de criar outra.
     */
    router.post('/whatsapp-scan', authorize(['admin', 'secretary']), async (req, res) => {
        try {
            const deep = req.body?.deep === true;
            const convenio = deep ? 'todos' : String(req.body?.convenio || '');
            if (!deep && !CONVENIOS_WAITLIST.includes(convenio)) {
                return sendApiError(res, new AppError('BAD_REQUEST', 'Convênio inválido', { status: 400 }), req);
            }
            const kind = deep ? 'convenio_interest_deep' : 'convenio_interest';
            const pending = await WhatsAppScanRun.findOne({
                kind, convenio,
                status: { $in: ['queued', 'running'] },
                createdAt: { $gte: new Date(Date.now() - (deep ? SCAN_DEEP_STALE_MS : SCAN_STALE_MS)) },
            }).sort({ createdAt: -1 }).lean();
            if (pending) return res.status(200).json({ run: pending, alreadyRunning: true });

            // Profunda incremental: se já houve uma completa, só lê dali para frente (1 dia de folga).
            // { full: true } força reler tudo (3 anos).
            let since = null;
            if (deep && req.body?.full !== true) {
                const lastDone = await WhatsAppScanRun.findOne({ kind, convenio, status: 'done' }).sort({ createdAt: -1 }).select('startedAt createdAt').lean();
                const base = lastDone?.startedAt || lastDone?.createdAt;
                if (base) since = new Date(new Date(base).getTime() - 24 * 3600 * 1000);
            }
            const run = await WhatsAppScanRun.create({ kind, convenio, requestedBy: req.user?._id || req.user?.id || null, since });
            const { whatsappScanQueue } = await import('../config/bullConfig.js');
            await whatsappScanQueue.add(
                deep ? 'convenio-interest-deep' : 'convenio-interest',
                { runId: String(run._id), convenio, deep, since: since ? since.toISOString() : null },
                { jobId: `${deep ? 'convenio-interest-deep' : 'convenio-interest'}-${run._id}`, ...(deep ? { attempts: 10 } : {}) },
            );
            console.log(`🔎 [WAITLIST] varredura ${deep ? 'profunda' : 'rápida'} do WhatsApp enfileirada (${deep ? 'todos' : CONVENIO_LABELS[convenio]}): ${run._id}`);
            return res.status(202).json({ run: run.toObject(), alreadyRunning: false });
        } catch (err) {
            console.error('❌ [WAITLIST] Erro ao enfileirar varredura:', err);
            return sendApiError(res, new AppError('INTERNAL_ERROR', 'Erro ao iniciar a busca no WhatsApp', { status: 500 }), req);
        }
    });

    /**
     * Garante que a "última conversa" da lista foi conferida no WhatsApp há pouco (CHAT_ACTIVITY_FRESH_MS).
     * Se não, enfileira a conferência (SÓ LEITURA, no worker). Idempotente: uma por vez.
     * @returns {{ status: 'queued'|'running'|'done'|'failed', finishedAt: Date|null }}
     */
    async function ensureChatActivitySync(userId) {
        try {
            const last = await WhatsAppScanRun.findOne({ kind: 'chat_activity', convenio: 'todos' }).sort({ createdAt: -1 }).lean();
            const pending = last && ['queued', 'running'].includes(last.status) && Date.now() - new Date(last.createdAt).getTime() < SCAN_STALE_MS;
            const fresh = last?.status === 'done' && Date.now() - new Date(last.finishedAt).getTime() < CHAT_ACTIVITY_FRESH_MS;
            if (pending || fresh) return { status: last.status, finishedAt: last.finishedAt || null };
            const run = await WhatsAppScanRun.create({ kind: 'chat_activity', convenio: 'todos', requestedBy: userId });
            const { whatsappScanQueue } = await import('../config/bullConfig.js');
            await whatsappScanQueue.add('chat-activity', { runId: String(run._id), convenio: 'todos', activity: true }, { jobId: `chat-activity-${run._id}` });
            return { status: 'queued', finishedAt: last?.finishedAt || null };
        } catch (err) {
            console.warn('⚠️ [WAITLIST] conferência das conversas não enfileirada (segue a prévia):', err.message);
            return { status: 'failed', finishedAt: null };
        }
    }

    /**
     * POST /api/convenio-waitlist/bulk-offer
     * Body: { kind: 'particular'|'credenciado', convenio?, especialidades?, atendente?, excludeIds?: string[], confirm?: boolean }
     * Envio em massa pelo WhatsApp. Sem confirm (ou false) = só prévia, não envia nada.
     * A prévia lista quem vai receber (recipients) e quem fica de fora com o motivo (skipped); excludeIds = desmarcados.
     * Fica de fora quem já recebeu, quem conversou com a clínica há pouco (inclusive na mão) e, no particular,
     * quem tem sessão marcada. O worker confere a conversa de novo logo antes de cada envio.
     * - particular: oferta do particular (aguardando, pula quem tem sessão futura).
     * - credenciado: "agora atendemos o plano" — exige convênio; vai para aguardando e contatados.
     * Com confirm=true agenda TODOS de uma vez, espalhados em dias úteis: 1 msg a cada ~90s, teto diário (soma dos dois) e janela 08:00–18:45.
     */
    router.post('/bulk-offer', authorize(['admin', 'secretary']), async (req, res) => {
        try {
            const kind = req.body?.kind === 'credenciado' ? 'credenciado' : 'particular';
            const convenio = req.body?.convenio ? String(req.body.convenio) : null;
            if (convenio && !CONVENIOS_WAITLIST.includes(convenio)) {
                return sendApiError(res, new AppError('BAD_REQUEST', 'Convênio inválido', { status: 400 }), req);
            }
            if (kind === 'credenciado' && !convenio) {
                return sendApiError(res, new AppError('BAD_REQUEST', 'Escolha qual convênio foi credenciado', { status: 400 }), req);
            }
            const especialidades = String(req.body?.especialidades || '').slice(0, 120);
            const atendente = String(req.body?.atendente || '').slice(0, 40);
            const excludeIds = Array.isArray(req.body?.excludeIds) ? req.body.excludeIds.map(String).slice(0, 1000) : [];
            const { planBulkOffer, enqueueBulkOffer } = await import('../services/convenioWaitlistOffer.js');
            const plan = await planBulkOffer({ kind, convenio, especialidades, atendente, excludeIds });
            // Prévia: confere no WhatsApp quem conversou com a clínica há pouco (fila whatsapp-scan, no worker).
            const activity = req.body?.confirm === true ? null : await ensureChatActivitySync(req.user?._id || req.user?.id || null);
            const preview = {
                kind,
                eligible: plan.eligible,
                willSend: plan.batch.length,
                unchecked: plan.unchecked,
                skippedWithSession: plan.skippedWithSession,
                skippedRecentChat: plan.skippedRecentChat,
                alreadySent: plan.alreadySent,
                markedContatado: plan.markedContatado,
                recentDays: plan.recentDays,
                sentToday: plan.sentToday,
                capacity: plan.capacity,
                todayCount: plan.todayCount,
                days: plan.days,
                finishesAt: plan.finishesAt,
                limitReason: plan.limitReason,
                sample: plan.sample,
                recipients: plan.recipients,
                skipped: plan.skipped,
                activity,
            };
            if (req.body?.confirm !== true || !plan.batch.length) return res.json({ preview, queued: 0 });

            const { whatsappSendQueue } = await import('../config/bullConfig.js');
            const { queued, failed, finishesAt } = await enqueueBulkOffer({
                kind,
                batch: plan.batch,
                queue: whatsappSendQueue,
                especialidades,
                atendente,
                userId: req.user?._id || req.user?.id || null,
            });
            return res.status(202).json({ preview, queued, failed, finishesAt });
        } catch (err) {
            console.error('❌ [WAITLIST] Erro no envio em massa:', err);
            return sendApiError(res, new AppError('INTERNAL_ERROR', 'Erro ao preparar o envio em massa', { status: 500 }), req);
        }
    });

    /**
     * POST /api/convenio-waitlist/:id/whatsapp
     * Body: { kind: 'particular'|'credenciado', message?, especialidades?, atendente?, confirm?: boolean }
     * Envio individual pelo WhatsApp da clínica (fila whatsapp-send), igual à agenda externa: não abre o wa.me.
     * Sem confirm = devolve só o texto pronto (prévia). Com confirm=true envia `message` (editado) ou o texto pronto.
     */
    router.post('/:id/whatsapp', authorize(['admin', 'secretary']), validateId, async (req, res) => {
        try {
            const kind = req.body?.kind === 'credenciado' ? 'credenciado' : 'particular';
            const entry = await ConvenioWaitlist.findById(req.params.id).select('_id name phone convenio especialidade status').lean();
            if (!entry) return sendApiError(res, new AppError('NOT_FOUND', 'Cadastro não encontrado', { status: 404 }), req);
            const especialidades = String(req.body?.especialidades || '').slice(0, 120);
            const atendente = String(req.body?.atendente || '').slice(0, 40);
            const { previewSingle, sendSingle } = await import('../services/convenioWaitlistOffer.js');
            if (req.body?.confirm !== true) {
                return res.json({ message: previewSingle({ entry, kind, especialidades, atendente }), sent: false });
            }
            const message = String(req.body?.message || '').slice(0, 2000);
            const { whatsappSendQueue } = await import('../config/bullConfig.js');
            const r = await sendSingle({ entry, kind, message, especialidades, atendente, queue: whatsappSendQueue, userId: req.user?._id || req.user?.id || null });
            return res.status(202).json({ sent: true, jobId: r.jobId });
        } catch (err) {
            console.error('❌ [WAITLIST] Erro no envio individual:', err);
            return sendApiError(res, new AppError('INTERNAL_ERROR', 'Erro ao enviar pelo WhatsApp', { status: 500 }), req);
        }
    });

    /**
     * GET /api/convenio-waitlist/whatsapp-scan/latest?convenio=geap | ?deep=true
     * Última varredura (para a tela mostrar "buscando…", o progresso e o resultado).
     */
    router.get('/whatsapp-scan/latest', authorize(['admin', 'secretary']), async (req, res) => {
        try {
            const deep = req.query.deep === 'true';
            const convenio = deep ? 'todos' : String(req.query.convenio || '');
            if (!deep && !CONVENIOS_WAITLIST.includes(convenio)) {
                return sendApiError(res, new AppError('BAD_REQUEST', 'Convênio inválido', { status: 400 }), req);
            }
            const kind = deep ? 'convenio_interest_deep' : 'convenio_interest';
            const run = await WhatsAppScanRun.findOne({ kind, convenio }).sort({ createdAt: -1 }).lean();
            return res.json({ run: run || null });
        } catch (err) {
            console.error('❌ [WAITLIST] Erro ao ler varredura:', err);
            return sendApiError(res, new AppError('INTERNAL_ERROR', 'Erro ao ler a busca no WhatsApp', { status: 500 }), req);
        }
    });

    /**
     * GET /api/convenio-waitlist
     * Filtros: convenio, status, channel (site|whatsapp_web), especialidade, search (nome/telefone/e-mail), from, to, page, limit
     * Ordenação: order=asc (ordem de chegada) | desc (mais recentes primeiro, padrão)
     */
    router.get('/', authorize(['admin', 'secretary']), async (req, res) => {
        try {
            const { convenio, status, especialidade, search, from, to } = req.query;
            const pageNumber = Math.max(parseInt(req.query.page, 10) || 1, 1);
            const limitNumber = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);

            const filters = {};
            if (convenio && CONVENIOS_WAITLIST.includes(String(convenio))) filters.convenio = String(convenio);
            if (status && WAITLIST_STATUS.includes(String(status))) filters.status = String(status);
            if (especialidade) filters.especialidade = String(especialidade);
            // channel=site inclui cadastros antigos (sem o campo); whatsapp_web só os vindos do WhatsApp
            const { channel } = req.query;
            if (channel === 'whatsapp_web') filters.channel = 'whatsapp_web';
            else if (channel === 'site') filters.channel = { $ne: 'whatsapp_web' };

            const fromDate = from ? new Date(from) : null;
            const toDate = to ? new Date(to) : null;
            const validFrom = fromDate && !Number.isNaN(fromDate.getTime());
            const validTo = toDate && !Number.isNaN(toDate.getTime());
            if (validFrom || validTo) {
                filters.createdAt = {};
                if (validFrom) filters.createdAt.$gte = fromDate;
                if (validTo) filters.createdAt.$lte = toDate;
            }

            if (search) {
                const regex = { $regex: escapeRegex(String(search).slice(0, 80)), $options: 'i' };
                filters.$or = [{ name: regex }, { email: regex }, { phone: regex }];
            }

            const sortDirection = String(req.query.order).toLowerCase() === 'asc' ? 1 : -1;

            const [items, total] = await Promise.all([
                ConvenioWaitlist.find(filters)
                    .sort({ createdAt: sortDirection, _id: sortDirection })
                    .skip((pageNumber - 1) * limitNumber)
                    .limit(limitNumber)
                    .lean(),
                ConvenioWaitlist.countDocuments(filters),
            ]);

            // Já é paciente? Tem sessão futura? (só leitura; não muda o status da lista)
            let matches = new Map();
            try {
                matches = await patientMatchesByPhone(items.map((item) => item.phone));
            } catch (err) {
                console.warn('⚠️ [WAITLIST] cruzamento com pacientes falhou (lista segue sem ele):', err.message);
            }

            return res.json({
                data: items.map((item) => ({
                    ...item,
                    channel: item.channel || 'site',
                    convenioLabel: CONVENIO_LABELS[item.convenio] || item.convenio,
                    patientMatch: matches.get(item.phone) || null,
                })),
                total,
                page: pageNumber,
                limit: limitNumber,
                pages: Math.ceil(total / limitNumber),
            });
        } catch (err) {
            console.error('❌ [WAITLIST] Erro ao listar:', err);
            return sendApiError(
              res,
              new AppError('INTERNAL_ERROR', 'Erro ao buscar lista de interesse', {
                status: 500,
              }),
              req
            );
        }
    });

    /**
     * PATCH /api/convenio-waitlist/:id
     * Body: { status?, notes? } — ao marcar 'contatado' registra notifiedAt.
     * Mantém a chave de unicidade: status ativo (aguardando/contatado) tem activeKey; agendado/descartado libera.
     * Reativar um cadastro quando já existe outro ativo do mesmo telefone + convênio devolve 409.
     */
    router.patch('/:id', authorize(['admin', 'secretary']), validateId, async (req, res) => {
        try {
            const set = {};
            const unset = {};

            if (req.body.status !== undefined) {
                if (!WAITLIST_STATUS.includes(req.body.status)) {
                    return sendApiError(res, new AppError('BAD_REQUEST', 'Status inválido', { status: 400 }), req);
                }
                set.status = req.body.status;
            }
            if (req.body.notes !== undefined) {
                set.notes = String(req.body.notes).slice(0, 2000);
            }
            if (!Object.keys(set).length) {
                return sendApiError(res, new AppError('BAD_REQUEST', 'Nada para atualizar', { status: 400 }), req);
            }

            const current = await ConvenioWaitlist.findById(req.params.id);
            if (!current) return sendApiError(res, new AppError('NOT_FOUND', 'Cadastro não encontrado', { status: 404 }), req);

            if (set.status) {
                if (WAITLIST_ACTIVE_STATUS.includes(set.status)) {
                    set.activeKey = waitlistActiveKey(current.phone, current.convenio);
                } else {
                    unset.activeKey = 1;
                }
                if (set.status === 'contatado' && !current.notifiedAt) {
                    set.notifiedAt = new Date();
                }
            }

            let updated;
            try {
                updated = await ConvenioWaitlist.findByIdAndUpdate(
                    req.params.id,
                    { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
                    { new: true },
                ).lean();
            } catch (err) {
                if (isDuplicateKeyError(err)) {
                    return sendApiError(
                      res,
                      new AppError('CONFLICT', 'Já existe outro cadastro ativo deste telefone neste convênio', {
                        status: 409,
                      }),
                      req
                    );
                }
                throw err;
            }

            return res.json({ ...updated, convenioLabel: CONVENIO_LABELS[updated.convenio] || updated.convenio });
        } catch (err) {
            console.error('❌ [WAITLIST] Erro ao atualizar:', err);
            return sendApiError(
              res,
              new AppError('INTERNAL_ERROR', 'Erro ao atualizar cadastro', {
                status: 500,
              }),
              req
            );
        }
    });

    return router;
};

export default createConvenioWaitlistRouter();
