import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!mongoUri) {
  console.error('MONGODB_URI/MONGO_URI não encontrado');
  process.exit(1);
}

await mongoose.connect(mongoUri);
await import('../models/index.js');
await import('../models/InsuranceBatch.js');

const InsuranceGuide = mongoose.model('InsuranceGuide');
const Appointment = mongoose.model('Appointment');
const InsuranceBatch = mongoose.model('InsuranceBatch');

const batches = await InsuranceBatch.find({}, { 'sessions.guide': 1 }).lean();
const guideIdsInBatches = new Set();
for (const b of batches) {
  for (const s of b.sessions || []) {
    if (s.guide) guideIdsInBatches.add(s.guide.toString());
  }
}
console.log('Total de guias que já apareceram em lotes:', guideIdsInBatches.size);

const guides = await InsuranceGuide.find({
  _id: { $in: Array.from(guideIdsInBatches).map(id => new mongoose.Types.ObjectId(id)) },
  billingMode: 'per_month'
}).lean();

console.log('Dessas, guias per_month:', guides.length);

const closedGuides = guides.filter(g => g.closedAt || g.status === 'closed');
const openGuides = guides.filter(g => !g.closedAt && g.status !== 'closed');
console.log('Já encerradas (closedAt/status closed):', closedGuides.length);
console.log('NÃO encerradas:', openGuides.length);

const pendingCounts = await Appointment.aggregate([
  { $match: { insuranceGuide: { $in: openGuides.map(g => g._id) }, operationalStatus: { $in: ['scheduled', 'confirmed', 'pre_agendado'] } } },
  { $group: { _id: '$insuranceGuide', count: { $sum: 1 } } }
]);
const pendingByGuide = new Map(pendingCounts.map(p => [p._id.toString(), p.count]));
console.log('Guias não encerradas COM agendamentos pendentes:', pendingCounts.length);
console.log('Guias não encerradas SEM agendamentos pendentes:', openGuides.length - pendingCounts.length);

console.log('\nExemplos de guias não encerradas (primeiras 20):');
for (const g of openGuides.slice(0, 20)) {
  console.log(' -', g.number, g.insurance, 'pendentes:', pendingByGuide.get(g._id.toString()) || 0);
}

await mongoose.disconnect();
