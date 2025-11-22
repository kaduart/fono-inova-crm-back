import TherapyProtocol from '../models/TherapyProtocol.js';
import Evolution from '../models/Evolution.js';

// GET /protocols - Listar todos protocolos
export const getAllProtocols = async (req, res) => {
    try {
        const { specialty } = req.query;

const filter = {};

// normaliza especialidade (case-insensitive)
if (specialty) {
  const SPECIALTIES_MAP = {
    psicologia: 'Psicologia',
    fonoaudiologia: 'Fonoaudiologia',
    'terapia ocupacional': 'Terapia Ocupacional',
    fisioterapia: 'Fisioterapia'
  };

  const normalized =
    SPECIALTIES_MAP[String(specialty).toLowerCase()] || specialty;

  filter.specialty = normalized;
}

// Apenas filtrar por active se vier explicitamente
if (req.query.active !== undefined) {
  filter.active = req.query.active === 'true';
} else {
  filter.active = true; // padrão: só ativos
}

console.log('📊 Filter:', filter);

const protocols = await TherapyProtocol.find(filter);
console.log('✅ Protocolos encontrados:', protocols.length);

res.status(200).json(protocols);

    } catch (error) {
        console.error('❌ Erro:', error);
        res.status(500).json({ message: 'Erro ao buscar protocolos' });
    }
};


// GET /protocols/:code - Detalhes de um protocolo
export const getProtocolByCode = async (req, res) => {
    try {
        const { code } = req.params;
        const protocol = await TherapyProtocol.findOne({ code: code.toUpperCase() });

        if (!protocol) {
            return res.status(404).json({ message: 'Protocolo não encontrado' });
        }

        res.status(200).json(protocol);
    } catch (error) {
        console.error('Erro ao buscar protocolo:', error);
        res.status(500).json({ message: 'Erro ao buscar protocolo' });
    }
};

// POST /protocols - Criar protocolo
export const createProtocol = async (req, res) => {
    try {
        const protocol = new TherapyProtocol({
            ...req.body,
            createdBy: req.user.id
        });

        await protocol.save();
        res.status(201).json(protocol);
    } catch (error) {
        console.error('Erro ao criar protocolo:', error);

        if (error.code === 11000) {
            return res.status(400).json({
                message: 'Código de protocolo já existe'
            });
        }

        res.status(500).json({ message: 'Erro ao criar protocolo' });
    }
};

// PUT /protocols/:code - Atualizar protocolo
export const updateProtocol = async (req, res) => {
    try {
        const { code } = req.params;
        const protocol = await TherapyProtocol.findOneAndUpdate(
            { code: code.toUpperCase() },
            req.body,
            { new: true, runValidators: true }
        );

        if (!protocol) {
            return res.status(404).json({ message: 'Protocolo não encontrado' });
        }

        res.status(200).json(protocol);
    } catch (error) {
        console.error('Erro ao atualizar protocolo:', error);
        res.status(500).json({ message: 'Erro ao atualizar protocolo' });
    }
};

// DELETE /protocols/:code - Desativar protocolo
export const deactivateProtocol = async (req, res) => {
    try {
        const { code } = req.params;
        const protocol = await TherapyProtocol.findOneAndUpdate(
            { code: code.toUpperCase() },
            { active: false },
            { new: true }
        );

        if (!protocol) {
            return res.status(404).json({ message: 'Protocolo não encontrado' });
        }

        res.status(200).json({
            message: 'Protocolo desativado com sucesso',
            protocol
        });
    } catch (error) {
        console.error('Erro ao desativar protocolo:', error);
        res.status(500).json({ message: 'Erro ao desativar protocolo' });
    }
};

