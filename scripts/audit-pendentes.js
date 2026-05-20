/**
 * 🔍 AUDITORIA — Particular Pendente vs Pacote Pendente
 *
 * Uso: node scripts/audit-pendentes.js 2026 05
 */

import mongoose from 'mongoose';
import moment from 'moment-timezone';
import dotenv from 'dotenv';
import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';

dotenv.config();

const TIMEZONE = 'America/Sao_Paulo';

async function connectDb() {
    if (mongoose.connection.readyState === 1) return;
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!uri) { console.error('MONGODB_URI não encontrado'); process.exit(1); }
    await mongoose.connect(uri);
}

async function runAudit(year, month) {
    const monthStart = moment.tz([year, month - 1, 1], TIMEZONE).startOf('day');
    const monthEnd   = moment.tz([year, month - 1, 1], TIMEZONE).endOf('month').endOf('day');
    const start = monthStart.clone().utc().toDate();
    const end   = monthEnd.clone().utc().toDate();

    console.log(`📅 Período: ${monthStart.format('MMMM/YYYY')}\n`);

    // Match base: sessions completed no período, NÃO convênio, NÃO liminar, NÃO pagas
    const naoPagoMatch = {
        date: { $gte: start, $lte: end },
        status: 'completed',
        $and: [
            { paymentMethod: { $ne: 'convenio' } },
            { paymentOrigin: { $ne: 'convenio' } },
            { paymentMethod: { $ne: 'liminar_credit' } },
            { paymentOrigin: { $ne: 'liminar' } },
            { paymentOrigin: { $ne: 'liminar_credit' } }
        ],
        $nor: [
            { isPaid: true },
            { paymentStatus: { $in: ['paid', 'package_paid'] } },
            { paymentOrigin: 'package_prepaid' }
        ]
    };

    // ═══════════════════════════════════════════════════════════
    // 1) PARTICULAR PENDENTE
    // ═══════════════════════════════════════════════════════════
    const particularAgg = await Session.aggregate([
        { $match: { ...naoPagoMatch, $or: [{ package: { $exists: false } }, { package: null }] } },
        { $group: { _id: null, total: { $sum: '$sessionValue' }, count: { $sum: 1 }, ids: { $push: '$_id' } } }
    ]);
    const particularTotal = particularAgg[0]?.total || 0;
    const particularCount = particularAgg[0]?.count || 0;
    const particularIds   = particularAgg[0]?.ids || [];

    // ═══════════════════════════════════════════════════════════
    // 2) PACOTE PENDENTE
    // ═══════════════════════════════════════════════════════════
    const pacoteAgg = await Session.aggregate([
        { $match: { ...naoPagoMatch, package: { $exists: true, $ne: null } } },
        { $group: { _id: null, total: { $sum: '$sessionValue' }, count: { $sum: 1 }, ids: { $push: '$_id' } } }
    ]);
    const pacoteTotal = pacoteAgg[0]?.total || 0;
    const pacoteCount = pacoteAgg[0]?.count || 0;
    const pacoteIds   = pacoteAgg[0]?.ids || [];

    console.log('═══════════════════════════════════════════════════════════');
    console.log('  RESUMO');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  Particular pendente:  R$ ${particularTotal.toFixed(2)} (${particularCount} sessões)`);
    console.log(`  Pacote pendente:      R$ ${pacoteTotal.toFixed(2)} (${pacoteCount} sessões)`);
    console.log('═══════════════════════════════════════════════════════════\n');

    // ═══════════════════════════════════════════════════════════
    // 3) DETALHES — PARTICULAR
    // ═══════════════════════════════════════════════════════════
    if (particularCount > 0) {
        console.log('🟦 PARTICULAR PENDENTE:');
        console.log('─'.repeat(80));
        const sessions = await Session.find({ _id: { $in: particularIds } })
            .select('sessionValue date patient paymentMethod paymentOrigin paymentStatus isPaid')
            .populate('patient', 'fullName')
            .lean();
        for (const s of sessions) {
            const nome = s.patient?.fullName || '—';
            console.log(`  ${s._id} | ${moment(s.date).format('YYYY-MM-DD')} | R$ ${(s.sessionValue||0).toFixed(2).padStart(7)} | ${nome}`);
        }
        console.log('─'.repeat(80));
        console.log(`  Total: R$ ${particularTotal.toFixed(2)}\n`);
    } else {
        console.log('🟦 PARTICULAR PENDENTE: 0 sessões\n');
    }

    // ═══════════════════════════════════════════════════════════
    // 4) DETALHES — PACOTE
    // ═══════════════════════════════════════════════════════════
    if (pacoteCount > 0) {
        console.log('🟧 PACOTE PENDENTE:');
        console.log('─'.repeat(80));
        const sessions = await Session.find({ _id: { $in: pacoteIds } })
            .select('sessionValue date patient paymentMethod paymentOrigin paymentStatus isPaid package')
            .populate('patient', 'fullName')
            .lean();
        for (const s of sessions) {
            const nome = s.patient?.fullName || '—';
            console.log(`  ${s._id} | ${moment(s.date).format('YYYY-MM-DD')} | R$ ${(s.sessionValue||0).toFixed(2).padStart(7)} | ${nome}`);
        }
        console.log('─'.repeat(80));
        console.log(`  Total: R$ ${pacoteTotal.toFixed(2)}\n`);
    } else {
        console.log('🟧 PACOTE PENDENTE: 0 sessões\n');
    }
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
    } finally {
        await mongoose.disconnect();
    }
})();
