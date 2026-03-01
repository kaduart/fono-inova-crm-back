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
    getHistoryMetrics,
    metaLeadWebhook
} from '../controllers/leadController.js';
import { auth, authorize } from '../middleware/auth.js';
import validateId from '../middleware/validateId.js';
import Lead from '../models/Leads.js';
import { sendLeadToMeta } from '../services/metaConversionsService.js';
import { normalizeE164BR } from '../utils/phone.js';

const router = express.Router();

// =====================================================================
// 🌐 WEBHOOKS PÚBLICOS (SEM AUTH) - Meta, Google Ads e Site Fono Inova
// =====================================================================

// Meta Ads Webhook (GET para verificação, POST para receber leads)
router.get('/webhook/meta', metaLeadWebhook);
router.post('/webhook/meta', metaLeadWebhook);

// Google Ads Webhook
router.post('/webhook/google', googleLeadWebhook);

// Rota de health check para o site (DEVE VIR ANTES DE /:id e ANTES do router.use(auth))
router.get('/from-website/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        service: 'CRM-CLINICA Lead Webhook',
        timestamp: new Date().toISOString()
    });
});

// 🆕 WEBHOOK DO SITE FONO INOVA - Recebe leads do site
// Endpoint público para receber leads convertidos no site
router.post('/from-website', async (req, res) => {
    try {
        const {
            id,
            dadosPessoais,
            ga4,
            origem,
            contexto,
            device
        } = req.body;

        // Validação básica
        if (!dadosPessoais?.nome || !dadosPessoais?.telefone) {
            return res.status(400).json({
                success: false,
                message: 'Dados obrigatórios: nome e telefone'
            });
        }

        console.log('🌐 Lead recebido do site Fono Inova:', {
            id: id || 'n/a',
            nome: dadosPessoais.nome,
            origem: origem?.source || 'direct',
            landingPage: contexto?.pagePath
        });

        // Monta dados do lead para o CRM
        const leadData = {
            name: dadosPessoais.nome,
            contact: {
                phone: dadosPessoais.telefone ? normalizeE164BR(dadosPessoais.telefone) : null,
                email: dadosPessoais.email || null
            },
            status: 'novo',
            origin: origem?.source === 'google' && origem?.medium === 'cpc' 
                ? 'google_ads' 
                : origem?.source === 'facebook' || origem?.source === 'instagram'
                    ? 'meta_ads'
                    : 'site_fono_inova',
            notes: `Lead do site Fono Inova\n\n` +
                   `Página: ${contexto?.pagePath || 'n/a'}\n` +
                   `UTM Source: ${origem?.source || 'n/a'}\n` +
                   `UTM Medium: ${origem?.medium || 'n/a'}\n` +
                   `UTM Campaign: ${origem?.campaign || 'n/a'}\n` +
                   `GA4 Client ID: ${ga4?.clientId || 'n/a'}`,
            circuit: 'Circuito Padrão',
            conversionScore: 10, // Lead de site tem score alto
            responded: false,
            autoReplyEnabled: true,
            manualControl: {
                active: false,
                autoResumeAfter: 360
            },
            appointment: {
                seekingFor: 'Adulto +18 anos',
                modality: 'Online',
                healthPlan: 'Mensalidade'
            },
            interactions: [{
                type: 'system',
                content: `Lead capturado via site Fono Inova - ${contexto?.pagePath || 'homepage'}`,
                timestamp: new Date(),
                metadata: {
                    source: 'website',
                    pagePath: contexto?.pagePath,
                    utmSource: origem?.source,
                    utmMedium: origem?.medium,
                    utmCampaign: origem?.campaign,
                    deviceType: device?.type,
                    ga4ClientId: ga4?.clientId
                }
            }],
            scoreHistory: [{
                score: 10,
                reason: 'Conversão direta no site',
                timestamp: new Date()
            }],
            lastInteractionAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date()
        };

        // Verifica se já existe lead com mesmo telefone/email (evita duplicados)
        const existingLead = await Lead.findOne({
            $or: [
                { 'contact.phone': leadData.contact.phone },
                ...(leadData.contact.email ? [{ 'contact.email': leadData.contact.email }] : [])
            ],
            createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } // Últimas 24h
        });

        if (existingLead) {
            console.log('⚠️ Lead duplicado detectado (24h):', existingLead._id);
            return res.status(200).json({
                success: true,
                leadId: existingLead._id,
                message: 'Lead já existe (recebido nas últimas 24h)',
                duplicate: true
            });
        }

        // Insere no MongoDB
        const result = await Lead.collection.insertOne(leadData);
        const insertedLead = await Lead.findById(result.insertedId);

        console.log('✅ Lead do site criado:', insertedLead._id);

        // Envia para Meta CAPI (se tiver telefone/email)
        try {
            if (insertedLead.contact?.phone || insertedLead.contact?.email) {
                await sendLeadToMeta({
                    email: insertedLead.contact?.email,
                    phone: insertedLead.contact?.phone,
                    leadId: insertedLead._id,
                    source: 'website',
                    campaign: origem?.campaign
                });
            }
        } catch (err) {
            console.error('⚠️ Erro Meta CAPI:', err.message);
        }

        res.status(201).json({
            success: true,
            leadId: insertedLead._id,
            message: 'Lead recebido com sucesso',
            duplicate: false
        });

    } catch (err) {
        console.error('❌ Erro ao processar lead do site:', err);
        res.status(500).json({
            success: false,
            message: 'Erro interno ao processar lead',
            error: err.message
        });
    }
});

