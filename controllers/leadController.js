// controllers/leadController.js - VERSÃO COMPLETA (Planilha + Anúncios)
import { followupQueue } from "../config/bullConfig.js";
import Followup from '../models/Followup.js';
import Lead from '../models/Leads.js';
import Patient from '../models/Patient.js';
import { calculateOptimalFollowupTime } from '../services/intelligence/smartFollowup.js';
import { sendLeadToMeta } from '../services/metaConversionsService.js';
import { normalizeE164BR } from "../utils/phone.js";

// =====================================================================
// 🆕 FUNÇÕES DE ANÚNCIOS (META/GOOGLE ADS) - AMANDA 2.0
// =====================================================================

/**

 * Cria lead a partir de anúncio (Meta/Google Ads)
 * POST /api/leads/from-ad
 */
export const createLeadFromAd = async (req, res) => {
    try {
        let {
            name,
            phone,
            email,
            origin,
            adDetails = {},
            initialMessage = null,
            urgency = "medium",
        } = req.body;

        // 🔤 tratar nome
        let safeName =
            typeof name === "string"
                ? name.trim()
                : "";

        const blacklist = ["contato", "cliente", "lead", "lead meta", "lead histórico", "lead historico"];
        if (safeName && blacklist.includes(safeName.toLowerCase())) {
            safeName = "";
        }

        // Validações
        if (!safeName || !phone) {
            return res.status(400).json({
                success: false,
                error: "Campos obrigatórios: name (válido) e phone",
            });
        }

        const phoneE164 = normalizeE164BR(phone);

        const existing = await Lead.findOne({ "contact.phone": phoneE164 });
        
        if (existing) {
            console.log(`⚠️ Lead duplicado: ${safeName} (${phoneE164})`);
            return res.status(409).json({
                success: false,
                error: "Lead já existe",
                leadId: existing._id,
            });
        }

        await Lead.insertMany([leadData]);


        let initialScore = 60;
        if (origin?.toLowerCase().includes("google")) initialScore = 70;
        if (origin?.toLowerCase().includes("meta")) initialScore = 65;
        if (urgency === "high") initialScore += 15;
        if (urgency === "low") initialScore -= 10;

        const leadData = {
            name: safeName, // 👈 usa o tratado
            contact: {
                phone: phoneE164,
                email: email || null,
            },
            origin: origin || "Tráfego pago",
            status: "lead_quente",
            conversionScore: initialScore,
            notes: initialMessage || `Lead captado via ${origin}`,
            circuit: "Circuito Padrão",
            responded: false,
            conversationSummary: null,
            summaryGeneratedAt: null,
            summaryCoversUntilMessage: 0,
            autoReplyEnabled: true,
            manualControl: {
                active: false,
                autoResumeAfter: 360,
            },
            appointment: {
                seekingFor: "Adulto +18 anos",
                modality: "Online",
                healthPlan: "Mensalidade",
            },
            interactions: [],
            scoreHistory: [],
            lastInteractionAt: new Date(),
            qualificationData: {
                urgencyLevel: urgency === "high" ? 3 : urgency === "low" ? 1 : 2,
            },
            lastScoreUpdate: new Date(),
        };

        const [lead] = await Lead.insertMany([leadData], { rawResult: false });

        console.log(`✅ Lead criado: ${name} (${phoneE164}) | Score: ${initialScore}`);

        // Agendar follow-up inteligente
        const followupTime = calculateOptimalFollowupTime({
            lead,
            score: initialScore,
            lastInteraction: new Date(),
            attempt: 1
        });

        // 🔥 Cria o follow-up
        const followup = await Followup.create({
            lead: lead._id,
            stage: 'primeiro_contato',
            scheduledAt: followupTime,
            status: 'scheduled',
            aiOptimized: true,
            origin,
            note: `Auto-agendado via ${origin}`
        });

        // 🔥 Enfileira no BullMQ
        const delayMs = followupTime.getTime() - Date.now();

        await followupQueue.add(
            "followup",
            { followupId: followup._id },
            {
                jobId: `fu-${followup._id}`,
                ...(delayMs > 0 ? { delay: delayMs } : {})
            }
        );

        console.log(`✅ Follow-up agendado e enfileirado: ${followupTime.toLocaleString('pt-BR')}`);

        res.status(201).json({
            success: true,
            data: {
                leadId: lead._id,
                score: initialScore,
                followupScheduled: followupTime,
                message: 'Lead criado e follow-up agendado com sucesso'
            }
        });

        try {
            await sendLeadToMeta({
                email: lead.contact?.email,
                phone: lead.contact?.phone,
                leadId: lead._id,
            });
        } catch (err) {
            console.error(
                '⚠️ Erro ao enviar lead-from-ad para Meta CAPI:',
                err.message
            );
        }
    } catch (error) {
        console.error('❌ Erro ao criar lead de anúncio:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
};

/**
 * Webhook para Meta Ads Lead Form
 * GET/POST /api/leads/webhook/meta
 */
export const metaLeadWebhook = async (req, res) => {
    try {
        // Validação do webhook Meta
        if (req.query['hub.mode'] === 'subscribe') {
            const verifyToken = process.env.META_VERIFY_TOKEN || 'fono_inova_2025';
            if (req.query['hub.verify_token'] === verifyToken) {
                console.log('✅ Webhook Meta validado');
                return res.status(200).send(req.query['hub.challenge']);
            }
            console.warn('⚠️ Token de verificação Meta inválido');
            return res.sendStatus(403);
        }

        // Processar lead
        const entry = req.body.entry?.[0];
        const leadData = entry?.changes?.[0]?.value;

        if (!leadData) {
            return res.sendStatus(200);
        }

        const { leadgen_id, field_data } = leadData;

        // Extrair campos
        const fields = {};
        field_data?.forEach((f) => {
            fields[f.name] = f.values?.[0];
        });

        console.log("📩 Lead recebido do Meta:", fields);

        // Nome que a PESSOA preencheu no formulário
        const rawName =
            (fields.full_name || fields.name || "").trim();

        // Criar lead via controller
        await createLeadFromAd(
            {
                body: {
                    name: rawName,
                    phone: fields.phone_number || fields.phone,
                    email: fields.email,
                    origin: "Meta Ads",
                    adDetails: {
                        leadgenId: leadgen_id,
                        adId: leadData.ad_id,
                        formId: leadData.form_id,
                        campaign: leadData.ad_name,
                    },
                    initialMessage: fields.message,
                    urgency: "high",
                },
            },
            res
        );

    } catch (error) {
        console.error('❌ Erro no webhook Meta:', error);
        res.sendStatus(500);
    }
};

/**
 * Webhook para Google Ads (via Zapier/Make)
 * POST /api/leads/webhook/google
 */
export const googleLeadWebhook = async (req, res) => {
    try {
        const {
            name,
            phone,
            email,
            gclid,
            campaign,
            adGroup,
            keyword
        } = req.body;

        if (!name || !phone) {
            return res.status(400).json({
                success: false,
                error: 'Campos obrigatórios: name, phone'
            });
        }

        await createLeadFromAd({
            body: {
                name,
                phone,
                email,
                origin: 'Google Ads',
                adDetails: {
                    gclid,
                    campaign,
                    adGroup,
                    keyword
                },
                urgency: 'high'
            }
        }, res);

    } catch (error) {
        console.error('❌ Erro no webhook Google:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

// =====================================================================
// 📊 FUNÇÕES DE PLANILHA (EXISTENTES) - PRESERVADAS
// =====================================================================

/**
 * 🎯 Criar lead com dados da planilha
 * POST /api/leads/from-sheet
 */
export const createLeadFromSheet = async (req, res) => {
    try {
        const {
            name,
            phone,
            seekingFor,
            modality,
            healthPlan,
            origin,
            scheduledDate
        } = req.body;

        const phoneE164 = normalizeE164BR(phone);

        // 🔤 tratar nome vindo da planilha
        let safeName =
            typeof name === "string"
                ? name.trim()
                : "";

        // opcional: evitar nomes genéricos
        const blacklist = ["contato", "cliente", "lead"];
        if (safeName && blacklist.includes(safeName.toLowerCase())) {
            safeName = "";
        }

        const lead = await Lead.findOneAndUpdate(
            { "contact.phone": phoneE164 || null },
            {
                $setOnInsert: {
                    name: safeName, // 👈 agora existe
                    contact: { phone: phoneE164 },
                    origin: origin || "Tráfego pago",
                    appointment: {
                        seekingFor: seekingFor || "Adulto +18 anos",
                        modality: modality || "Online",
                        healthPlan: healthPlan || "Mensalidade",
                    },
                    scheduledDate,
                    status: "novo",
                },
            },
            { upsert: true, new: true }
        );

        res.status(201).json({
            success: true,
            message: "Lead criado da planilha!",
            data: lead,
        });

        try {
            await sendLeadToMeta({
                email: lead?.contact?.email || lead?.email,
                phone: lead?.contact?.phone || lead?.phone,
                leadId: lead._id,
            });
        } catch (err) {
            console.error(
                "⚠️ Erro ao enviar lead-from-sheet para Meta CAPI:",
                err.message
            );
        }
    } catch (err) {
        console.error("Erro ao criar lead:", err);
        res.status(500).json({ error: err.message });
    }
};


/**
 * 📊 Dashboard específico para métricas da planilha
 * GET /api/leads/sheet-metrics
 */
export const getSheetMetrics = async (req, res) => {
    try {
        const { startDate, endDate } = req.query;

        const matchStage = {};
        if (startDate || endDate) {
            matchStage.createdAt = {};
            if (startDate) matchStage.createdAt.$gte = new Date(startDate);
            if (endDate) matchStage.createdAt.$lte = new Date(endDate);
        }

        const metrics = await Lead.aggregate([
            { $match: matchStage },
            {
                $group: {
                    _id: null,
                    totalLeads: { $sum: 1 },
                    atendimentoEncerrado: {
                        $sum: { $cond: [{ $eq: ["$status", "convertido"] }, 1, 0] }
                    },
                    emAndamento: {
                        $sum: { $cond: [{ $eq: ["$status", "em_andamento"] }, 1, 0] }
                    },
                    listaEspera: {
                        $sum: { $cond: [{ $eq: ["$status", "lista_espera"] }, 1, 0] }
                    },
                    pendenciaDocumentacao: {
                        $sum: { $cond: [{ $eq: ["$status", "pendencia_documentacao"] }, 1, 0] }
                    },
                    semCobertura: {
                        $sum: { $cond: [{ $eq: ["$status", "sem_cobertura"] }, 1, 0] }
                    },
                    virouPaciente: {
                        $sum: { $cond: [{ $eq: ["$status", "virou_paciente"] }, 1, 0] }
                    },
                    leadFrio: {
                        $sum: {
                            $cond: [
                                {
                                    $and: [
                                        { $eq: ["$status", "novo"] },
                                        { $lt: ["$conversionScore", 2] }
                                    ]
                                },
                                1,
                                0
                            ]
                        }
                    }
                }
            },
            {
                $project: {
                    _id: 0,
                    totalLeads: 1,
                    atendimentoEncerrado: 1,
                    emAndamento: 1,
                    listaEspera: 1,
                    pendenciaDocumentacao: 1,
                    semCobertura: 1,
                    virouPaciente: 1,
                    leadFrio: 1,
                    taxaConversao: {
                        $round: [{
                            $multiply: [{
                                $divide: ["$virouPaciente", "$totalLeads"]
                            }, 100]
                        }, 1]
                    },
                    taxaAbandono: {
                        $round: [{
                            $multiply: [{
                                $divide: ["$semCobertura", "$totalLeads"]
                            }, 100]
                        }, 1]
                    }
                }
            }
        ]);

        const result = metrics[0] || {
            totalLeads: 0,
            atendimentoEncerrado: 0,
            emAndamento: 0,
            listaEspera: 0,
            pendenciaDocumentacao: 0,
            semCobertura: 0,
            virouPaciente: 0,
            leadFrio: 0,
            taxaConversao: 0,
            taxaAbandono: 0
        };

        res.json({
            success: true,
            data: result
        });
    } catch (err) {
        console.error("Erro ao buscar métricas:", err);
        res.status(500).json({ error: err.message });
    }
};

/**
 * 🔄 Converter lead em paciente
 * POST /api/leads/:leadId/convert-to-patient
 */
export const convertLeadToPatient = async (req, res) => {
    try {
        const { leadId } = req.params;
        const lead = await Lead.findById(leadId);

        if (!lead) {
            return res.status(404).json({ error: 'Lead não encontrado' });
        }

        // Criar paciente a partir do lead
        const patientData = {
            fullName: lead.name,
            phone: lead.contact.phone,
            email: lead.contact.email,
            mainComplaint: `Convertido de lead - Buscando: ${lead.appointment?.seekingFor || 'N/A'}`,
            healthPlan: {
                name: lead.appointment?.healthPlan || 'Particular'
            }
        };

        const patient = await Patient.create(patientData);

        // Atualizar lead
        lead.status = 'virou_paciente';
        lead.convertedToPatient = patient._id;
        await lead.save();

        res.json({
            success: true,
            message: 'Lead convertido para paciente!',
            data: { lead, patient }
        });

        // ❌ FALTA ADICIONAR AQUI:
        await sendLeadToMeta({
            email: lead.contact?.email,
            phone: lead.contact?.phone,
            leadId: lead._id
        });
    } catch (err) {
        console.error("Erro ao converter lead:", err);
        res.status(500).json({ error: err.message });
    }
};

/**
 * 📈 Métricas semanais
 * GET /api/leads/weekly-metrics
 */
export const getWeeklyMetrics = async (req, res) => {
    try {
        const { year, month } = req.query;

        const weeklyData = await Lead.aggregate([
            {
                $match: {
                    createdAt: {
                        $gte: new Date(`${year}-${month}-01`),
                        $lte: new Date(`${year}-${month}-31`)
                    }
                }
            },
            {
                $group: {
                    _id: {
                        week: { $week: "$createdAt" }
                    },
                    total: { $sum: 1 },
                    virouPaciente: {
                        $sum: { $cond: [{ $eq: ["$status", "virou_paciente"] }, 1, 0] }
                    },
                    semCobertura: {
                        $sum: { $cond: [{ $eq: ["$status", "sem_cobertura"] }, 1, 0] }
                    },
                    leadFrio: {
                        $sum: {
                            $cond: [
                                {
                                    $or: [
                                        { $eq: ["$status", "lead_frio"] },
                                        {
                                            $and: [
                                                { $eq: ["$status", "novo"] },
                                                { $lt: ["$conversionScore", 2] }
                                            ]
                                        }
                                    ]
                                },
                                1,
                                0
                            ]
                        }
                    }
                }
            },
            {
                $project: {
                    week: "$_id.week",
                    total: 1,
                    virouPaciente: 1,
                    semCobertura: 1,
                    leadFrio: 1,
                    taxaConversao: {
                        $round: [{
                            $multiply: [{
                                $divide: ["$virouPaciente", "$total"]
                            }, 100]
                        }, 1]
                    },
                    taxaAbandono: {
                        $round: [{
                            $multiply: [{
                                $divide: ["$semCobertura", "$total"]
                            }, 100]
                        }, 1]
                    }
                }
            },
            { $sort: { week: 1 } }
        ]);

        res.json({
            success: true,
            data: weeklyData
        });
    } catch (err) {
        console.error("Erro ao buscar métricas semanais:", err);
        res.status(500).json({ error: err.message });
    }
};

/**
 * Listar todos os leads
 * GET /api/leads
 */
export const getAllLeads = async (req, res) => {
    try {
        const {
            status,
            origin,
            limit = 100,
            skip = 0,
            sortBy = 'createdAt',
            sortOrder = 'desc'
        } = req.query;

        // Filtros
        const query = {};
        if (status) query.status = status;
        if (origin) query.origin = origin;

        // Buscar leads
        const leads = await Lead.find(query)
            .sort({ [sortBy]: sortOrder === 'desc' ? -1 : 1 })
            .limit(parseInt(limit))
            .skip(parseInt(skip))
            .select('name contact origin status conversionScore createdAt')
            .lean();

        // Total para paginação
        const total = await Lead.countDocuments(query);

        res.json({
            success: true,
            data: leads,
            pagination: {
                total,
                limit: parseInt(limit),
                skip: parseInt(skip),
                hasMore: total > parseInt(skip) + parseInt(limit)
            }
        });
    } catch (error) {
        console.error('❌ Erro ao listar leads:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Buscar lead por ID
 * GET /api/leads/:id
 */
export const getLeadById = async (req, res) => {
    try {
        const { id } = req.params;

        const lead = await Lead.findById(id)
            .populate('owner', 'name email')
            .lean();

        if (!lead) {
            return res.status(404).json({
                success: false,
                error: 'Lead não encontrado'
            });
        }

        res.json({
            success: true,
            data: lead
        });
    } catch (error) {
        console.error('❌ Erro ao buscar lead:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};
// =====================================================================
// 🛠️ UTILITÁRIOS
// =====================================================================

/**
 * 📊 Métricas da base histórica (WhatsApp importado)
 * GET /api/leads/history-metrics
 */
export const getHistoryMetrics = async (req, res) => {
    try {
        // aqui estou usando "Lead Histórico" pra identificar os importados
        // se depois você marcar com tag, dá pra trocar o filtro
        const matchStage = {
            name: 'Lead Histórico'
            // ou, se quiser incluir todos de WhatsApp:
            // origin: 'WhatsApp'
        };

        const metrics = await Lead.aggregate([
            { $match: matchStage },
            {
                $group: {
                    _id: null,
                    totalLeads: { $sum: 1 },

                    virouPaciente: {
                        $sum: { $cond: [{ $eq: ["$status", "virou_paciente"] }, 1, 0] }
                    },
                    engajado: {
                        $sum: { $cond: [{ $eq: ["$status", "engajado"] }, 1, 0] }
                    },
                    pesquisandoPreco: {
                        $sum: { $cond: [{ $eq: ["$status", "pesquisando_preco"] }, 1, 0] }
                    },
                    primeiroContato: {
                        $sum: { $cond: [{ $eq: ["$status", "primeiro_contato"] }, 1, 0] }
                    },
                    leadFrio: {
                        $sum: { $cond: [{ $eq: ["$status", "lead_frio"] }, 1, 0] }
                    },
                    novo: {
                        $sum: { $cond: [{ $eq: ["$status", "novo"] }, 1, 0] }
                    }
                }
            },
            {
                $project: {
                    _id: 0,
                    totalLeads: 1,
                    virouPaciente: 1,
                    engajado: 1,
                    pesquisandoPreco: 1,
                    primeiroContato: 1,
                    leadFrio: 1,
                    novo: 1,
                    taxaConversao: {
                        $cond: [
                            { $gt: ["$totalLeads", 0] },
                            {
                                $round: [
                                    {
                                        $multiply: [
                                            { $divide: ["$virouPaciente", "$totalLeads"] },
                                            100
                                        ]
                                    },
                                    1
                                ]
                            },
                            0
                        ]
                    }
                }
            }
        ]);

        const result = metrics[0] || {
            totalLeads: 0,
            virouPaciente: 0,
            engajado: 0,
            pesquisandoPreco: 0,
            primeiroContato: 0,
            leadFrio: 0,
            novo: 0,
            taxaConversao: 0
        };

        return res.json({
            success: true,
            data: result
        });
    } catch (error) {
        console.error("Erro ao buscar history-metrics:", error);
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
};


async function resolveLeadByPhone(phone, defaults = {}) {
    const phoneE164 = normalizeE164BR(phone);

    return await Lead.findOneAndUpdate(
        { "contact.phone": phoneE164 },
        {
            $setOnInsert: {
                contact: { phone: phoneE164 },
                origin: defaults.origin || "WhatsApp",
                status: defaults.status || "novo",
                appointment: defaults.appointment || {},
                autoReplyEnabled: true,
                manualControl: { active: false, autoResumeAfter: 30 },
                createdAt: new Date()
            },
            $set: {
                lastInteractionAt: new Date()
            }
        },
        { upsert: true, new: true }
    );
}
