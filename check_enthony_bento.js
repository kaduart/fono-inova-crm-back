import mongoose from 'mongoose';
const uri = "mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/test?retryWrites=true&w=majority";
async function main() {
    const conn = await mongoose.createConnection(uri).asPromise();
    const db = conn.db;

    const patients = await db.collection('patients').find({
        fullName: { $regex: /enthony|bento/i }
    }).toArray();
    console.log('Pacientes:', patients.map(p => `${p.fullName} | ${p._id}`));

    for (const pat of patients) {
        const appts = await db.collection('appointments').find({
            patient: pat._id,
            $or: [{ date: '2026-03-31' }]
        }).toArray();

        const sessions = await db.collection('sessions').find({
            patient: pat._id,
            date: '2026-03-31'
        }).toArray();

        const doctors = await db.collection('doctors').find({
            _id: { $in: [...appts.map(a => a.doctor), ...sessions.map(s => s.doctor)].filter(Boolean) }
        }).toArray();
        const docMap = Object.fromEntries(doctors.map(d => [d._id.toString(), d.fullName]));

        console.log(`\n--- ${pat.fullName} ---`);
        console.log(`Appointments 31/03 (${appts.length}):`);
        appts.forEach(a => console.log(`  ${a._id} | ${docMap[a.doctor?.toString()] || a.doctor} | ${a.serviceType} | op:${a.operationalStatus} | pay:${a.paymentStatus} | R$${a.sessionValue}`));
        console.log(`Sessions 31/03 (${sessions.length}):`);
        sessions.forEach(s => console.log(`  ${s._id} | ${docMap[s.doctor?.toString()] || s.doctor} | status:${s.status} | pay:${s.paymentStatus}`));
    }

    await conn.close();
}
main().catch(e => { console.error(e.message); process.exit(1); });
