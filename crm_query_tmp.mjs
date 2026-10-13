import mongoose from 'mongoose';
const uri = process.argv[2];
await mongoose.connect(uri);

const AdConversion = mongoose.model('AdConversion', new mongoose.Schema({}, { strict: false }), 'adconversions');
const LeadAttribution = mongoose.model('LeadAttribution', new mongoose.Schema({}, { strict: false }), 'leadattributions');

const since = new Date(Date.now() - 15 * 864e5);

const [convs, appts] = await Promise.all([
  LeadAttribution.aggregate([
    { $match: { firstMessageAt: { $gte: since } } },
    { $group: { _id: '$source', conversations: { $sum: 1 } } }
  ]),
  AdConversion.aggregate([
    { $match: { eventTime: { $gte: since }, 'meta.reason': { $ne: 'nao_e_primeiro_agendamento' } } },
    { $group: {
      _id: '$source',
      firstAppointments: { $sum: 1 },
      revenue: { $sum: '$value' },
      sentMeta: { $sum: { $cond: [{ $eq: ['$meta.status', 'sent'] }, 1, 0] } },
      sentGoogle: { $sum: { $cond: [{ $eq: ['$google.status', 'sent'] }, 1, 0] } },
    } }
  ])
]);

console.log('CONVS:' + JSON.stringify(convs));
console.log('APPTS:' + JSON.stringify(appts));
await mongoose.disconnect();
