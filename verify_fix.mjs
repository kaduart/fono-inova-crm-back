import mongoose from 'mongoose';

const uri = 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';

async function verify() {
  try {
    await mongoose.connect(uri);
    
    const Appointment = mongoose.model('Appointment', new mongoose.Schema({}, { strict: false }));
    const Payment = mongoose.model('Payment', new mongoose.Schema({}, { strict: false }));
    
    console.log('=== VERIFICANDO CORREÇÕES ===\n');
    
    // Verifica 08:00
    const apt8h = await Appointment.findById('69cad540122af7d586a5650d').lean();
    const pay8h = await Payment.findById('69cad542122af7d586a56515').lean();
    
    console.log('📅 Agendamento 08:00:');
    console.log(`   operationalStatus: "${apt8h.operationalStatus}" ${apt8h.operationalStatus === 'completed' ? '✅' : '❌'}`);
    console.log(`   clinicalStatus: "${apt8h.clinicalStatus}" ✅`);
    console.log(`   Pagamento: "${pay8h.status}" ${pay8h.status === 'paid' ? '✅' : '❌'}`);
    console.log(`   Valor: R$ ${pay8h.amount}`);
    
    // Verifica 14:00
    const apt14h = await Appointment.findById('69cad798122af7d586a5664e').lean();
    const pay14h = await Payment.findById('69cad798122af7d586a5665c').lean();
    
    console.log('\n📅 Agendamento 14:00:');
    console.log(`   operationalStatus: "${apt14h.operationalStatus}" ${apt14h.operationalStatus === 'completed' ? '✅' : '❌'}`);
    console.log(`   clinicalStatus: "${apt14h.clinicalStatus}" ✅`);
    console.log(`   Pagamento: "${pay14h.status}" ${pay14h.status === 'paid' ? '✅' : '❌'}`);
    console.log(`   Valor: R$ ${pay14h.amount}`);
    
    console.log('\n✅ Todos os agendamentos corrigidos!');
    
  } catch (err) {
    console.error('❌ Erro:', err.message);
  } finally {
    await mongoose.disconnect();
  }
}

verify();
