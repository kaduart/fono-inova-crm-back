// routes/leads.js - VERSÃO UNIFICADA E OTIMIZADA
import express from 'express';
import {
    // 📊 Funções de planilha
    convertLeadToPatient,
    // 🆕 Funções de anúncios
    createLeadFromAd,
    createLeadFromSheet,
    getSheetMetrics,
    getWeeklyMetrics,
    // 📞 Webhooks
    googleLeadWebhook,
    metaLeadWebhook
} from '../controllers/leadController.js';
import { auth, authorize } from '../middleware/auth.js';
import validateId from '../middleware/validateId.js';
import Lead from '../models/Leads.js';
import { sendLeadToMeta } from '../services/metaConversionsService.js';

const router = express.Router();

// =====================================================================
// 🌐 WEBHOOKS PÚBLICOS (SEM AUTH) - Meta e Google Ads
// =====================================================================
// Meta Ads Webhook (GET para verificação, POST para receber leads)
router.get('/webhook/meta', metaLeadWebhook);
router.post('/webhook/meta', metaLeadWebhook);

// Google Ads Webhook
router.post('/webhook/google', googleLeadWebhook);

// =====================================================================
// 🔒 ROTAS PROTEGIDAS (COM AUTH)
// =====================================================================
router.use(auth);

// =====================================================================
// 📋 LISTAGEM E BUSCA DE LEADS
// =====================================================================

/**
 * GET /leads
 * Lista leads com filtros, paginação e busca
 * Acesso: admin, secretary, professional
 */
router.get('/', authorize(['admin', 'secretary', 'professional']), async (req, res) => {
    try {
        const {
            status,
            origin,
            from,
            to,
            page = 1,
            limit = 20,
            search
        } = req.query;

        const filters = {};

        if (status) filters.status = status;
        if (origin) filters.origin = origin;

        if (from && to) {
            filters.createdAt = {
                $gte: new Date(from),
                $lte: new Date(to)
            };
        }

        if (search) {
            const regex = { $regex: search, $options: 'i' };
            filters.$or = [
                { name: regex },
                { 'contact.email': regex },
                { 'contact.phone': regex }   // ✅ busca pelo telefone
            ];
        }

        const pageNumber = parseInt(page, 10);
        const limitNumber = parseInt(limit, 10);

        const leads = await Lead.find(filters)
            .sort({ createdAt: -1 })
            .skip((pageNumber - 1) * limitNumber)
            .limit(limitNumber);

        const total = await Lead.countDocuments(filters);

        res.json({
            data: leads,                 // ✅ aqui já vem phone e displayName como virtual
            total,
            page: pageNumber,
            limit: limitNumber,
            pages: Math.ceil(total / limitNumber)
        });
    } catch (err) {
        console.error('❌ Erro ao listar leads:', err);
        res.status(500).json({
            message: 'Erro ao buscar leads',
            error: err.message
        });
    }
});


/**
 * GET /leads/:id
 * Detalha um lead específico
 * Acesso: admin, secretary, professional
 */
router.get('/:id',
    validateId,
    authorize(['admin', 'secretary', 'professional']),
    async (req, res) => {
        try {
            const lead = await Lead.findById(req.params.id);

            if (!lead) {
                return res.status(404).json({
                    message: 'Lead não encontrado'
                });
            }

            res.json(lead);
        } catch (err) {
            console.error('❌ Erro ao buscar lead:', err);
            res.status(500).json({
                message: 'Erro ao buscar lead',
                error: err.message
            });
        }
    }
);

// =====================================================================
// ➕ CRIAÇÃO DE LEADS
// =====================================================================

/**
 * POST /leads
 * Cria novo lead manualmente
 * Acesso: admin, secretary
 */
router.post('/', authorize(['admin', 'secretary']), async (req, res) => {
    try {
        const lead = new Lead(req.body);
        await lead.save();

        console.log('✅ Lead criado manualmente:', lead._id);

        res.status(201).json(lead);
        try {
            await sendLeadToMeta({
                email: lead?.contact?.email || lead?.email,
                phone: lead?.contact?.phone || lead?.phone,
                leadId: lead._id,
            });
        } catch (err) {
            console.error(
                '⚠️ Erro ao enviar lead para Meta CAPI (mas lead foi salvo):',
                err.message
            );
        }
    } catch (err) {
        console.error('❌ Erro ao criar lead:', err);
        res.status(400).json({
            message: 'Erro ao criar lead',
            error: err.message
        });
    }
});

