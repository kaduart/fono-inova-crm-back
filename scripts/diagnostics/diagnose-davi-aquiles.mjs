/**
 * DIAGNÓSTICO PROFUNDO: Davi e Aquiles — appointments cancelados indevidamente
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

await mongoose.connect(process.env.MONGO_URI);
const db = mongoose.connection.db;

const daviId   = new mongoose.Types.ObjectId('692da1e37a66901c8975db66');
const aquilesId = new mongoose.Types.ObjectId('6a318cbaa16c83a1feaeb8d5');

console.log('=== INVESTIGAÇÃO DAVI + AQUILES ===\n');

for (const [nome, patientId] of [['DAVI', daviId], ['AQUILES', aquilesId]]) {
    console.log(`\n====== ${nome} (${patientId}) ======`);

    const apts = await db.collection('appointments').find({
        patient: patientId,
        date: { $gte: new Date('2026-06-01') }
    }).sort({ date: 1 }).toArray();

    for (const a of apts) {
        console.log(`\n  Appointment ${a._id}`);
        console.log(`  date:              ${a.date?.toISOString?.()?.slice(0,16)}`);
        console.log(`  operationalStatus: ${a.operationalStatus}`);
        console.log(`  billingType:       ${a.billingType}`);
        console.log(`  cancelledReason:   ${a.cancelledReason || a.canceledReason || 'n/a'}`);
        console.log(`  createdAt:         ${a.createdAt?.toISOString?.()?.slice(0,16)}`);
        console.log(`  updatedAt:         ${a.updatedAt?.toISOString?.()}`);
        const log = a.auditLog || [];
        if (log.length) {
            console.log(`  auditLog (todas entradas):`);
            log.forEach(e => {
                console.log(`    [${e.timestamp?.toISOString?.()?.slice(0,16)}] action=${e.action} source=${e.source || e.userId || 'unknown'} ${e.previousStatus}→${e.newStatus || e.status || '?'} ctx=${JSON.stringify(e.context || e.reason || '')}`);
            });
        } else {
            console.log(`  auditLog: VAZIO`);
        }

        // Buscar session e payment linkados
        if (a.session) {
            const sess = await db.collection('sessions').findOne({ _id: a.session }, { projection: { operationalStatus: 1, updatedAt: 1, paymentStatus: 1 } });
            console.log(`  session ${a.session}: status=${sess?.operationalStatus} updatedAt=${sess?.updatedAt?.toISOString?.()?.slice(0,16)}`);
        }
        if (a.payment) {
            const pay = await db.collection('payments').findOne({ _id: a.payment }, { projection: { status: 1, updatedAt: 1, amount: 1, canceledReason: 1 } });
            console.log(`  payment ${a.payment}: status=${pay?.status} amount=R$${pay?.amount} canceledReason=${pay?.canceledReason || 'n/a'} updatedAt=${pay?.updatedAt?.toISOString?.()?.slice(0,16)}`);
        }
    }
}

// Verificar: alguma coisa rodou às 12:00 no event store ou filas?
console.log('\n\n=== EVENTOS AO REDOR DAS 12:00 (±5 min) ===');
const eventStart = new Date('2026-06-22T11:55:00Z');
const eventEnd   = new Date('2026-06-22T12:10:00Z');

const events = await db.collection('eventstore').find({
    createdAt: { $gte: eventStart, $lte: eventEnd }
}).sort({ createdAt: 1 }).limit(50).toArray();

console.log(`EventStore entries: ${events.length}`);
events.forEach(e => {
    console.log(`  [${e.createdAt?.toISOString?.()?.slice(0,19)}] type=${e.eventType || e.type} aggregate=${e.aggregateId || e.aggregateType} status=${e.status}`);
});

// DLQ / jobs executados
const dlqCancels = await db.collection('jobs').find({
    name: { $regex: /cancel/i },
    createdAt: { $gte: eventStart, $lte: eventEnd }
}).limit(20).toArray();
console.log(`\nJobs de cancel ao redor das 12h: ${dlqCancels.length}`);
dlqCancels.forEach(j => console.log(`  ${j._id} name=${j.name} data=${JSON.stringify(j.data).slice(0,100)}`));

// Checar todos statuses possíveis de appointments futuros (incluindo force_cancelled)
console.log('\n\n=== TODOS STATUS DE APPOINTMENTS >= 22/06 ===');
const allFuture = await db.collection('appointments').aggregate([
    { $match: { date: { $gte: new Date('2026-06-22') } } },
    { $group: { _id: '$operationalStatus', count: { $sum: 1 } } },
    { $sort: { count: -1 } }
]).toArray();
allFuture.forEach(r => console.log(`  ${r._id || 'null'}: ${r.count}`));

await mongoose.disconnect();
console.log('\n=== FIM ===');
