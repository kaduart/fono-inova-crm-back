import 'dotenv/config';
import mongoose from 'mongoose';

const EMAILS = [
  'beatrizsouzanunes555@gmail.com',
  'eugeniaviviane@gmail.com',
];

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('MONGO_URI não encontrada no .env');
  process.exit(1);
}

await mongoose.connect(MONGO_URI);
console.log('Conectado ao MongoDB');

const Admin = mongoose.model('Admin', new mongoose.Schema({}, { strict: false }), 'admins');

const before = await Admin.find({ email: { $in: EMAILS } }, 'email role');
console.log('Estado atual:', before.map(a => `${a.email} → role=${a.role}`));

const result = await Admin.updateMany(
  { email: { $in: EMAILS } },
  { $set: { role: 'secretary' } }
);

console.log(`Atualizadas: ${result.modifiedCount} conta(s)`);

const after = await Admin.find({ email: { $in: EMAILS } }, 'email role');
console.log('Estado final:', after.map(a => `${a.email} → role=${a.role}`));

await mongoose.disconnect();
console.log('Pronto.');
