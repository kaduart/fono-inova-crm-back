import mongoose from 'mongoose';
const uri = "mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/test?retryWrites=true&w=majority";
async function main() {
    const conn = await mongoose.createConnection(uri).asPromise();
    const db = conn.db;

    const pat = await db.collection('patients').findOne({ fullName: { $regex: /enthony/i } });
    console.log('Paciente:', pat?.fullName, '|', pat?._id);
    if (!pat) { await conn.close(); return; }

    const doc = await db.collection('doctors').findOne({ fullName: { $regex: /suzane/i } });
    console.log('Doutora:', doc?.fullName, '|', doc?._id);

    // Agendamentos Enthony com Suzane
    const appts = await db.collection('appointments').find({
        patient: pat._id,
        ...(doc ? { doctor: doc._id } : {})
    }).sort({ createdAt: -1 }).limit(10).toArray();

    console.log(`\nAgendamentos Enthony (${appts.length}):`);
    appts.forEach(a => {
        console.log(`  ${a._id} | date:${a.date} | ${a.serviceType} | op:${a.operationalStatus} | pay:${a.paymentStatus} | val:R$${a.sessionValue}`);
    });

    // Sessions
    const sessions = await db.collection('sessions').find({
        patient: pat._id,
        ...(doc ? { doctor: doc._id } : {})
    }).sort({ date: -1 }).limit(10).toArray();
    console.log(`\nSessions (${sessions.length}):`);
    sessions.forEach(s => console.log(`  ${s._id} | date:${s.date} | status:${s.status} | pay:${s.paymentStatus}`));

    await conn.close();
}
main().catch(e => { console.error(e.message); process.exit(1); });
