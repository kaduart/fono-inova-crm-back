import mongoose from 'mongoose';

await mongoose.connect('mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/fono_inova_prod?retryWrites=true&w=majority&appName=Cluster0');
const db = mongoose.connection.db;

const patient = await db.collection('patients').findOne({ fullName: { $regex: /Isis/i } });
console.log('Patient:', patient ? { id: patient._id.toString(), name: patient.fullName } : 'NOT FOUND');
if (!patient) { await mongoose.disconnect(); process.exit(0); }

const sessions = await db.collection('sessions').find({ patient: patient._id, status: 'completed' }).sort({ date: -1 }).toArray();
console.log('\nTotal completed sessions:', sessions.length);

let totalPendente = 0;
for (const s of sessions) {
    const appt = s.appointmentId ? await db.collection('appointments').findOne({ _id: s.appointmentId }) : null;
    const payment = appt?.payment ? await db.collection('payments').findOne({ _id: appt.payment }) : null;
    const pkg = s.package ? await db.collection('packages').findOne({ _id: s.package }) : null;
    
    const isPendente = !payment || payment.status !== 'paid';
    if (isPendente) totalPendente += s.sessionValue || 0;
    
    console.log({
        date: s.date?.toISOString()?.split('T')[0],
        time: s.time,
        value: s.sessionValue,
        status: s.status,
        paymentStatus: s.paymentStatus,
        paymentOrigin: s.paymentOrigin,
        paymentMethod: s.paymentMethod,
        apptPaymentStatus: payment?.status,
        apptPaymentAmount: payment?.amount,
        apptBillingType: appt?.billingType,
        hasPackage: !!s.package,
        packageType: pkg?.paymentType || pkg?.model || 'none',
        isPendente
    });
}
console.log('\nTotal pendente:', totalPendente);
await mongoose.disconnect();
