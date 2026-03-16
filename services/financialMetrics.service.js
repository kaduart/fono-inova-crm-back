/**
 * 💰 Financial Metrics Service
 * 
 * Service unificado para cálculo de métricas financeiras.
 * Resolve o problema de dual-source-of-truth entre Payment e Session.
 * 
 * Arquitetura: FASE 1 (híbrido) → FASE 2 (unificado em Payment)
 * 
 * FASE 1: Busca em Payment + Session.isPaid (com proteção anti-duplicação)
 * FASE 2: Tudo vira Payment, Session apenas referencia
 */

import mongoose from 'mongoose';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';
import Package from '../models/Package.js';
import Appointment from '../models/Appointment.js';

class FinancialMetricsService {
  
  /**
   * 📊 Overview completo das 4 camadas financeiras
   * 
   * @param {Object} period - { startDate: Date, endDate: Date }
   * @returns {Object} { cash, production, billing, receivable, convenioDetail }
   */
  async getOverview(period) {
    const [cash, production, billing, receivable, convenioDetail] = await Promise.all([
      this.calculateCash(period),
      this.calculateProduction(period),
      this.calculateBilling(period),
      this.calculateReceivable(period),
      this.calculateConvenioDetail(period) // 🆕 Detalhamento de convênios
    ]);

    return {
      cash,
      production,
      billing,
      receivable,
      convenioDetail, // 🆕 Novo campo
      period: {
        start: period.startDate,
        end: period.endDate
      }
    };
  }

  /**
   * 💵 CAIXA (Cash)
   * 
   * Dinheiro efetivamente recebido no período.
   * Fontes:
   * 1. Payment.insurance.receivedAt (convênio avulso)
   * 2. Payment.date (particular)
   * 3. Session.paidAt (convênio pacote - FASE 1, com proteção)
   */
  async calculateCash(period) {
    const start = period.startDate;
    const end = period.endDate;

    // 1️⃣ Cash de Payments (convênio avulso + particular)
    const paymentCash = await this._calculateCashFromPayments(start, end);

    // 2️⃣ Cash de Sessions de pacote (FASE 1 - híbrido)
    // APENAS sessões SEM paymentId (proteção contra dupla contagem futura)
    const sessionCash = await this._calculateCashFromSessions(start, end);

    const total = paymentCash.total + sessionCash.total;

    return {
      total,
      bySource: {
        payments: paymentCash,
        sessions: sessionCash
      },
      breakdown: {
        particular: paymentCash.byType.particular || 0,
        convenioAvulso: paymentCash.byType.convenio || 0,
        convenioPacote: sessionCash.total
      }
    };
  }

  /**
   * 🏥 DETALHAMENTO DE CONVÊNIOS
   * 
   * Mostra o fluxo completo de convênios no período:
   * - Atendido (sessões realizadas)
   * - Faturado (guias enviadas)
   * - Recebido (dinheiro na conta)
   * - A Receber (pendente)
   */
  async calculateConvenioDetail(period) {
    const start = period.startDate;
    const end = period.endDate;

    // Helper para calcular valor real: sessionValue se > 0, senão pkg.insuranceGrossAmount
    const valorReal = {
      $cond: {
        if: { $gt: ['$sessionValue', 0] },
        then: '$sessionValue',
        else: { $ifNull: ['$pkg.insuranceGrossAmount', 0] }
      }
    };

    // 1️⃣ CONVÊNIO ATENDIDO (Produção) - Sessões realizadas de convênio
    const atendidoAgg = await Session.aggregate([
      {
        $match: {
          status: 'completed',
          paymentMethod: 'convenio',
          date: { $gte: start.toISOString().split('T')[0], $lte: end.toISOString().split('T')[0] }
        }
      },
      { $lookup: { from: 'packages', localField: 'package', foreignField: '_id', as: 'pkg' } },
      { $unwind: { path: '$pkg', preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: null,
          total: { $sum: valorReal },
          count: { $sum: 1 }
        }
      }
    ]);

    // Separar avulso vs pacote
    const atendidoAvulso = await Session.aggregate([
      {
        $match: {
          status: 'completed',
          paymentMethod: 'convenio',
          package: { $exists: false }, // Sem pacote = avulso
          date: { $gte: start.toISOString().split('T')[0], $lte: end.toISOString().split('T')[0] }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$sessionValue' },
          count: { $sum: 1 }
        }
      }
    ]);

    const atendidoPacote = await Session.aggregate([
      {
        $match: {
          status: 'completed',
          paymentMethod: 'convenio',
          package: { $exists: true }, // Com pacote
          date: { $gte: start.toISOString().split('T')[0], $lte: end.toISOString().split('T')[0] }
        }
      },
      { $lookup: { from: 'packages', localField: 'package', foreignField: '_id', as: 'pkg' } },
      { $unwind: { path: '$pkg', preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: null,
          total: { $sum: valorReal },
          count: { $sum: 1 }
        }
      }
    ]);

    // 2️⃣ CONVÊNIO FATURADO (Guias enviadas)
    const faturadoAgg = await Payment.aggregate([
      {
        $match: {
          billingType: 'convenio',
          'insurance.billedAt': { $gte: start, $lte: end }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$insurance.grossAmount' },
          count: { $sum: 1 }
        }
      }
    ]);

    // 3️⃣ CONVÊNIO RECEBIDO (Dinheiro na conta)
    const recebidoAgg = await Payment.aggregate([
      {
        $match: {
          billingType: 'convenio',
          'insurance.status': { $in: ['received', 'partial'] },
          'insurance.receivedAt': { $gte: start, $lte: end }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$insurance.receivedAmount' },
          count: { $sum: 1 }
        }
      }
    ]);

    // 4️⃣ CONVÊNIO A RECEBER (Faturado - Recebido)
    const aReceberAgg = await Payment.aggregate([
      {
        $match: {
          billingType: 'convenio',
          'insurance.status': 'billed', // Faturado mas não recebido
          'insurance.billedAt': { $gte: start, $lte: end }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$insurance.grossAmount' },
          count: { $sum: 1 }
        }
      }
    ]);

    // Sessões de pacote pagas (que não geram Payment)
    const recebidoPacote = await Session.aggregate([
      {
        $match: {
          isPaid: true,
          paidAt: { $gte: start, $lte: end },
          paymentMethod: 'convenio',
          $or: [
            { paymentId: { $exists: false } },
            { paymentId: null }
          ]
        }
      },
      {
        $lookup: {
          from: 'packages',
          localField: 'package',
          foreignField: '_id',
          as: 'pkg'
        }
      },
      {
        $unwind: {
          path: '$pkg',
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: { $ifNull: ['$pkg.insuranceGrossAmount', 0] } },
          count: { $sum: 1 }
        }
      }
    ]);

