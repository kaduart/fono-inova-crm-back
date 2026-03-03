import mongoose from 'mongoose';
import PreAgendamento from '../models/PreAgendamento.js';
import Appointment from '../models/Appointment.js';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const amanha = new Date(hoje);
  amanha.setDate(amanha.getDate() + 1);
  
  console.log('🔍 Verificando pré-agendamentos do dia 03/03...\n');
  
  // Busca pré-agendamentos de hoje
  const preAgendamentos = await PreAgendamento.find({
    preferredDate: { $gte: '2026-03-03', $lt: '2026-03-04' }
  }).lean();
  
  console.log(`📋 Total pré-agendamentos: ${preAgendamentos.length}\n`);
  
  for (const pre of preAgendamentos) {
    console.log('─'.repeat(60));
    console.log(`📝 Pré-agendamento: ${pre.patientInfo?.fullName}`);
    console.log(`   ID: ${pre._id}`);
    console.log(`   Status: ${pre.status}`);
    console.log(`   Data: ${pre.preferredDate} ${pre.preferredTime}`);
    console.log(`   Importado para: ${pre.importedToAppointment || 'N/A'}`);
    
    // Verifica se tem appointment correspondente
    if (pre.importedToAppointment) {
      const appt = await Appointment.findById(pre.importedToAppointment).lean();
      if (appt) {
        console.log(`   ✅ Appointment encontrado: ${appt._id}`);
        console.log(`      Status: ${appt.operationalStatus}`);
        console.log(`      Data: ${appt.date} ${appt.time}`);
      } else {
        console.log(`   ❌ Appointment NÃO encontrado (referência quebrada)`);
      }
    }
    console.log('');
  }
  
  // Busca appointments que vieram de pré-agendamento
  console.log('\n🔍 Appointments com preAgendamentoId (hoje):\n');
  const appointments = await Appointment.find({
    date: { $gte: hoje, $lt: amanha },
    preAgendamentoId: { $exists: true, $ne: null }
  }).populate('preAgendamentoId').lean();
  
  console.log(`📋 Total appointments de pré-agendamentos: ${appointments.length}\n`);
  
  for (const appt of appointments) {
    console.log('─'.repeat(60));
    console.log(`✅ Appointment: ${appt._id}`);
    console.log(`   Paciente: ${appt.patient?.fullName || 'N/A'}`);
    console.log(`   Status: ${appt.operationalStatus}`);
    console.log(`   Data: ${appt.date} ${appt.time}`);
    console.log(`   preAgendamentoId: ${appt.preAgendamentoId?._id || appt.preAgendamentoId}`);
    
    if (appt.preAgendamentoId) {
      const pre = typeof appt.preAgendamentoId === 'object' ? appt.preAgendamentoId : null;
      if (pre) {
        console.log(`   Status do pré-agendamento: ${pre.status}`);
      }
    }
    console.log('');
  }
  
  await mongoose.disconnect();
  process.exit(0);
}

main().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
