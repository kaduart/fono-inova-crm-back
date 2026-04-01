import mongoose from 'mongoose';

const uri = 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';

async function fix() {
  try {
    await mongoose.connect(uri);
    
    const Appointment = mongoose.model('Appointment', new mongoose.Schema({}, { strict: false }));
    const Payment = mongoose.model('Payment', new mongoose.Schema({}, { strict: false }));
    
    console.log('=== CORRIGINDO AGENDAMENTOS ===\n');
    
    // Corrige agendamento 08:00
    console.log('📅 Corrigindo agendamento 08:00...');
    await Appointment.findByIdAndUpdate('69cad540122af7d586a5650d', {
      operationalStatus: 'completed'
    });
    console.log('   ✅ operationalStatus -> completed');
    
    await Payment.findByIdAndUpdate('69cad542122af7d586a56515', {
      status: 'paid'
    });
    console.log('   ✅ Pagamento -> paid');
    
    // Corrige agendamento 14:00
    console.log('\n📅 Corrigindo agendamento 14:00...');
    await Appointment.findByIdAndUpdate('69cad798122af7d586a5664e', {
      operationalStatus: 'completed'
    });
    console.log('   ✅ operationalStatus -> completed');
    
    await Payment.findByIdAndUpdate('69cad798122af7d586a5665c', {
      status: 'paid',
      amount: 0  // Corrigindo valor undefined
    });
    console.log('   ✅ Pagamento -> paid (valor corrigido)');
    
    console.log('\n✅ TODOS OS DADOS CORRIGIDOS!');
    
  } catch (err) {
    console.error('❌ Erro:', err.message);
  } finally {
    await mongoose.disconnect();
  }
}

fix();
