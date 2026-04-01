// insurance/services/convenioIntegrationService.js
/**
 * Convenio Integration Service
 * 
 * Integra o sistema de Insurance com os dados reais de convênios:
 * - Modelo Convenio (valores)
 * - Modelo InsuranceGuide (guias)
 * - Modelo InsuranceBatch (lotes existentes)
 */

import mongoose from 'mongoose';
import Convenio from '../../../models/Convenio.js';
import InsuranceGuide from '../../../models/InsuranceGuide.js';
import InsuranceBatch from '../../../models/InsuranceBatch.js';
import Session from '../../../models/Session.js';

// ============================================
// BUSCA DE DADOS REAIS
// ============================================

/**
 * Busca convênios ativos do banco
 */
export async function getActiveConvenios() {
    return await Convenio.find({ active: true }).lean();
}

/**
 * Busca valor de sessão para um convênio
 */
export async function getConvenioSessionValue(convenioCode) {
    return await Convenio.getSessionValue(convenioCode);
}

/**
 * Busca guias ativas para um paciente
 */
export async function getActiveGuidesForPatient(patientId) {
    return await InsuranceGuide.find({
        patientId,
        status: { $in: ['active', 'partial'] },
        expiresAt: { $gt: new Date() }
    }).lean();
}

/**
 * Busca guia por número
 */
export async function getGuideByNumber(number) {
    return await InsuranceGuide.findOne({ number: number.toUpperCase() }).lean();
}

// ============================================
// AUTOMAÇÃO DE LOTES
// ============================================

/**
 * Busca sessões pendentes de faturamento
 * Sessões que:
 * - Foram completadas
 * - São de convênio
 * - Ainda não foram faturadas
 */
export async function findPendingSessionsForBilling(startDate, endDate, convenioCode = null) {
    const query = {
        date: {
            $gte: new Date(startDate),
            $lte: new Date(endDate)
        },
        status: 'completed',
        billingStatus: { $in: ['pending', null] },
        'package.type': 'convenio'
    };

    if (convenioCode) {
        query['package.insuranceProvider'] = convenioCode;
    }

    const sessions = await Session.find(query)
        .populate('patient', 'name cardNumber')
        .populate('doctor', 'name crm')
        .lean();

    return sessions;
}

/**
 * Cria um lote de faturamento automaticamente
 * a partir de sessões pendentes
 */
export async function createBatchFromPendingSessions(data) {
    const {
        convenioCode,
        startDate,
        endDate,
        createdBy
    } = data;

    // Busca convênio
    const convenio = await Convenio.findOne({
        code: convenioCode.toLowerCase(),
        active: true
    });

    if (!convenio) {
        throw new Error(`CONVENIO_NOT_FOUND: ${convenioCode}`);
    }

    // Busca sessões pendentes
    const sessions = await findPendingSessionsForBilling(startDate, endDate, convenioCode);

    if (sessions.length === 0) {
        return {
            success: false,
            message: 'Nenhuma sessão pendente encontrada para o período',
            sessionsFound: 0
        };
    }

    // Busca ou cria guias para as sessões
    const sessionsWithGuides = await Promise.all(
        sessions.map(async (session) => {
            const guide = await findOrCreateGuideForSession(session, convenio);
            return {
                session,
                guide
            };
        })
    );

    // Gera número do lote
    const batchNumber = await generateBatchNumber(convenioCode);

    // Calcula totais
    const sessionValue = convenio.sessionValue || 0;
    const totalGross = sessions.length * sessionValue;

    // Cria o lote (usando modelo existente)
    const batch = new InsuranceBatch({
        batchNumber,
        insuranceProvider: convenioCode,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        sessions: sessionsWithGuides.map(({ session, guide }) => ({
            session: session._id,
            appointment: session.appointment,
            guide: guide?._id,
            grossAmount: sessionValue,
            netAmount: null,
            status: 'pending'
        })),
        totalGross,
        totalNet: 0,
        totalSessions: sessions.length,
        status: 'building',
        correlationId: `batch_${Date.now()}`
    });

    await batch.save();

    // Atualiza sessões como "em faturamento"
    await mongoose.model('Session').updateMany(
        { _id: { $in: sessions.map(s => s._id) } },
        { $set: { billingStatus: 'in_batch', batchId: batch._id } }
    );

    return {
        success: true,
        batchId: batch._id,
        batchNumber,
        convenio: convenio.name,
        sessionsCount: sessions.length,
        totalGross
    };
}

/**
 * Encontra ou cria uma guia para a sessão
 */
async function findOrCreateGuideForSession(session, convenio) {
    // Primeiro tenta encontrar guia ativa do paciente
    let guide = await InsuranceGuide.findOne({
        patientId: session.patient?._id,
        specialty: session.specialty || 'fonoaudiologia',
        status: { $in: ['active', 'partial'] },
        expiresAt: { $gt: new Date() }
    });

    // Se não tem guia, cria uma temporária (será preenchida depois)
    if (!guide) {
        guide = new InsuranceGuide({
            number: `TEMP-${session._id.toString().slice(-8)}`,
            patientId: session.patient?._id,
            specialty: session.specialty || 'fonoaudiologia',
            totalSessions: 10,
            usedSessions: 0,
            status: 'active',
            expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // 90 dias
            notes: `Guia temporária criada automaticamente para lote ${convenio.code}`
        });
        await guide.save();
    }

    return guide;
}

/**
 * Gera número de lote sequencial
 */
