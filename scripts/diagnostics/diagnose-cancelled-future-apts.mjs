/**
 * DIAGNÓSTICO EMERGENCIAL: appointments futuros cancelados
 * Roda: node scripts/diagnostics/diagnose-cancelled-future-apts.mjs
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

await mongoose.connect(process.env.MONGO_URI);
const db = mongoose.connection.db;

const cutoff = new Date('2026-06-22T00:00:00.000Z');
const yesterday = new Date('2026-06-21T00:00:00.000Z');

console.log('=== DIAGNÓSTICO: APPOINTMENTS FUTUROS CANCELADOS ===\n');

// 1. Quantos appointments futuros estão cancelados?
const cancelledFuture = await db.collection('appointments').find({
    date: { $gte: cutoff },
    operationalStatus: { $in: ['cancelled', 'canceled'] }
}).sort({ updatedAt: -1 }).limit(100).toArray();

console.log(`Total appointments >= 22/06 com status cancelled/canceled: ${cancelledFuture.length}`);

if (cancelledFuture.length === 0) {
    console.log('\n⚠️  NENHUM appointment cancelado encontrado com data futura.');
    console.log('Possível bug de FILTRO/DISPLAY no frontend, não cancelamento real no banco.');
} else {
    // 2. Quando foram cancelados? (updatedAt)
    const byDate = {};
    for (const a of cancelledFuture) {
        const d = a.updatedAt?.toISOString?.()?.slice(0, 16) || 'sem updatedAt';
        if (!byDate[d]) byDate[d] = 0;
        byDate[d]++;
    }
    console.log('\n--- Quando foram cancelados (updatedAt) ---');
    Object.entries(byDate).sort().forEach(([d, n]) => console.log(`  ${d} → ${n} appointments`));

    // 3. O que está no audit log deles?
    console.log('\n--- Últimos 5 cancelados (audit log) ---');
    for (const a of cancelledFuture.slice(0, 5)) {
        const lastAudit = a.auditLog?.slice(-3) || [];
        console.log(`\nAppointment ${a._id} | data: ${a.date?.toISOString?.()?.slice(0,10)} | billingType: ${a.billingType}`);
        console.log(`  updatedAt: ${a.updatedAt?.toISOString?.()}`);
        console.log(`  cancelledReason: ${a.cancelledReason || a.canceledReason || 'n/a'}`);
        console.log(`  auditLog (últimas 3 entradas):`);
        lastAudit.forEach(e => console.log(`    - [${e.timestamp?.toISOString?.()?.slice(0,16)}] action=${e.action} by=${e.userId || e.source || 'unknown'} prev=${e.previousStatus} → ${e.newStatus || e.status}`));
    }

    // 4. Rastreio por billingType
    const byBilling = {};
    for (const a of cancelledFuture) {
        const b = a.billingType || 'particular';
        if (!byBilling[b]) byBilling[b] = 0;
        byBilling[b]++;
    }
    console.log('\n--- Por billingType ---');
    Object.entries(byBilling).forEach(([b, n]) => console.log(`  ${b}: ${n}`));

    // 5. Patients afetados
    const patientIds = [...new Set(cancelledFuture.map(a => a.patient?.toString()).filter(Boolean))];
    console.log(`\n--- Pacientes afetados: ${patientIds.length} ---`);
    const patients = await db.collection('patients').find({ _id: { $in: patientIds.map(id => new mongoose.Types.ObjectId(id)) } }, { projection: { fullName: 1 } }).toArray();
    patients.forEach(p => console.log(`  ${p._id} — ${p.fullName}`));
}

// 6. Appointments futuros que DEVERIAM existir (pre_agendado/scheduled/confirmed)
const activeFuture = await db.collection('appointments').countDocuments({
    date: { $gte: cutoff },
    operationalStatus: { $in: ['pre_agendado', 'scheduled', 'confirmed'] }
});
console.log(`\nAppointments futuros ATIVOS (pre_agendado/scheduled/confirmed): ${activeFuture}`);

// 7. Payments cancelados ONTEM ou HOJE que tinham appointment futuro
const recentCancelledPayments = await db.collection('payments').find({
    status: { $in: ['cancelled', 'canceled'] },
    updatedAt: { $gte: yesterday }
}).limit(50).toArray();

const withFutureAppt = recentCancelledPayments.filter(p => p.appointment);
console.log(`\nPayments cancelados desde ontem: ${recentCancelledPayments.length} (${withFutureAppt.length} com appointment linkado)`);
if (withFutureAppt.length > 0) {
    withFutureAppt.slice(0, 10).forEach(p => {
        console.log(`  Payment ${p._id} | appointment=${p.appointment} | amount=R$${p.amount} | canceledReason=${p.canceledReason || 'n/a'}`);
    });
}

await mongoose.disconnect();
console.log('\n=== FIM DO DIAGNÓSTICO ===');
