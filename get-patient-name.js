const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

mongoose.connect(MONGO_URI).then(async () => {
  const Patient = require('./models/Patient.js');
  const p = await Patient.findById('69d41ec8f8c4fe2ed67c1950').lean();
  console.log('\n🧑 PACIENTE:');
  console.log('  ID:', '69d41ec8f8c4fe2ed67c1950');
  console.log('  Nome:', p?.name || p?.fullName || 'Não encontrado');
  console.log('  Email:', p?.email || 'N/A');
  console.log('  Telefone:', p?.phone || 'N/A\n');
  process.exit(0);
}).catch(err => {
  console.error('Erro:', err.message);
  process.exit(1);
});