// GET /protocols/analytics/usage - Analytics de uso
export const getProtocolAnalytics = async (req, res) => {
    try {
        const { specialty, startDate, endDate } = req.query;

        const matchStage = {
            'therapeuticPlan.protocol.code': { $exists: true }
        };

        if (specialty) matchStage.specialty = specialty;
        if (startDate || endDate) {
            matchStage.date = {};
            if (startDate) matchStage.date.$gte = new Date(startDate);
            if (endDate) matchStage.date.$lte = new Date(endDate);
        }

        const protocolUsage = await Evolution.aggregate([
            { $match: matchStage },
            {
                $group: {
                    _id: {
                        code: '$therapeuticPlan.protocol.code',
                        specialty: '$specialty'
                    },
                    count: { $sum: 1 },
                    avgObjectivesAchieved: {
                        $avg: {
                            $size: {
                                $filter: {
                                    input: '$therapeuticPlan.objectives',
                                    as: 'obj',
                                    cond: { $eq: ['$$obj.achieved', true] }
                                }
                            }
                        }
                    },
                    patients: { $addToSet: '$patient' }
                }
            },
            {
                $project: {
                    code: '$_id.code',
                    specialty: '$_id.specialty',
                    totalUsage: '$count',
                    uniquePatients: { $size: '$patients' },
                    avgObjectivesAchieved: { $round: ['$avgObjectivesAchieved', 2] }
                }
            },
            { $sort: { totalUsage: -1 } }
        ]);

        // Enriquecer com dados do protocolo
        const enrichedData = await Promise.all(
            protocolUsage.map(async (usage) => {
                const protocol = await TherapyProtocol.findOne({ code: usage.code });
                return {
                    ...usage,
                    protocolName: protocol?.name || usage.code,
                    successRate: protocol?.successRate || 0
                };
            })
        );

        res.status(200).json(enrichedData);
    } catch (error) {
        console.error('Erro ao buscar analytics:', error);
        res.status(500).json({ message: 'Erro ao buscar analytics' });
    }
};

// GET /protocols/analytics/effectiveness - Efetividade por protocolo
export const getProtocolEffectiveness = async (req, res) => {
    try {
        const { code } = req.query;

        if (!code) {
            return res.status(400).json({ message: 'Código do protocolo é obrigatório' });
        }

        const evolutions = await Evolution.find({
            'therapeuticPlan.protocol.code': code.toUpperCase()
        })
            .populate('patient', 'fullName')
            .sort({ date: 1 });

        if (!evolutions.length) {
            return res.status(404).json({ message: 'Nenhum uso encontrado para este protocolo' });
        }

        // Agrupar por paciente
        const patientGroups = evolutions.reduce((acc, ev) => {
            const patientId = ev.patient._id.toString();
            if (!acc[patientId]) {
                acc[patientId] = {
                    patient: ev.patient,
                    evolutions: []
                };
            }
            acc[patientId].evolutions.push(ev);
            return acc;
        }, {});

        // Calcular efetividade por paciente
        const effectiveness = Object.values(patientGroups).map(group => {
            const evolutions = group.evolutions;
            const first = evolutions[0];
            const last = evolutions[evolutions.length - 1];

            const objectivesProgress = last.therapeuticPlan?.objectives?.map(obj => ({
                area: obj.area,
                progress: obj.progress,
                achieved: obj.achieved
            })) || [];

            const avgProgress = objectivesProgress.reduce((sum, obj) => sum + obj.progress, 0) / objectivesProgress.length || 0;
            const objectivesAchieved = objectivesProgress.filter(obj => obj.achieved).length;

            return {
                patient: group.patient,
                sessionsCompleted: evolutions.length,
                startDate: first.date,
                lastDate: last.date,
                treatmentStatus: last.treatmentStatus,
                avgProgress: Math.round(avgProgress),
                objectivesAchieved,
                totalObjectives: objectivesProgress.length
            };
        });

        // Estatísticas gerais
        const stats = {
            totalPatients: effectiveness.length,
            avgSessions: Math.round(effectiveness.reduce((sum, e) => sum + e.sessionsCompleted, 0) / effectiveness.length),
            avgProgress: Math.round(effectiveness.reduce((sum, e) => sum + e.avgProgress, 0) / effectiveness.length),
            successRate: Math.round((effectiveness.filter(e => e.avgProgress >= 70).length / effectiveness.length) * 100)
        };

        res.status(200).json({
            protocol: code.toUpperCase(),
            stats,
            patients: effectiveness
        });
    } catch (error) {
        console.error('Erro ao calcular efetividade:', error);
        res.status(500).json({ message: 'Erro ao calcular efetividade' });
    }
};