import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();
await mongoose.connect(process.env.MONGO_URI);

const S = mongoose.model('Session', new mongoose.Schema({}, { strict: false }));
const P = mongoose.model('Payment', new mongoose.Schema({}, { strict: false }));
const Pkg = mongoose.model('Package', new mongoose.Schema({}, { strict: false }));
const Pat = mongoose.model('Patient', new mongoose.Schema({}, { strict: false }));

const davi = await Pat.findOne({ name: /davi/i }).select('_id name').lean();
console.log('Paciente:', davi?.name, String(davi?._id));

const jan_start = new Date('2026-01-01');
const jan_end   = new Date('2026-02-01');

const sessions = await S.find({
  patient: davi._id,
  date: { $gte: jan_start, $lt: jan_end },
  status: 'completed'
}).select('_id date sessionType billingType package insurance').lean();

console.log(`\nSessions completed jan: ${sessions.length}`);
for (const s of sessions) {
  console.log(`  ${s.date?.toISOString().slice(0,10)} | type=${s.sessionType} | billing=${s.billingType} | pkg=${s.package || '-'}`);
}

const payments = await P.find({
  patient: davi._id,
  billingType: 'convenio',
  serviceDate: { $gte: jan_start, $lt: jan_end }
}).select('_id amount status serviceDate session insurance').lean();

console.log(`\nPayments convênio jan: ${payments.length}`);
for (const p of payments) {
  console.log(`  ${p.serviceDate?.toISOString().slice(0,10)} | R$${p.amount} | ${p.status} | sess=${p.session || '-'} | ins.status=${p.insurance?.status}`);
}

const pkgs = await Pkg.find({ patient: davi._id, type: 'convenio' }).select('_id provider createdAt').lean();
console.log(`\nPackages convênio: ${pkgs.length}`);
for (const pk of pkgs) console.log(`  ${pk._id} | provider=${pk.provider} | criado=${pk.createdAt?.toISOString().slice(0,10)}`);

await mongoose.disconnect();