/**
 * POST /leads/from-ad
 * Cria lead vindo de anúncios (Meta/Google)
 * Acesso: admin, secretary
 * 
 * Body esperado:
 * {
 *   name: string,
 *   email: string,
 *   phone: string,
 *   origin: 'meta_ads' | 'google_ads',
 *   adData: { campaignId, adSetId, etc... }
 * }
 */
router.post('/from-ad', authorize(['admin', 'secretary']), createLeadFromAd);

/**
 * POST /leads/from-sheet
 * Cria lead vindo de planilha
 * Acesso: admin, secretary
 */
router.post('/from-sheet', authorize(['admin', 'secretary']), createLeadFromSheet);

// =====================================================================
// ✏️ ATUALIZAÇÃO E EXCLUSÃO
// =====================================================================

/**
 * PUT /leads/:id
 * Atualiza um lead
 * Acesso: admin, secretary, professional
 */
router.put('/:id',
    validateId,
    authorize(['admin', 'secretary', 'professional']),
    async (req, res) => {
        try {
            const lead = await Lead.findByIdAndUpdate(
                req.params.id,
                req.body,
                {
                    new: true,
                    runValidators: true
                }
            );

            if (!lead) {
                return res.status(404).json({
                    message: 'Lead não encontrado'
                });
            }

            console.log('✅ Lead atualizado:', lead._id);

            res.json(lead);
        } catch (err) {
            console.error('❌ Erro ao atualizar lead:', err);
            res.status(400).json({
                message: 'Erro ao atualizar lead',
                error: err.message
            });
        }
    }
);

/**
 * DELETE /leads/:id
 * Deleta um lead
 * Acesso: admin, secretary
 */
router.delete('/:id',
    validateId,
    authorize(['admin', 'secretary']),
    async (req, res) => {
        try {
            const lead = await Lead.findByIdAndDelete(req.params.id);

            if (!lead) {
                return res.status(404).json({
                    message: 'Lead não encontrado'
                });
            }

            console.log('✅ Lead deletado:', req.params.id);

            res.status(204).end();
        } catch (err) {
            console.error('❌ Erro ao deletar lead:', err);
            res.status(400).json({
                message: 'Erro ao deletar lead',
                error: err.message
            });
        }
    }
);

// =====================================================================
// 🔄 CONVERSÃO DE LEAD PARA PACIENTE
// =====================================================================

/**
 * POST /leads/:leadId/convert-to-patient
 * Converte um lead em paciente
 * Acesso: admin, secretary
 */
router.post('/:leadId/convert-to-patient',
    authorize(['admin', 'secretary']),
    convertLeadToPatient
);

// =====================================================================
// 📊 MÉTRICAS E RELATÓRIOS
// =====================================================================

/**
 * GET /leads/report/summary
 * Relatório resumido com totais por status e origem
 * Acesso: admin, secretary
 */
router.get('/report/summary',
    authorize(['admin', 'secretary']),
    async (req, res) => {
        try {
            const summary = await Lead.aggregate([
                {
                    $facet: {
                        byStatus: [
                            {
                                $group: {
                                    _id: '$status',
                                    count: { $sum: 1 }
                                }
                            },
                            { $sort: { count: -1 } }
                        ],
                        byOrigin: [
                            {
                                $group: {
                                    _id: '$origin',
                                    count: { $sum: 1 }
                                }
                            },
                            { $sort: { count: -1 } }
                        ],
                        total: [
                            { $count: 'total' }
                        ],
                        thisMonth: [
                            {
                                $match: {
                                    createdAt: {
                                        $gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1)
                                    }
                                }
                            },
                            { $count: 'total' }
                        ]
                    }
                }
            ]);

            res.json(summary[0]);
        } catch (err) {
            console.error('❌ Erro ao gerar relatório:', err);
            res.status(500).json({
                message: 'Erro ao gerar relatório',
                error: err.message
            });
        }
    }
);

/**
 * GET /leads/sheet-metrics
 * Métricas específicas da planilha
 * Acesso: admin, secretary
 */
router.get('/sheet-metrics',
    authorize(['admin', 'secretary']),
    getSheetMetrics
);

/**
 * GET /leads/weekly-metrics
 * Métricas semanais
 * Acesso: admin, secretary
 */
router.get('/weekly-metrics',
    authorize(['admin', 'secretary']),
    getWeeklyMetrics
);

export default router;