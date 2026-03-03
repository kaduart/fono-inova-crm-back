import mongoose from 'mongoose';
import PreAgendamento from './models/PreAgendamento.js';
import dotenv from 'dotenv';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/fono_inova';

await mongoose.connect(MONGODB_URI);
console.log('✅ MongoDB conectado');

// Buscar todos os pré-agendamentos do Henre para 04/03
const henres = await PreAgendamento.find({
  'patientInfo.fullName': { $regex: /Henre Gabriel/i },
  preferredDate: '2026-03-04',
  preferredTime: '08:00'
}).sort({ createdAt: -1 }); // Mais recente primeiro

console.log(`\n🔍 Encontrados ${henres.length} pré-agendamentos do Henre para 04/03 às 08:00`);

if (henres.length === 0) {
  console.log('❌ Nenhum encontrado');
  process.exit(0);
}

// Mostrar todos
henres.forEach((h, i) => {
  console.log(`\n[${i + 1}] ID: ${h._id}`);
  console.log(`    Criado em: ${h.createdAt}`);
  console.log(`    Status: ${h.status}`);
  console.log(`    Imported: ${h.importedToAppointment || 'Não importado'}`);
  console.log(`    Valor: ${h.suggestedValue}`);
});

// Manter o mais recente, excluir os outros
const manter = henres[0];
const excluir = henres.slice(1);

console.log(`\n✅ Vou MANTER: ${manter._id} (mais recente)`);
console.log(`🗑️  Vou EXCLUIR: ${excluir.map(e => e._id).join(', ')}`);

// Excluir
for (const pre of excluir) {
  await PreAgendamento.findByIdAndDelete(pre._id);
  console.log(`🗑️  Excluído: ${pre._id}`);
}

console.log(`\n✅ LIMPO! Sobrou só: ${manter._id}`);
console.log(`📋 Pré-agendamento ID para importar: ${manter._id}`);

process.exit(0);
