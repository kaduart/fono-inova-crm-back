import mongoose from 'mongoose';

const uri = 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';
const pkgId = '69cebd72388ba3f63475b343';

await mongoose.connect(uri);

const pkg = await mongoose.connection.collection('packages').findOne(
  { _id: new mongoose.Types.ObjectId(pkgId) },
  { projection: { type: 1, status: 1, patient: 1, sessions: 1, appointments: 1 } }
);

const view = await mongoose.connection.collection('packages_view').findOne(
  { packageId: new mongoose.Types.ObjectId(pkgId) },
  { projection: { type: 1, status: 1, patientId: 1 } }
);

console.log('Package exists:', !!pkg);
console.log('View exists:', !!view);
if (pkg) console.log('Package:', { type: pkg.type, status: pkg.status, sessionsCount: pkg.sessions?.length, appointmentsCount: pkg.appointments?.length });
if (view) console.log('View:', { type: view.type, status: view.status, patientId: view.patientId?.toString() });

await mongoose.disconnect();
