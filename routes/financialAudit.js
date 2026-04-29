/**
 * 📊 Financial Audit Routes
 *
 * Endpoints de auditoria V1 vs V2:
 * - GET /api/financial/audit/sessions — comparação session por session
 * - GET /api/financial/audit/summary — resumo executivo
 * - GET /api/financial/audit/revenue-delta — delta de receita
 */

import { Router } from 'express';
import mongoose from 'mongoose';
import { auth } from '../middleware/auth.js';

const router = Router();

/**
 * 🔍 GET /api/financial/audit/sessions
 *
 * Comparação V1 vs V2 session por session
 * AGORA usa FinancialTruthLayer para detecção padronizada
 * Query params:
 *   - patientId (opcional)
 *   - packageId (opcional)
 *   - limit (default: 50)
 */
router.get('/audit/sessions', auth, async (req, res) => {
  try {
    const { patientId, packageId, limit = 50 } = req.query;
    const db = mongoose.connection.db;

    const match = {};
    if (patientId) match.patient = new mongoose.Types.ObjectId(patientId);
    if (packageId) match.package = new mongoose.Types.ObjectId(packageId);

    const sessions = await db.collection('sessions')
      .find(match)
      .limit(parseInt(limit))
      .toArray();

    const { default: FinancialTruthLayer } = await import('../services/financialGuard/FinancialTruthLayer.js');
    const sessionIds = sessions.map(s => s._id.toString());
    const truthSessions = await FinancialTruthLayer.getSessions(sessionIds, { withAudit: true });

    const results = truthSessions.map(ts => {
      const v1 = {
        isPaid: ts._v1Shadow?.isPaid ?? false,
        paymentStatus: ts._v1Shadow?.paymentStatus ?? 'unpaid'
      };
      const v2 = {
        isPaid: ts.isPaid,
        paymentStatus: ts.paymentStatus,
        amount: ts._paymentAmount || 0
      };

      const diverges = ts._v1Shadow?.inconsistent || false;
      const severity = !v1.isPaid && v2.isPaid ? 'CRITICAL' :
                       v1.isPaid && !v2.isPaid ? 'HIGH' :
                       diverges ? 'MEDIUM' : 'LOW';

      return {
        sessionId: ts._id,
        packageId: ts.package,
        patientId: ts.patient,
        date: ts.date,
        sessionType: ts.sessionType,
        v1,
        v2,
        diverges,
        severity,
        impact: diverges ? `R$ ${v2.amount}` : '0',
        _financialSource: ts._financialSource
      };
    });

    const divergences = results.filter(r => r.diverges);

    res.json({
      success: true,
      meta: {
        total: results.length,
        divergences: divergences.length,
        rate: results.length ? ((divergences.length / results.length) * 100).toFixed(1) + '%' : '0%',
        source: 'truth_layer_v2'
      },
      data: results,
      divergences: divergences.sort((a, b) => {
        const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
        return order[a.severity] - order[b.severity];
      })
    });
  } catch (err) {
    console.error('[Audit Sessions] Erro:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 📊 GET /api/financial/audit/summary
 *
 * Resumo executivo da divergência V1 vs V2
 */
router.get('/audit/summary', auth, async (req, res) => {
  try {
    const db = mongoose.connection.db;

    // Contagem total
    const totalSessions = await db.collection('sessions').countDocuments();
    const totalPayments = await db.collection('payments').countDocuments({ status: 'paid' });

    // Sessions com isPaid=true no V1
    const v1PaidCount = await db.collection('sessions').countDocuments({ isPaid: true });

    // Sessions com payment real no V2
    const v2PaidCount = await db.collection('payments').countDocuments({
      status: 'paid',
      session: { $exists: true, $ne: null }
    });

    // Divergências
    const falsePositives = v1PaidCount - v2PaidCount;
    const falsePositiveRate = v1PaidCount ? ((falsePositives / v1PaidCount) * 100).toFixed(1) : 0;

    // Receita
    const v1Revenue = await db.collection('sessions').aggregate([
      { $match: { isPaid: true } },
      { $group: { _id: null, total: { $sum: '$sessionValue' } } }
    ]).toArray();

    const v2Revenue = await db.collection('payments').aggregate([
      { $match: { status: 'paid', session: { $exists: true, $ne: null } } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]).toArray();

    const v1Total = v1Revenue[0]?.total || 0;
    const v2Total = v2Revenue[0]?.total || 0;
    const revenueDelta = v1Total - v2Total;

    // Top pacientes com divergência
    const patientDivergences = await db.collection('sessions').aggregate([
      { $match: { isPaid: true } },
      {
        $lookup: {
          from: 'payments',
          localField: '_id',
          foreignField: 'session',
          as: 'payment'
        }
      },
      { $match: { payment: { $size: 0 } } },
      {
        $group: {
          _id: '$patient',
          falsePaidCount: { $sum: 1 },
          falseRevenue: { $sum: '$sessionValue' }
        }
      },
      { $sort: { falsePaidCount: -1 } },
      { $limit: 10 }
    ]).toArray();

    // Buscar nomes dos pacientes
    const patientIds = patientDivergences.map(p => p._id);
    const patients = await db.collection('patients').find({
      _id: { $in: patientIds }
    }, { projection: { nome: 1, name: 1 } }).toArray();

    const patientMap = {};
    for (const p of patients) {
      patientMap[p._id.toString()] = p.nome || p.name || 'N/A';
    }

    res.json({
      success: true,
      data: {
        sessions: {
          total: totalSessions,
          v1Paid: v1PaidCount,
          v2Paid: v2PaidCount,
          falsePositives,
          falsePositiveRate: falsePositiveRate + '%'
        },
        revenue: {
          v1: v1Total,
          v2: v2Total,
          delta: revenueDelta,
          deltaRate: v1Total ? ((revenueDelta / v1Total) * 100).toFixed(1) + '%' : '0%'
        },
        topPatients: patientDivergences.map(p => ({
          patientId: p._id,
          name: patientMap[p._id.toString()] || 'N/A',
          falsePaidCount: p.falsePaidCount,
          falseRevenue: p.falseRevenue
        }))
      }
    });
  } catch (err) {
    console.error('[Audit Summary] Erro:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 💰 GET /api/financial/audit/revenue-delta
 *
 * Detalhamento do delta de receita por período
 */
router.get('/audit/revenue-delta', auth, async (req, res) => {
  try {
    const { from, to } = req.query;
    const db = mongoose.connection.db;

    const dateMatch = {};
    if (from) dateMatch.$gte = new Date(from);
    if (to) dateMatch.$lte = new Date(to);

    const match = Object.keys(dateMatch).length ? { date: dateMatch } : {};

    // Receita V1 (session.isPaid)
    const v1ByMonth = await db.collection('sessions').aggregate([
      { $match: { ...match, isPaid: true } },
      {
        $group: {
          _id: {
            year: { $year: '$date' },
            month: { $month: '$date' }
          },
          total: { $sum: '$sessionValue' },
          count: { $sum: 1 }
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } }
    ]).toArray();

    // Receita V2 (payments pagos)
    const v2ByMonth = await db.collection('payments').aggregate([
      {
        $match: {
          status: 'paid',
          session: { $exists: true, $ne: null },
          ...(from && { createdAt: { $gte: new Date(from) } }),
          ...(to && { createdAt: { $lte: new Date(to) } })
        }
      },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' }
          },
          total: { $sum: '$amount' },
          count: { $sum: 1 }
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } }
    ]).toArray();

    res.json({
      success: true,
      data: {
        v1: v1ByMonth,
        v2: v2ByMonth
      }
    });
  } catch (err) {
    console.error('[Revenue Delta] Erro:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