    const atendidoTotal = atendidoAgg[0]?.total || 0;
    const faturadoTotal = faturadoAgg[0]?.total || 0;
    const recebidoAvulso = recebidoAgg[0]?.total || 0;
    const recebidoPacoteTotal = recebidoPacote[0]?.total || 0;
    const aReceberTotal = aReceberAgg[0]?.total || 0;

    return {
      atendido: {
        total: atendidoTotal,
        avulso: {
          total: atendidoAvulso[0]?.total || 0,
          count: atendidoAvulso[0]?.count || 0
        },
        pacote: {
          total: atendidoPacote[0]?.total || 0,
          count: atendidoPacote[0]?.count || 0
        },
        count: atendidoAgg[0]?.count || 0
      },
      faturado: {
        total: faturadoTotal,
        count: faturadoAgg[0]?.count || 0
      },
      recebido: {
        total: recebidoAvulso + recebidoPacoteTotal,
        avulso: recebidoAvulso,
        pacote: recebidoPacoteTotal,
        count: (recebidoAgg[0]?.count || 0) + (recebidoPacote[0]?.count || 0)
      },
      aReceber: {
        total: aReceberTotal,
        count: aReceberAgg[0]?.count || 0
      },
      // Status de comparação
      status: {
        faturadoVsAtendido: faturadoTotal - atendidoTotal,
        recebidoVsFaturado: (recebidoAvulso + recebidoPacoteTotal) - faturadoTotal,
        glosaPotencial: aReceberTotal > 0 ? 'Existem guias pendentes de recebimento' : null
      }
    };
  }

  // ... (resto do arquivo permanece igual)
  async _calculateCashFromPayments(start, end) {
    // Convênio recebido
    const convenioPayments = await Payment.aggregate([
      {
        $match: {
          billingType: 'convenio',
          'insurance.status': { $in: ['received', 'partial'] },
          'insurance.receivedAt': { $gte: start, $lte: end }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$insurance.receivedAmount' },
          count: { $sum: 1 }
        }
      }
    ]);

    // Particular recebido
    const particularPayments = await Payment.aggregate([
      {
        $match: {
          billingType: 'particular',
          status: 'completed',
          date: { $gte: start, $lte: end }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$amount' },
          count: { $sum: 1 }
        }
      }
    ]);

    const convenioTotal = convenioPayments[0]?.total || 0;
    const particularTotal = particularPayments[0]?.total || 0;

    return {
      total: convenioTotal + particularTotal,
      count: (convenioPayments[0]?.count || 0) + (particularPayments[0]?.count || 0),
      byType: {
        convenio: convenioTotal,
        particular: particularTotal
      }
    };
  }

  async _calculateCashFromSessions(start, end) {
    // FASE 1: Sessões de pacote pagas (sem Payment associado)
    // Proteção: paymentId = null (evita duplicação quando migrar para FASE 2)
    
    const result = await Session.aggregate([
      {
        $match: {
          isPaid: true,
          paidAt: { $gte: start, $lte: end },
          paymentMethod: 'convenio',
          $or: [
            { paymentId: { $exists: false } },
            { paymentId: null }
          ]
        }
      },
      {
        // 🛡️ PROTEÇÃO: Lookup em Payment para garantir não existe
        $lookup: {
          from: 'payments',
          let: { sessionId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $or: [
                    { $eq: ['$session', '$$sessionId'] },
                    { $in: ['$$sessionId', { $ifNull: ['$sessions', []] }] }
                  ]
                }
              }
            },
            { $limit: 1 }
          ],
          as: 'linkedPayment'
        }
      },
      {
        // Só inclui se NÃO existe Payment vinculado
        $match: {
          linkedPayment: { $size: 0 }
        }
      },
      {
        $lookup: {
          from: 'packages',
          localField: 'package',
          foreignField: '_id',
          as: 'pkg'
        }
      },
      {
        $unwind: {
          path: '$pkg',
          preserveNullAndEmptyArrays: true
        }
      },
      {
        // ⭐ Usa sessionValue (histórico imutável) ou fallback para package
        $group: {
          _id: null,
          total: { 
            $sum: {
              $ifNull: ['$sessionValue', '$pkg.insuranceGrossAmount']
            }
          },
          count: { $sum: 1 }
        }
      }
    ]);

    return {
      total: result[0]?.total || 0,
      count: result[0]?.count || 0
    };
  }

  /**
   * 🏭 PRODUÇÃO (Production)
   * 
   * Valor dos serviços realizados no período.
   * Base: Session.status = 'completed' na data de realização.
   * 
   * IMPORTANTE: Produção ≠ Caixa (podem estar em meses diferentes)
   */
  async calculateProduction(period) {
    const start = period.startDate;
    const end = period.endDate;

    // Agregar por tipo de pagamento para análise
    const byPaymentMethod = await Session.aggregate([
      {
        $match: {
          status: 'completed',
          date: { $gte: start.toISOString().split('T')[0], $lte: end.toISOString().split('T')[0] }
        }
      },
      {
        $lookup: {
          from: 'packages',
          localField: 'package',
          foreignField: '_id',
          as: 'pkg'
        }
      },
      {
        $unwind: {
          path: '$pkg',
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $group: {
          _id: '$paymentMethod',
          total: {
            $sum: {
              $cond: {
                if: { $gt: ['$sessionValue', 0] },
                then: '$sessionValue',
                else: { $ifNull: ['$pkg.insuranceGrossAmount', 0] }
              }
            }
          },
          count: { $sum: 1 }
        }
      }
    ]);

    const total = byPaymentMethod.reduce((sum, item) => sum + (item.total || 0), 0);
    const count = byPaymentMethod.reduce((sum, item) => sum + (item.count || 0), 0);

    return {
      total,
      count,
      byPaymentMethod: byPaymentMethod.reduce((acc, item) => {
        acc[item._id || 'unknown'] = { total: item.total || 0, count: item.count || 0 };
        return acc;
      }, {})
    };
  }

  /**
   * 👨‍⚕️ COMISSÕES (Commissions)
   * 
   * Calcula comissões por profissional baseado nas sessões realizadas.
   * Usa commissionValue que foi travado no momento da sessão.
   */
  async calculateCommissions(period, doctorId = null) {
    const start = period.startDate;
    const end = period.endDate;

    const matchStage = {
      status: 'completed',
      sessionConsumed: true,
      commissionValue: { $gt: 0 },  // ⭐ Só sessões com comissão calculada
      date: { $gte: start.toISOString().split('T')[0], $lte: end.toISOString().split('T')[0] }
    };

    if (doctorId) {
      matchStage.doctor = new mongoose.Types.ObjectId(doctorId);
    }

    const commissions = await Session.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: '$doctor',
          totalCommission: { $sum: '$commissionValue' },
          totalSessions: { $sum: 1 },
          totalProduction: { $sum: '$sessionValue' }
        }
      },
      {
        $lookup: {
          from: 'doctors',
          localField: '_id',
          foreignField: '_id',
          as: 'doctor'
        }
      },
      {
        $unwind: {
          path: '$doctor',
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $project: {
          doctorId: '$_id',
          doctorName: '$doctor.fullName',
          totalCommission: 1,
          totalSessions: 1,
          totalProduction: 1,
          averageCommissionPerSession: { $divide: ['$totalCommission', '$totalSessions'] }
        }
      }
    ]);

    return {
      byDoctor: commissions,
      total: commissions.reduce((sum, d) => sum + d.totalCommission, 0),
      totalSessions: commissions.reduce((sum, d) => sum + d.totalSessions, 0)
    };
  }

  /**
   * 📄 FATURAMENTO (Billing)
   * 
   * Valor enviado para pagamento (guias faturadas).
   * Base: Payment.insurance.billedAt ou InsuranceGuide.
   */
  async calculateBilling(period) {
    const start = period.startDate;
    const end = period.endDate;

    // Faturamento via Payment (convênio avulso)
    const avulsoBilling = await Payment.aggregate([
      {
        $match: {
          billingType: 'convenio',
          'insurance.billedAt': { $gte: start, $lte: end }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$insurance.grossAmount' },
          count: { $sum: 1 }
        }
      }
    ]);

    // TODO: Faturamento de pacotes (quando implementado)
    // Por enquanto pacotes não geram registro de faturamento explícito

    const total = avulsoBilling[0]?.total || 0;
    const count = avulsoBilling[0]?.count || 0;

    return {
      total,
      count,
      byType: {
        avulso: { total, count },
        pacote: { total: 0, count: 0 } // Implementar na FASE 2
      }
    };
  }

  /**
   * 📥 A RECEBER (Receivable)
   * 
   * Valor faturado mas ainda não recebido.
   * Base: Payment com status 'billed' (não 'received' nem 'glosa').
   */
  async calculateReceivable(period) {
    const start = period.startDate;
    const end = period.endDate;

    // Convênio avulso faturado mas não recebido
    const avulsoReceivable = await Payment.aggregate([
      {
        $match: {
          billingType: 'convenio',
          'insurance.status': 'billed',
          'insurance.billedAt': { $gte: start, $lte: end }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$insurance.grossAmount' },
          count: { $sum: 1 }
        }
      }
    ]);

    // Sessões de pacote completadas mas não pagas (pending_receipt)
    const sessionReceivable = await Session.aggregate([
      {
        $match: {
          status: 'completed',
          paymentMethod: 'convenio',
          $or: [
            { isPaid: false },
            { isPaid: { $exists: false } }
          ]
        }
      },
      {
        $lookup: {
          from: 'packages',
          localField: 'package',
          foreignField: '_id',
          as: 'pkg'
        }
      },
      {
        $unwind: {
          path: '$pkg',
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: { $ifNull: ['$pkg.insuranceGrossAmount', 0] } },
          count: { $sum: 1 }
        }
      }
    ]);

    const avulsoTotal = avulsoReceivable[0]?.total || 0;
    const sessionTotal = sessionReceivable[0]?.total || 0;

    return {
      total: avulsoTotal + sessionTotal,
      byType: {
        avulso: { 
          total: avulsoTotal, 
          count: avulsoReceivable[0]?.count || 0 
        },
        pacote: { 
          total: sessionTotal, 
          count: sessionReceivable[0]?.count || 0 
        }
      }
    };
  }

  /**
   * 📈 Métricas adicionais para dashboards
   */
  async getKPIs(period) {
    const overview = await this.getOverview(period);
    
    // Taxa de conversão (recebido / faturado)
    const billingTotal = overview.billing.total;
    const cashTotal = overview.cash.total;
    const conversionRate = billingTotal > 0 ? (cashTotal / billingTotal) * 100 : 0;

    // Ticket médio
    const sessionCount = overview.production.count;
    const averageTicket = sessionCount > 0 ? overview.production.total / sessionCount : 0;

    // Tempo médio de recebimento (dias entre billedAt e receivedAt)
    const avgPaymentTime = await this._calculateAvgPaymentTime(period);

    return {
      ...overview,
      kpis: {
        conversionRate: Math.round(conversionRate * 100) / 100,
        averageTicket: Math.round(averageTicket * 100) / 100,
        avgPaymentTimeDays: avgPaymentTime
      }
    };
  }

  async _calculateAvgPaymentTime(period) {
    const result = await Payment.aggregate([
      {
        $match: {
          billingType: 'convenio',
          'insurance.status': { $in: ['received', 'partial'] },
          'insurance.billedAt': { $exists: true },
          'insurance.receivedAt': { $exists: true },
          'insurance.receivedAt': { $gte: period.startDate, $lte: period.endDate }
        }
      },
      {
        $project: {
          days: {
            $divide: [
              { $subtract: ['$insurance.receivedAt', '$insurance.billedAt'] },
              1000 * 60 * 60 * 24 // converter ms para dias
            ]
          }
        }
      },
      {
        $group: {
          _id: null,
          avgDays: { $avg: '$days' }
        }
      }
    ]);

    return result[0]?.avgDays ? Math.round(result[0].avgDays) : 0;
  }
}

export default new FinancialMetricsService();
