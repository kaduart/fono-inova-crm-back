// routes/convenioWaitlist.js
// Lista de espera de convênios (GEAP/IPASGO/Bradesco) — cadastro público vindo do site + gestão pelo CRM.
import express from 'express';
import rateLimit from 'express-rate-limit';
import {
    CONVENIO_LABELS,
    CONVENIOS_WAITLIST,
    WAITLIST_ACTIVE_STATUS,
    WAITLIST_STATUS,
} from '../constants/convenioWaitlist.js';
import { auth, authorize } from '../middleware/auth.js';
import validateId from '../middleware/validateId.js';
import ConvenioWaitlist from '../models/ConvenioWaitlist.js';
import { parseWaitlistPayload } from '../utils/convenioWaitlistPayload.js';

const router = express.Router();

// Atrás do proxy do Render o req.ip é sempre o do proxy; usa o último IP do X-Forwarded-For (o que o proxy anexou).
const clientKey = (req) => {
    const forwarded = String(req.headers['x-forwarded-for'] || '')
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
    return forwarded.length ? forwarded[forwarded.length - 1] : req.ip;
};

const submitLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 30,
    keyGenerator: clientKey,
    validate: { xForwardedForHeader: false, trustProxy: false, keyGeneratorIpFallback: false },
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Muitas tentativas. Tente novamente em alguns minutos.' },
});

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

        const submission = {
            especialidade: data.especialidade,
            idadeCrianca: data.idadeCrianca,
            periodo: data.periodo,
            at: new Date(),
        };

        // Mesma pessoa + mesmo convênio ainda na lista: atualiza em vez de duplicar
        const existing = await ConvenioWaitlist.findOne({
            phone: data.phone,
            convenio: data.convenio,
            status: { $in: WAITLIST_ACTIVE_STATUS },
        });

        if (existing) {
            const set = {};
            if (data.especialidade) set.especialidade = data.especialidade;
            if (data.idadeCrianca !== null) set.idadeCrianca = data.idadeCrianca;
            if (data.periodo) set.periodo = data.periodo;
            if (data.email && !existing.email) set.email = data.email;

            await ConvenioWaitlist.updateOne(
                { _id: existing._id },
                {
                    ...(Object.keys(set).length ? { $set: set } : {}),
                    $inc: { requestCount: 1 },
                    $push: { submissions: { $each: [submission], $slice: -20 } },
                },
            );

            return res.status(200).json({ success: true, id: existing._id, duplicate: true });
        }

        const created = await ConvenioWaitlist.create({
            name: data.name,
            phone: data.phone,
            email: data.email,
            convenio: data.convenio,
            especialidade: data.especialidade,
            idadeCrianca: data.idadeCrianca,
            periodo: data.periodo,
            source: data.source,
            submissions: [submission],
        });

        console.log(`📋 [WAITLIST] Novo cadastro ${CONVENIO_LABELS[data.convenio]}: ${created._id}`);
        return res.status(201).json({ success: true, id: created._id, duplicate: false });
    } catch (err) {
        console.error('❌ [WAITLIST] Erro ao registrar cadastro:', err);
        return res.status(500).json({ success: false, message: 'Erro interno ao registrar cadastro' });
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
        return res.status(500).json({ message: 'Erro ao buscar resumo da lista de espera' });
    }
});

/**
 * GET /api/convenio-waitlist
 * Filtros: convenio, status, especialidade, search (nome/telefone/e-mail), from, to, page, limit
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
        if ((fromDate && !Number.isNaN(fromDate.getTime())) || (toDate && !Number.isNaN(toDate.getTime()))) {
            filters.createdAt = {};
            if (fromDate && !Number.isNaN(fromDate.getTime())) filters.createdAt.$gte = fromDate;
            if (toDate && !Number.isNaN(toDate.getTime())) filters.createdAt.$lte = toDate;
        }

        if (search) {
            const regex = { $regex: escapeRegex(String(search).slice(0, 80)), $options: 'i' };
            filters.$or = [{ name: regex }, { email: regex }, { phone: regex }];
        }

        const [items, total] = await Promise.all([
            ConvenioWaitlist.find(filters)
                .sort({ createdAt: -1 })
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
        return res.status(500).json({ message: 'Erro ao buscar lista de espera' });
    }
});

/**
 * PATCH /api/convenio-waitlist/:id
 * Body: { status?, notes? } — ao marcar 'contatado' registra notifiedAt
 */
router.patch('/:id', authorize(['admin', 'secretary']), validateId, async (req, res) => {
    try {
        const update = {};

        if (req.body.status !== undefined) {
            if (!WAITLIST_STATUS.includes(req.body.status)) {
                return res.status(400).json({ message: 'Status inválido' });
            }
            update.status = req.body.status;
        }
        if (req.body.notes !== undefined) {
            update.notes = String(req.body.notes).slice(0, 2000);
        }
        if (!Object.keys(update).length) {
            return res.status(400).json({ message: 'Nada para atualizar' });
        }

        const current = await ConvenioWaitlist.findById(req.params.id);
        if (!current) return res.status(404).json({ message: 'Cadastro não encontrado' });

        if (update.status === 'contatado' && !current.notifiedAt) {
            update.notifiedAt = new Date();
        }

        const updated = await ConvenioWaitlist.findByIdAndUpdate(req.params.id, { $set: update }, { new: true }).lean();
        return res.json({ ...updated, convenioLabel: CONVENIO_LABELS[updated.convenio] || updated.convenio });
    } catch (err) {
        console.error('❌ [WAITLIST] Erro ao atualizar:', err);
        return res.status(500).json({ message: 'Erro ao atualizar cadastro' });
    }
});

export default router;
