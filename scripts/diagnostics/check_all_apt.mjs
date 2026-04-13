import mongoose from 'mongoose';

const uri = 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';

async function check() {
  try {
    await mongoose.connect(uri);
    
    const Appointment = mongoose.model('Appointment', new mongoose.Schema({}, { strict: false }));
    const Payment = mongoose.model('Payment', new mongoose.Schema({}, { strict: false }));
    
    const patientId = '69cab94949eddc65b58f48f3';
    
    // Busca TODOS os agendamentos recentes
    const appointments = await Appointment.find({
      patient: patientId
    }).sort({ createdAt: -1 }).limit(10).lean();
    
    console.log(`=== TODOS OS AGENDAMENTOS (${appointments.length}) ===`);
    
    for (const apt of appointments) {
      const dateStr = apt.date ? new Date(apt.date).toLocaleDateString('pt-BR') : 'N/A';
      console.log(`\n📅 ${dateStr} ${apt.time || ''} - ID: ${apt._id}`);
      console.log(`   Status: ${apt.operationalStatus} | Clinical: ${apt.clinicalStatus}`);
      console.log(`   PaymentStatus: ${apt.paymentStatus}`);
      console.log(`   Type: ${apt.type} | Location: ${apt.location}`);
      console.log(`   Session: ${apt.session || 'null'}`);
      console.log(`   PaymentOrigin: ${apt.paymentOrigin || 'null'}`);
      console.log(`   CorrelationId: ${apt.correlationId || 'N/A'}`);
      
      // Verifica se tem pagamento
      const payments = await Payment.find({
        $or: [
          { appointment: apt._id },
          { appointmentId: apt._id.toString() }
        ]
      }).lean();
      
      if (payments.length > 0) {
        console.log(`   💰 Pagamentos (${payments.length}):`);
        payments.forEach(p => {
          console.log(`      - ID: ${p._id} | Status: ${p.status} | R$ ${p.amount || p.value || 0}`);
          console.log(`        Origem: ${p.paymentOrigin || 'N/A'} | Method: ${p.paymentMethod || 'N/A'}`);
        });
      } else {
        console.log(`   💰 Sem pagamentos`);
      }
    }
    
  } catch (err) {
    console.error('Erro:', err.message);
  } finally {
    await mongoose.disconnect();
  }
}

check();
