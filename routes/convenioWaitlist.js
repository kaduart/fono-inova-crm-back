// routes/convenioWaitlist.js
// Lista de INTERESSE em convênios (GEAP/IPASGO/Bradesco) — cadastro público vindo do site + gestão pelo CRM.
import express from 'express';
import rateLimit from 'express-rate-limit';
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
                return res.status(400).json({ success: false, message: parsed.message });
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
            return res.status(500).json({ success: false, message: 'Erro interno ao registrar interesse' });
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

            return res.json({ total, porConvenio });
        } catch (err) {
            console.error('❌ [WAITLIST] Erro no resumo:', err);
            return res.status(500).json({ message: 'Erro ao buscar resumo da lista de interesse' });
        }
    });

    /**
     * GET /api/convenio-waitlist
     * Filtros: convenio, status, especialidade, search (nome/telefone/e-mail), from, to, page, limit
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

            return res.json({
                data: items.map((item) => ({ ...item, convenioLabel: CONVENIO_LABELS[item.convenio] || item.convenio })),
                total,
                page: pageNumber,
                limit: limitNumber,
                pages: Math.ceil(total / limitNumber),
            });
        } catch (err) {
            console.error('❌ [WAITLIST] Erro ao listar:', err);
            return res.status(500).json({ message: 'Erro ao buscar lista de interesse' });
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
                    return res.status(400).json({ message: 'Status inválido' });
                }
                set.status = req.body.status;
            }
            if (req.body.notes !== undefined) {
                set.notes = String(req.body.notes).slice(0, 2000);
            }
            if (!Object.keys(set).length) {
                return res.status(400).json({ message: 'Nada para atualizar' });
            }

            const current = await ConvenioWaitlist.findById(req.params.id);
            if (!current) return res.status(404).json({ message: 'Cadastro não encontrado' });

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
                    return res.status(409).json({
                        message: 'Já existe outro cadastro ativo deste telefone neste convênio',
                    });
                }
                throw err;
            }

            return res.json({ ...updated, convenioLabel: CONVENIO_LABELS[updated.convenio] || updated.convenio });
        } catch (err) {
            console.error('❌ [WAITLIST] Erro ao atualizar:', err);
            return res.status(500).json({ message: 'Erro ao atualizar cadastro' });
        }
    });

    return router;
};

export default createConvenioWaitlistRouter();
