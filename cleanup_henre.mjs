import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;

async function cleanup() {
  await mongoose.connect(MONGODB_URI);
  console.log('✅ MongoDB conectado\n');

  const db = mongoose.connection.db;

  // 1. Buscar TODOS os appointments do Henre
  const appointments = await db.collection('appointments').find({
    patientName: { $regex: /Henre/i }
  }).toArray();

  console.log(`📋 Appointments do Henre encontrados: ${appointments.length}`);
  appointments.forEach(a => {
    console.log(`  - ${a._id} | ${a.date} ${a.time} | Status: ${a.operationalStatus} | PreAgendamento: ${a.metadata?.origin?.preAgendamentoId}`);
  });

  // 2. Buscar TODOS os pré-agendamentos do Henre
  const preAgendamentos = await db.collection('preagendamentos').find({
    'patientInfo.fullName': { $regex: /Henre/i }
  }).toArray();

  console.log(`\n📋 Pré-agendamentos do Henre encontrados: ${preAgendamentos.length}`);
  preAgendamentos.forEach(p => {
    console.log(`  - ${p._id} | ${p.preferredDate} ${p.preferredTime} | Status: ${p.status} | ImportedTo: ${p.importedToAppointment}`);
  });

  // 3. Estratégia: Manter só o appointment mais recente ATIVO e limpar o resto
  // (ou podemos cancelar tudo e criar um novo limpo)
  
  console.log('\n🔍 Analisando...');
  
  const ativos = appointments.filter(a => !['canceled', 'missed'].includes(a.operationalStatus));
  const cancelados = appointments.filter(a => ['canceled', 'missed'].includes(a.operationalStatus));
  
  console.log(`  Ativos: ${ativos.length}`);
  console.log(`  Cancelados: ${cancelados.length}`);

  // 4. Verificar se tem pagamentos/sessões vinculadas
  for (const apt of ativos) {
    const payment = apt.payment ? await db.collection('payments').findOne({ _id: apt.payment }) : null;
    const session = apt.session ? await db.collection('sessions').findOne({ _id: apt.session }) : null;
    console.log(`\n  Appointment ${apt._id}:`);
    console.log(`    Payment: ${payment ? payment._id + ' (' + payment.status + ')' : 'N/A'}`);
    console.log(`    Session: ${session ? session._id + ' (' + session.status + ')' : 'N/A'}`);
  }

  console.log('\n⚠️  Para limpar, descomente as linhas abaixo:');
  console.log('// await db.collection(\'appointments\').deleteMany({ patientName: { $regex: /Henre/i }, operationalStatus: { $ne: \'canceled\' } });');
  console.log('// await db.collection(\'preagendamentos\').deleteMany({ \'patientInfo.fullName\': { $regex: /Henre/i } });');

  await mongoose.disconnect();
}

cleanup().catch(console.error);