// =====================================================================
// 🔒 ROTAS PROTEGIDAS (COM AUTH) - TUDO ABAIXO PRECISA DE AUTENTICAÇÃO
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
        const {
            name,
            phone,
            email,
            status,
            origin,
            notes
        } = req.body;

        if (!name) {
            return res.status(400).json({
                success: false,
                message: 'Campo obrigatório: name'
            });
        }

        const leadData = {
            name,
            contact: {
                phone: phone ? normalizeE164BR(phone) : null,
                email: email || null
            },
            status: status || 'novo',
            origin: origin || 'Outro',
            notes: notes || null,
            // Campos com defaults
            circuit: 'Circuito Padrão',
            conversionScore: 0,
            responded: false,
            conversationSummary: null,
            summaryGeneratedAt: null,
            summaryCoversUntilMessage: 0,
            autoReplyEnabled: true,
            manualControl: {
                active: false,
                autoResumeAfter: 360
            },
            appointment: {
                seekingFor: 'Adulto +18 anos',
                modality: 'Online',
                healthPlan: 'Mensalidade'
            },
            interactions: [],
            scoreHistory: [],
            lastInteractionAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date()
        };

        console.log('🔧 Inserindo DIRETO no MongoDB (bypass total do Mongoose)');

        // ✅ INSERE DIRETO NO MONGODB
        const result = await Lead.collection.insertOne(leadData);

        console.log('✅ Lead criado (raw):', result.insertedId);

        // Busca o lead inserido
        const leadWithVirtuals = await Lead.findById(result.insertedId);

        res.status(201).json({
            success: true,
            data: leadWithVirtuals
        });

        // Meta CAPI
        try {
            if (leadWithVirtuals.contact?.phone || leadWithVirtuals.contact?.email) {
                await sendLeadToMeta({
                    email: leadWithVirtuals.contact?.email,
                    phone: leadWithVirtuals.contact?.phone,
                    leadId: leadWithVirtuals._id,
                });
            }
        } catch (err) {
            console.error('⚠️ Erro Meta CAPI:', err.message);
        }
    } catch (err) {
        console.error('❌ Erro:', err);
        res.status(400).json({
            success: false,
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

/**
 * GET /leads/history-metrics
 * Métricas de leads do histórico (WhatsApp importados)
 * Acesso: admin, secretary
 */
router.get('/history-metrics',
    authorize(['admin', 'secretary']),
    getHistoryMetrics
);

export default router;