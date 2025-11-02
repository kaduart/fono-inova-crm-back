// controllers/leadController.js - COMPATÍVEL COM MODELO EXISTENTE
import Lead from '../models/Leads.js';
import Patient from '../models/Patient.js';

/**
 * 🎯 Criar lead com dados da planilha
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
        const phoneE164 = normalizeE164(phone);

        const lead = await Lead.findOneAndUpdate(
            { 'contact.phone': phoneE164 || null },
            {
                $setOnInsert: {
                    name,
                    contact: { phone: phoneE164 },
                    origin: origin || 'Tráfego pago',
                    appointment: {
                        seekingFor: seekingFor || 'Adulto +18 anos',
                        modality: modality || 'Online',
                        healthPlan: healthPlan || 'Mensalidade'
                    },
                    scheduledDate,
                    status: 'novo'
                }
            },
            { upsert: true, new: true }
        );
        // Iniciar circuito automático
        await manageLeadCircuit(lead._id, 'initial');

        res.status(201).json({
            success: true,
            message: 'Lead criado da planilha!',
            data: lead
        });
    } catch (err) {
        console.error("Erro ao criar lead:", err);
        res.status(500).json({ error: err.message });
    }
};

/**
 * 📊 Dashboard específico para métricas da planilha
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
                    // Totais por status (como na planilha)
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
                    // Leads frios (não responderam após 3 interações)
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
                    // Cálculo das taxas
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
 * 🔄 Converter lead em paciente (usando modelo Patient existente)
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
            // Mapear outros campos conforme disponível no lead
            mainComplaint: `Convertido de lead - Buscando: ${lead.appointment.seekingFor}`,
            healthPlan: {
                name: lead.appointment.healthPlan
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
    } catch (err) {
        console.error("Erro ao converter lead:", err);
        res.status(500).json({ error: err.message });
    }
};

/**
 * 📈 Métricas semanais (como na planilha 2)
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