async function generateBatchNumber(convenioCode) {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');

    // Conta lotes do mês
    const count = await InsuranceBatch.countDocuments({
        insuranceProvider: convenioCode,
        createdAt: {
            $gte: new Date(year, date.getMonth(), 1),
            $lt: new Date(year, date.getMonth() + 1, 1)
        }
    });

    const sequence = String(count + 1).padStart(3, '0');
    return `${convenioCode.toUpperCase()}-${year}${month}-${sequence}`;
}

// ============================================
// SINCRONIZAÇÃO DE RETORNO
// ============================================

/**
 * Processa retorno do convênio
 * Atualiza lotes, sessões e guias com dados reais do retorno
 */
export async function processConvenioReturn(batchId, returnData) {
    const batch = await InsuranceBatch.findById(batchId);

    if (!batch) {
        throw new Error(`BATCH_NOT_FOUND: ${batchId}`);
    }

    const { items, receivedAmount, returnFile } = returnData;

    // Processa cada item do retorno
    let totalApproved = 0;
    let totalRejected = 0;
    let totalGlosa = 0;

    for (const item of items) {
        const sessionInBatch = batch.sessions.find(
            s => s.session.toString() === item.sessionId
        );

        if (!sessionInBatch) continue;

        // Atualiza status na sessão do lote
        sessionInBatch.status = item.status;
        sessionInBatch.netAmount = item.netAmount || 0;
        sessionInBatch.returnAmount = item.returnAmount;
        sessionInBatch.glosaAmount = item.glosaAmount || 0;
        sessionInBatch.glosaReason = item.glosaReason;
        sessionInBatch.protocolNumber = item.protocolNumber;
        sessionInBatch.processedAt = new Date();

        // Atualiza sessão original
        await mongoose.model('Session').findByIdAndUpdate(item.sessionId, {
            billingStatus: item.status === 'paid' ? 'paid' : 'rejected',
            billingReturnAmount: item.returnAmount,
            billingGlosaAmount: item.glosaAmount,
            billingGlosaReason: item.glosaReason
        });

        // Atualiza guia
        if (sessionInBatch.guide && item.status === 'paid') {
            await InsuranceGuide.findByIdAndUpdate(
                sessionInBatch.guide,
                { $inc: { usedSessions: 1 } }
            );
        }

        // Contabiliza
        if (item.status === 'paid') {
            totalApproved++;
        } else {
            totalRejected++;
        }
        totalGlosa += item.glosaAmount || 0;
    }

    // Atualiza totais do lote
    batch.receivedAmount = receivedAmount;
    batch.totalGlosa = totalGlosa;
    batch.totalNet = receivedAmount;
    batch.returnFile = returnFile;
    batch.processedAt = new Date();

    // Define status do lote
    if (totalRejected === 0) {
        batch.status = 'closed';
    } else if (totalApproved === 0) {
        batch.status = 'rejected';
    } else {
        batch.status = 'received';
    }

    await batch.save();

    return {
        success: true,
        batchId: batch._id,
        totalApproved,
        totalRejected,
        totalGlosa,
        finalStatus: batch.status
    };
}

// ============================================
// ESTATÍSTICAS E RELATÓRIOS
// ============================================

/**
 * Busca estatísticas de faturamento por convênio
 */
export async function getConvenioStats(convenioCode, startDate, endDate) {
    const match = {
        insuranceProvider: convenioCode,
        createdAt: {
            $gte: new Date(startDate),
            $lte: new Date(endDate)
        }
    };

    const stats = await InsuranceBatch.aggregate([
        { $match: match },
        {
            $group: {
                _id: '$status',
                count: { $sum: 1 },
                totalGross: { $sum: '$totalGross' },
                totalReceived: { $sum: '$receivedAmount' },
                totalGlosa: { $sum: '$totalGlosa' },
                totalSessions: { $sum: '$totalSessions' }
            }
        }
    ]);

    // Sessões pendentes
    const pendingSessions = await mongoose.model('Session').countDocuments({
        date: { $gte: new Date(startDate), $lte: new Date(endDate) },
        status: 'completed',
        billingStatus: { $in: ['pending', null] },
        'package.type': 'convenio',
        'package.insuranceProvider': convenioCode
    });

    return {
        byStatus: stats.reduce((acc, s) => {
            acc[s._id] = s;
            return acc;
        }, {}),
        pendingSessions,
        period: { startDate, endDate },
        convenio: convenioCode
    };
}

/**
 * Lista todos os convênios com estatísticas
 */
export async function getAllConveniosWithStats() {
    const convenios = await Convenio.find({ active: true }).lean();

    const conveniosWithStats = await Promise.all(
        convenios.map(async (conv) => {
            // Lotes do último mês
            const lastMonthBatches = await InsuranceBatch.find({
                insuranceProvider: conv.code,
                createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
            }).lean();

            // Sessões pendentes
            const pendingSessions = await mongoose.model('Session').countDocuments({
                status: 'completed',
                billingStatus: { $in: ['pending', null] },
                'package.type': 'convenio',
                'package.insuranceProvider': conv.code
            });

            return {
                ...conv,
                stats: {
                    batchesLastMonth: lastMonthBatches.length,
                    totalBilled: lastMonthBatches.reduce((sum, b) => sum + (b.receivedAmount || 0), 0),
                    pendingSessions
                }
            };
        })
    );

    return conveniosWithStats;
}

// ============================================
// EXPORT
// ============================================

export default {
    getActiveConvenios,
    getConvenioSessionValue,
    getActiveGuidesForPatient,
    getGuideByNumber,
    findPendingSessionsForBilling,
    createBatchFromPendingSessions,
    processConvenioReturn,
    getConvenioStats,
    getAllConveniosWithStats
};
