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
import PatientBalance from '../models/PatientBalance.js';

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
    // 🆕 CORREÇÃO: Garante que são Date objects após migração
    const start = period.startDate instanceof Date ? period.startDate : new Date(period.startDate);
    const end = period.endDate instanceof Date ? period.endDate : new Date(period.endDate);

    // Helper: sessionValue → pkg.insuranceGrossAmount → payment.insurance.grossAmount
    const valorReal = {
      $cond: {
        if: { $gt: ['$sessionValue', 0] },
        then: '$sessionValue',
        else: {
          $cond: {
            if: { $gt: ['$pkg.insuranceGrossAmount', 0] },
            then: '$pkg.insuranceGrossAmount',
            else: { $ifNull: [{ $arrayElemAt: ['$linkedPayment.grossAmount', 0] }, 0] }
          }
        }
      }
    };

    // Stages comuns para lookup de package + payment (triple-fallback)
    const lookupStages = [
      { $lookup: { from: 'packages', localField: 'package', foreignField: '_id', as: 'pkg' } },
      { $unwind: { path: '$pkg', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'payments',
          let: { sid: '$_id' },
          pipeline: [
            { $match: { $expr: { $eq: ['$session', '$$sid'] }, status: { $ne: 'canceled' } } },
            { $project: { grossAmount: '$insurance.grossAmount' } },
            { $limit: 1 }
          ],
          as: 'linkedPayment'
        }
      }
    ];

    // 1️⃣ CONVÊNIO ATENDIDO (Produção) - Sessões realizadas de convênio
    // 🚀 Otimização: $facet colapsa 3 aggregates em 1 (mesmo match + lookups)
    const atendidoFacet = await Session.aggregate([
      {
        $match: {
          status: 'completed',
          paymentMethod: 'convenio',
          date: { $gte: start, $lte: end }
        }
      },
      ...lookupStages,
      {
        $facet: {
          atendidoTotal: [
            { $group: { _id: null, total: { $sum: valorReal }, count: { $sum: 1 } } }
          ],
          atendidoAvulso: [
            { $match: { $or: [{ package: { $exists: false } }, { package: null }] } },
            { $group: { _id: null, total: { $sum: valorReal }, count: { $sum: 1 } } }
          ],
          atendidoPacote: [
            { $match: { package: { $exists: true, $ne: null } } },
            { $group: { _id: null, total: { $sum: valorReal }, count: { $sum: 1 } } }
          ]
        }
      }
    ]);

    const atendidoAgg = atendidoFacet[0]?.atendidoTotal || [];
    const atendidoAvulso = atendidoFacet[0]?.atendidoAvulso || [];
    const atendidoPacote = atendidoFacet[0]?.atendidoPacote || [];

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
    // 🚀 Otimização: $facet colapsa total + porMesRef em 1 aggregate
    const recebidoSessionFacet = await Session.aggregate([
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
      ...lookupStages,
      {
        $facet: {
          total: [
            { $group: { _id: null, total: { $sum: valorReal }, count: { $sum: 1 } } }
          ],
          porMesRef: [
            {
              $project: {
                valor: valorReal,
                mesRef: { $concat: [{ $substr: ['$date', 0, 4] }, '-', { $substr: ['$date', 5, 2] }] }
              }
            },
            { $group: { _id: '$mesRef', total: { $sum: '$valor' }, count: { $sum: 1 } } },
            { $sort: { _id: 1 } }
          ]
        }
      }
    ]);

    const recebidoPacote = recebidoSessionFacet[0]?.total || [];
    const recebidoPacotePorMesRef = recebidoSessionFacet[0]?.porMesRef || [];

    // 🆕 DETALHAMENTO POR MÊS DE REFERÊNCIA (Payment avulso)
    const recebidoPorMesRef = await Payment.aggregate([
      {
        $match: {
          billingType: 'convenio',
          'insurance.status': { $in: ['received', 'partial'] },
          'insurance.receivedAt': { $gte: start, $lte: end }
        }
      },
      {
        $lookup: {
          from: 'sessions',
          localField: 'session',
          foreignField: '_id',
          as: 'sessao'
        }
      },
      { $unwind: { path: '$sessao', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          receivedAmount: '$insurance.receivedAmount',
          sessionDate: { $ifNull: ['$sessao.date', { $dateToString: { format: '%Y-%m-%d', date: '$paymentDate' } }] }
        }
      },
      {
        $addFields: {
          mesRef: { 
            $concat: [
              { $substr: ['$sessionDate', 0, 4] },
              '-',
              { $substr: ['$sessionDate', 5, 2] }
            ]
          }
        }
      },
      {
        $group: {
          _id: '$mesRef',
          total: { $sum: '$receivedAmount' },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    // Combinar os dois resultados
    const mesesRefMap = new Map();
    
    recebidoPorMesRef.forEach(item => {
      mesesRefMap.set(item._id, {
        mes: item._id,
        total: item.total,
        count: item.count
      });
    });
    
    recebidoPacotePorMesRef.forEach(item => {
      const existente = mesesRefMap.get(item._id);
      if (existente) {
        existente.total += item.total;
        existente.count += item.count;
      } else {
        mesesRefMap.set(item._id, {
          mes: item._id,
          total: item.total,
          count: item.count
        });
      }
    });
    
    const recebidoPorMesReferencia = Array.from(mesesRefMap.values())
      .sort((a, b) => a.mes.localeCompare(b.mes));

    const atendidoTotal = atendidoAgg[0]?.total || 0;
    const faturadoTotal = faturadoAgg[0]?.total || 0;
    const recebidoAvulso = recebidoAgg[0]?.total || 0;
    const recebidoPacoteTotal = recebidoPacote[0]?.total || 0;
    const recebidoTotal = recebidoAvulso + recebidoPacoteTotal;
    const aReceberPaymentTotal = aReceberAgg[0]?.total || 0;

    // A Receber = derivado de Atendido - Recebido (fonte única, sem ambiguidade)
    // Cobre tanto avulso quanto pacote, igual à lógica do EntradasSaidasTab
    const aReceberTotal = Math.max(0, atendidoTotal - recebidoTotal);

    // Calcular totais do mês atual vs meses anteriores
    const mesAtualStr = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`;
    const recebidoMesAtual = recebidoPorMesReferencia
      .filter(item => item.mes === mesAtualStr)
      .reduce((sum, item) => sum + item.total, 0);
    const recebidoMesesAnteriores = recebidoPorMesReferencia
      .filter(item => item.mes !== mesAtualStr)
      .reduce((sum, item) => sum + item.total, 0);

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
        total: recebidoTotal,
        avulso: recebidoAvulso,
        pacote: recebidoPacoteTotal,
        count: (recebidoAgg[0]?.count || 0) + (recebidoPacote[0]?.count || 0),
        mesAtual: recebidoMesAtual,
        mesesAnteriores: recebidoMesesAnteriores,
        porMesReferencia: recebidoPorMesReferencia
      },
      aReceber: {
        total: aReceberTotal,
        // guias formalmente faturadas não recebidas (avulso, referência extra)
        guiasPendentes: aReceberPaymentTotal,
        count: aReceberAgg[0]?.count || 0
      },
      // Status de comparação
      status: {
        faturadoVsAtendido: faturadoTotal - atendidoTotal,
        recebidoVsFaturado: recebidoTotal - faturadoTotal,
        glosaPotencial: aReceberPaymentTotal > 0 ? 'Existem guias pendentes de recebimento' : null
      }
    };
  }

  // ... (resto do arquivo permanece igual)
  async _calculateCashFromPayments(start, end) {
    // Usa Date objects diretamente — paymentDate é type:Date no schema.
    // Aggregate bypassa Mongoose type casting, então string comparison falha silenciosamente.

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

    // Particular recebido — usa Date objects, não strings
    const particularPayments = await Payment.aggregate([
      {
        $match: {
          billingType: 'particular',
          status: 'paid',
          paymentDate: { $gte: start, $lte: end }
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

    // Valor real de uma sessão: sessionValue → pkg.insuranceGrossAmount → payment.insurance.grossAmount
    const valorReal = {
      $cond: {
        if: { $gt: ['$sessionValue', 0] },
        then: '$sessionValue',
        else: {
          $cond: {
            if: { $gt: ['$pkg.insuranceGrossAmount', 0] },
            then: '$pkg.insuranceGrossAmount',
            else: { $ifNull: [{ $arrayElemAt: ['$linkedPayment.grossAmount', 0] }, 0] }
          }
        }
      }
    };

    const byPaymentMethod = await Session.aggregate([
      {
        $match: {
          status: 'completed',
          date: { $gte: start, $lte: end }
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
      { $unwind: { path: '$pkg', preserveNullAndEmptyArrays: true } },
      // Fallback: busca o grossAmount no Payment vinculado
      {
        $lookup: {
          from: 'payments',
          let: { sid: '$_id' },
          pipeline: [
            { $match: { $expr: { $eq: ['$session', '$$sid'] }, status: { $ne: 'canceled' } } },
            { $project: { grossAmount: '$insurance.grossAmount' } },
            { $limit: 1 }
          ],
          as: 'linkedPayment'
        }
      },
      {
        $group: {
          _id: '$paymentMethod',
          total: { $sum: valorReal },
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
      date: { $gte: start, $lte: end }
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
   * Convênio: Payment.insurance.status = 'billed' no período
   * Particular do mês: Session.status='completed', paymentMethod!='convenio', isPaid=false, date no período
   * Saldo devedor total: sum(PatientBalance.currentBalance > 0) — acumulado histórico
   */
  async calculateReceivable(period) {
    const start = period.startDate;
    const end = period.endDate;

    // 1️⃣ Convênio avulso faturado mas não recebido — filtrado pelo período do mês
    const avulsoReceivable = await Payment.aggregate([
      {
        $match: {
          billingType: 'convenio',
          'insurance.status': 'billed',
          paymentDate: { $gte: start, $lte: end }
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

    // 2️⃣ Convênio PACOTE: sessões de pacote completadas não pagas pelo plano — filtrado pelo período
    // Apenas pacote (com package definido) — avulso já é coberto via Payment em avulsoReceivable
    const sessionReceivable = await Session.aggregate([
      {
        $match: {
          status: 'completed',
          paymentMethod: 'convenio',
          package: { $exists: true, $ne: null },
          $or: [{ isPaid: false }, { isPaid: { $exists: false } }],
          date: { $gte: start, $lte: end }
        }
      },
      {
        $lookup: { from: 'packages', localField: 'package', foreignField: '_id', as: 'pkg' }
      },
      { $unwind: { path: '$pkg', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'payments',
          let: { sid: '$_id' },
          pipeline: [
            { $match: { $expr: { $eq: ['$session', '$$sid'] }, status: { $ne: 'canceled' } } },
            { $project: { grossAmount: '$insurance.grossAmount' } },
            { $limit: 1 }
          ],
          as: 'linkedPayment'
        }
      },
      {
        $group: {
          _id: null,
          total: {
            $sum: {
              $cond: {
                if: { $gt: ['$sessionValue', 0] },
                then: '$sessionValue',
                else: {
                  $cond: {
                    if: { $gt: ['$pkg.insuranceGrossAmount', 0] },
                    then: '$pkg.insuranceGrossAmount',
                    else: { $ifNull: [{ $arrayElemAt: ['$linkedPayment.grossAmount', 0] }, 0] }
                  }
                }
              }
            }
          },
          count: { $sum: 1 }
        }
      }
    ]);

    // 3️⃣ Particular do mês: débitos do PatientBalance lançados no período e ainda não pagos
    const particularReceivable = await PatientBalance.aggregate([
      { $unwind: '$transactions' },
      {
        $match: {
          'transactions.type': 'debit',
          $or: [{ 'transactions.isPaid': false }, { 'transactions.isPaid': { $exists: false } }],
          'transactions.transactionDate': { $gte: start, $lte: end }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$transactions.amount' },
          count: { $sum: 1 }
        }
      }
    ]);

    // 4️⃣ Saldo devedor acumulado histórico (PatientBalance)
    const balanceResult = await PatientBalance.aggregate([
      { $match: { currentBalance: { $gt: 0 } } },
      {
        $group: {
          _id: null,
          total: { $sum: '$currentBalance' },
          count: { $sum: 1 }
        }
      }
    ]);

    const avulsoTotal = avulsoReceivable[0]?.total || 0;
    const sessionTotal = sessionReceivable[0]?.total || 0;
    const particularTotal = particularReceivable[0]?.total || 0;
    const balanceTotal = balanceResult[0]?.total || 0;
    const balanceCount = balanceResult[0]?.count || 0;

    return {
      total: avulsoTotal + sessionTotal + particularTotal,
      convenio: {
        total: avulsoTotal + sessionTotal,
        avulso: { total: avulsoTotal, count: avulsoReceivable[0]?.count || 0 },
        pacote: { total: sessionTotal, count: sessionReceivable[0]?.count || 0 }
      },
      particular: {
        doMes: { total: particularTotal, count: particularReceivable[0]?.count || 0 }
      },
      saldoDevedorTotal: {
        total: balanceTotal,
        count: balanceCount
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
