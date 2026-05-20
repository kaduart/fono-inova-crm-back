/**
 * 🔍 AUDITORIA DEFINITIVA — Convênio Caixa vs Produção
 *
 * Resolve a divergência: caixa_convênio (aggregation) vs frontend.
 * Uso: node scripts/audit-convenio.js 2026 05
 */

import mongoose from 'mongoose';
import moment from 'moment-timezone';
import dotenv from 'dotenv';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';

dotenv.config();

const TIMEZONE = 'America/Sao_Paulo';

async function connectDb() {
    if (mongoose.connection.readyState === 1) return;
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!uri) { console.error('MONGODB_URI não encontrado'); process.exit(1); }
    await mongoose.connect(uri);
    console.log(`🔗 MongoDB conectado: ${uri.split('@').pop()?.split('/').shift()}\n`);
}

async function runAudit(year, month) {
    const monthStart = moment.tz([year, month - 1, 1], TIMEZONE).startOf('day');
    const monthEnd   = moment.tz([year, month - 1, 1], TIMEZONE).endOf('month').endOf('day');
    const start = monthStart.clone().utc().toDate();
    const end   = monthEnd.clone().utc().toDate();

    console.log(`📅 Período: ${monthStart.format('MMMM/YYYY')} (${year}-${String(month).padStart(2, '0')})\n`);

    // ═══════════════════════════════════════════════════════════
    // 1) CAIXA — Payments de convênio recebidos no período
    // ═══════════════════════════════════════════════════════════
    const cashMatch = {
        status: 'paid',
        amount: { $gt: 0 },
        $and: [
            {
                $or: [
                    { billingType: 'convenio' },
                    { paymentMethod: 'convenio' }
                ]
            },
            {
                $or: [
                    { financialDate: { $gte: start, $lte: end } },
                    { financialDate: { $exists: false }, paymentDate: { $gte: start, $lte: end } },
                    { financialDate: null, paymentDate: { $gte: start, $lte: end } }
                ]
            }
        ]
    };

    const cashAgg = await Payment.aggregate([
        { $match: cashMatch },
        { $group: {
            _id: null,
            total: { $sum: '$amount' },
            count: { $sum: 1 },
            ids: { $push: '$_id' }
        }}
    ]);
    const cashTotal = cashAgg[0]?.total || 0;
    const cashCount = cashAgg[0]?.count || 0;
    const cashIds   = cashAgg[0]?.ids || [];

    // Detalhes dos payments de caixa
    const cashPayments = await Payment.find({ _id: { $in: cashIds } })
        .select('_id amount status billingType paymentMethod paymentOrigin financialDate paymentDate patient kind')
        .populate('patient', 'fullName')
        .lean();

    // ═══════════════════════════════════════════════════════════
    // 2) PRODUÇÃO — Sessions de convênio realizadas no período
    // ═══════════════════════════════════════════════════════════
    const prodMatch = {
        date: { $gte: start, $lte: end },
        status: 'completed',
        $or: [
            { paymentMethod: 'convenio' },
            { paymentOrigin: 'convenio' }
        ]
    };

    const prodAgg = await Session.aggregate([
        { $match: prodMatch },
        { $group: {
            _id: null,
            total: { $sum: '$sessionValue' },
            count: { $sum: 1 },
            ids: { $push: '$_id' }
        }}
    ]);
    const prodTotal = prodAgg[0]?.total || 0;
    const prodCount = prodAgg[0]?.count || 0;
    const prodIds   = prodAgg[0]?.ids || [];

    // Detalhes das sessions de produção
    const prodSessions = await Session.find({ _id: { $in: prodIds } })
        .select('_id sessionValue date status paymentMethod paymentOrigin patient appointmentId')
        .populate('patient', 'fullName')
        .lean();

    // ═══════════════════════════════════════════════════════════
    // 3) PRODUÇÃO TOTAL (todas as sessions, não só convênio)
    // ═══════════════════════════════════════════════════════════
    const totalProdAgg = await Session.aggregate([
        { $match: { date: { $gte: start, $lte: end }, status: 'completed' } },
        { $group: { _id: null, total: { $sum: '$sessionValue' }, count: { $sum: 1 } } }
    ]);

    // ═══════════════════════════════════════════════════════════
    // 4) CAIXA TOTAL (todos os payments, não só convênio)
    // ═══════════════════════════════════════════════════════════
    const totalCashAgg = await Payment.aggregate([
        { $match: {
            status: 'paid',
            amount: { $gt: 0 },
            kind: { $ne: 'package_consumed' },
            $and: [
                { $or: [{ isFromPackage: { $ne: true } }, { kind: 'session_payment' }] },
                { $or: [
                    { financialDate: { $gte: start, $lte: end } },
                    { financialDate: { $exists: false }, paymentDate: { $gte: start, $lte: end } },
                    { financialDate: null, paymentDate: { $gte: start, $lte: end } }
                ]}
            ]
        }},
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]);

    // ═══════════════════════════════════════════════════════════
    // 5) RESUMO
    // ═══════════════════════════════════════════════════════════
    const convenioPendente = Math.max(0, prodTotal - cashTotal);

    console.log('═══════════════════════════════════════════════════════════');
    console.log('  RESUMO EXECUTIVO');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  Caixa total do mês:       R$ ${(totalCashAgg[0]?.total || 0).toLocaleString('pt-BR', {minimumFractionDigits: 2})}`);
    console.log(`  Produção total do mês:    R$ ${(totalProdAgg[0]?.total || 0).toLocaleString('pt-BR', {minimumFractionDigits: 2})}`);
    console.log('───────────────────────────────────────────────────────────');
    console.log(`  Caixa convênio:           R$ ${cashTotal.toLocaleString('pt-BR', {minimumFractionDigits: 2})} (${cashCount} payments)`);
    console.log(`  Produção convênio:        R$ ${prodTotal.toLocaleString('pt-BR', {minimumFractionDigits: 2})} (${prodCount} sessions)`);
    console.log(`  Convênio pendente:        R$ ${convenioPendente.toLocaleString('pt-BR', {minimumFractionDigits: 2})}`);
    console.log('═══════════════════════════════════════════════════════════\n');

    // ═══════════════════════════════════════════════════════════
    // 6) DETALHAMENTO — CAIXA
    // ═══════════════════════════════════════════════════════════
    console.log('💰 PAYMENTS DE CONVÊNIO NO CAIXA (status=paid):');
    console.log('─'.repeat(100));
    console.log(`${'_id'.padEnd(26)} | ${'Valor'.padStart(10)} | ${'billingType'.padEnd(12)} | ${'paymentMethod'.padEnd(16)} | ${'paymentOrigin'.padEnd(14)} | ${'financialDate'.padEnd(12)} | Paciente`);
    console.log('─'.repeat(100));
    cashPayments.forEach(p => {
        const fd = p.financialDate ? moment(p.financialDate).format('YYYY-MM-DD') : (p.paymentDate || '—');
        const nome = p.patient?.fullName || '—';
        console.log(
            `${String(p._id).padEnd(26)} | ` +
            `R$ ${p.amount.toFixed(2).padStart(7)} | ` +
            `${(p.billingType || '—').padEnd(12)} | ` +
            `${(p.paymentMethod || '—').padEnd(16)} | ` +
            `${(p.paymentOrigin || '—').padEnd(14)} | ` +
            `${fd.padEnd(12)} | ${nome.substring(0, 30)}`
        );
    });
    console.log('─'.repeat(100));
    console.log(`Total: R$ ${cashTotal.toFixed(2)}\n`);

    // ═══════════════════════════════════════════════════════════
    // 7) DETALHAMENTO — PRODUÇÃO
    // ═══════════════════════════════════════════════════════════
    console.log('🏭 SESSIONS DE CONVÊNIO REALIZADAS (status=completed):');
    console.log('─'.repeat(100));
    console.log(`${'_id'.padEnd(26)} | ${'Valor'.padStart(10)} | ${'Date'.padEnd(12)} | ${'paymentMethod'.padEnd(16)} | ${'paymentOrigin'.padEnd(14)} | Paciente`);
    console.log('─'.repeat(100));
    prodSessions.forEach(s => {
        const nome = s.patient?.fullName || '—';
        console.log(
            `${String(s._id).padEnd(26)} | ` +
            `R$ ${(s.sessionValue || 0).toFixed(2).padStart(7)} | ` +
            `${moment(s.date).format('YYYY-MM-DD').padEnd(12)} | ` +
            `${(s.paymentMethod || '—').padEnd(16)} | ` +
            `${(s.paymentOrigin || '—').padEnd(14)} | ` +
            `${nome.substring(0, 30)}`
        );
    });
    console.log('─'.repeat(100));
    console.log(`Total: R$ ${prodTotal.toFixed(2)}\n`);

    // ═══════════════════════════════════════════════════════════
    // 8) DIVERGÊNCIAS — Sessions sem payment correspondente
    // ═══════════════════════════════════════════════════════════
    console.log('🔍 DIVERGÊNCIA: Sessions de convênio SEM payment vinculado:');
    const sessionsWithPayment = await Session.aggregate([
        { $match: { _id: { $in: prodIds } } },
        { $lookup: {
            from: 'payments',
            let: { sessionId: '$_id' },
            pipeline: [
                { $match: {
                    $expr: { $or: [
                        { $eq: ['$session', '$$sessionId'] },
                        { $in: ['$$sessionId', { $ifNull: ['$sessions', []] }] }
                    ]},
                    status: 'paid'
                }},
                { $limit: 1 }
            ],
            as: 'linkedPayment'
        }},
        { $match: { linkedPayment: { $size: 0 } } },
        { $project: { _id: 1, sessionValue: 1, date: 1, patient: 1 } }
    ]);

    if (sessionsWithPayment.length === 0) {
        console.log('   ✅ Todas as sessions de convênio têm payment vinculado\n');
    } else {
        console.log(`   ⚠️  ${sessionsWithPayment.length} sessions SEM payment vinculado:`);
        sessionsWithPayment.forEach(s => {
            console.log(`      ${s._id} | R$ ${(s.sessionValue || 0).toFixed(2)} | ${moment(s.date).format('YYYY-MM-DD')}`);
        });
        const divergencia = sessionsWithPayment.reduce((sum, s) => sum + (s.sessionValue || 0), 0);
        console.log(`   💡 Soma da divergência: R$ ${divergencia.toFixed(2)}\n`);
    }

    // ═══════════════════════════════════════════════════════════
    // 9) SNAPSHOT JSON (para testes futuros)
    // ═══════════════════════════════════════════════════════════
    const snapshot = {
        period: { year, month, start: monthStart.format('YYYY-MM-DD'), end: monthEnd.format('YYYY-MM-DD') },
        caixa: {
            total: totalCashAgg[0]?.total || 0,
            convenio: { total: cashTotal, count: cashCount, ids: cashIds.map(id => String(id)) }
        },
        producao: {
            total: totalProdAgg[0]?.total || 0,
            convenio: { total: prodTotal, count: prodCount, ids: prodIds.map(id => String(id)) }
        },
        convenioPendente,
        timestamp: new Date().toISOString()
    };

    console.log('═══════════════════════════════════════════════════════════');
    console.log('  SNAPSHOT JSON (copie para testes)');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(JSON.stringify(snapshot, null, 2));
    console.log('');
}

(async () => {
    const [,, yearArg, monthArg] = process.argv;
    const year  = parseInt(yearArg  || moment().year());
    const month = parseInt(monthArg || moment().month() + 1);

    try {
        await connectDb();
        await runAudit(year, month);
    } catch (err) {
        console.error('💥 Erro:', err.message);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
        console.log('🔌 Desconectado');
    }
})();
