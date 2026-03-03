import mongoose from 'mongoose';
import PreAgendamento from '../models/PreAgendamento.js';
import Appointment from '../models/Appointment.js';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  
  console.log('🔍 DIAGNÓSTICO DE PRÉ-AGENDAMENTOS\n');
  console.log('═'.repeat(70));
  
  // 1. Conta todos os pré-agendamentos
  const total = await PreAgendamento.countDocuments();
  const importados = await PreAgendamento.countDocuments({ status: 'importado' });
  const naoImportados = await PreAgendamento.countDocuments({ 
    status: { $nin: ['importado', 'descartado', 'desistiu'] } 
  });
  
  console.log(`\n📊 Resumo geral:`);
  console.log(`   Total: ${total}`);
  console.log(`   Importados: ${importados}`);
  console.log(`   Não importados: ${naoImportados}`);
  
  // 2. Busca pré-agendamentos do dia 03 que ainda não foram importados
  console.log(`\n📋 Pré-agendamentos de 2026-03-03 NÃO importados:`);
  console.log('─'.repeat(70));
  
  const preNaoImportados = await PreAgendamento.find({
    preferredDate: '2026-03-03',
    status: { $nin: ['importado', 'descartado', 'desistiu'] }
  }).lean();
  
  if (preNaoImportados.length === 0) {
    console.log('   ✅ Nenhum pré-agendamento não-importado encontrado para o dia 03');
  } else {
    preNaoImportados.forEach(pre => {
      console.log(`   ❌ ${pre.patientInfo?.fullName} | ${pre.preferredTime} | Status: ${pre.status}`);
      console.log(`      ID: ${pre._id}`);
      console.log(`      importedToAppointment: ${pre.importedToAppointment || 'null'}`);
    });
  }
  
  // 3. Busca appointments do dia 03 que vieram de pré-agendamento
  console.log(`\n📋 Appointments de 03/03 que vieram de pré-agendamento:`);
  console.log('─'.repeat(70));
  
  const hoje = new Date('2026-03-03');
  const amanha = new Date('2026-03-04');
  
  const appointments = await Appointment.find({
    date: { $gte: hoje, $lt: amanha },
    preAgendamentoId: { $exists: true, $ne: null }
  }).populate('preAgendamentoId', 'status patientInfo.fullName').lean();
  
  if (appointments.length === 0) {
    console.log('   ℹ️ Nenhum appointment de pré-agendamento encontrado');
  } else {
    appointments.forEach(appt => {
      const pre = appt.preAgendamentoId;
      console.log(`   ✅ ${appt.patient?.fullName || 'N/A'} | ${appt.time}`);
      console.log(`      Appointment ID: ${appt._id}`);
      console.log(`      preAgendamentoId: ${appt.preAgendamentoId?._id || appt.preAgendamentoId}`);
      console.log(`      Status do pré-agendamento: ${pre?.status || 'N/A'}`);
    });
  }
  
  // 4. Verifica se há pré-agendamentos com importedToAppointment mas sem status importado
  console.log(`\n🔍 Pré-agendamentos com importedToAppointment mas status diferente de 'importado':`);
  console.log('─'.repeat(70));
  
  const inconsistentes = await PreAgendamento.find({
    importedToAppointment: { $exists: true, $ne: null },
    status: { $ne: 'importado' }
  }).lean();
  
  if (inconsistentes.length === 0) {
    console.log('   ✅ Nenhuma inconsistência encontrada');
  } else {
    inconsistentes.forEach(pre => {
      console.log(`   ⚠️ ${pre.patientInfo?.fullName}`);
      console.log(`      Status: ${pre.status} (deveria ser 'importado')`);
      console.log(`      importedToAppointment: ${pre.importedToAppointment}`);
    });
  }
  
  console.log('\n' + '═'.repeat(70));
  
  await mongoose.disconnect();
  process.exit(0);
}

main().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
