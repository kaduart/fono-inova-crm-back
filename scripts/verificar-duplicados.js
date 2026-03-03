import mongoose from 'mongoose';
import Appointment from '../models/Appointment.js';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const amanha = new Date(hoje);
  amanha.setDate(amanha.getDate() + 1);
  
  // Busca appointments de hoje
  const appts = await Appointment.find({
    date: { $gte: hoje, $lt: amanha }
  }).select('patient date time preAgendamentoId operationalStatus doctor').populate('patient', 'fullName');
  
  console.log('📊 Total appointments hoje:', appts.length);
  console.log('\nDetalhes:');
  appts.forEach(a => {
    console.log(`  - ${a.patient?.fullName || 'N/A'} | ${a.time} | ${a.operationalStatus} | preId: ${a.preAgendamentoId || 'N/A'}`);
  });
  
  // Agrupa por paciente/horário
  const grupos = {};
  appts.forEach(a => {
    const patientName = a.patient?.fullName || 'N/A';
    const key = `${patientName}-${a.time}`;
    if (!grupos[key]) grupos[key] = [];
    grupos[key].push({ 
      id: a._id.toString(), 
      pre: a.preAgendamentoId, 
      status: a.operationalStatus,
      doctor: a.doctor 
    });
  });
  
  console.log('\n🔍 Verificando duplicados...');
  let encontrouDuplicado = false;
  Object.entries(grupos).forEach(([key, lista]) => {
    if (lista.length > 1) {
      encontrouDuplicado = true;
      console.log('\n❌ DUPLICADO:', key);
      lista.forEach(item => {
        console.log(`   ID: ${item.id}`);
        console.log(`   Status: ${item.status}`);
        console.log(`   PreAgendamentoId: ${item.pre || 'N/A'}`);
        console.log(`   Doctor: ${item.doctor}`);
        console.log('   ---');
      });
    }
  });
  
  if (!encontrouDuplicado) {
    console.log('✅ Nenhum duplicado encontrado.');
  }
  
  await mongoose.disconnect();
  process.exit(0);
}

main().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
