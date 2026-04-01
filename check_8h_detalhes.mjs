import mongoose from 'mongoose';

const uri = 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';

async function check() {
  try {
    await mongoose.connect(uri);
    
    const Appointment = mongoose.model('Appointment', new mongoose.Schema({}, { strict: false }));
    const Payment = mongoose.model('Payment', new mongoose.Schema({}, { strict: false }));
    const Session = mongoose.model('Session', new mongoose.Schema({}, { strict: false }));
    
    // Agendamento das 8h
    const apt8h = await Appointment.findById('69cad540122af7d586a5650d').lean();
    
    console.log('=== AGENDAMENTO 08:00 ===');
    console.log(`ID: ${apt8h._id}`);
    console.log(`Status: ${apt8h.operationalStatus}`);
    console.log(`Clinical: ${apt8h.clinicalStatus}`);
    console.log(`Payment: ${apt8h.paymentStatus}`);
    console.log(`Session: ${apt8h.session}`);
    console.log(`Valor: R$ ${apt8h.sessionValue}`);
    console.log(`UpdatedAt: ${apt8h.updatedAt}`);
    
    // Session
    const session = await Session.findById(apt8h.session).lean();
    if (session) {
      console.log('\n=== SESSÃO ===');
      console.log(`ID: ${session._id}`);
      console.log(`Status: ${session.status}`);
      console.log(`PaymentStatus: ${session.paymentStatus}`);
      console.log(`Valor: R$ ${session.sessionValue}`);
      console.log(`Completed: ${session.completed}`);
      console.log(`CompletedAt: ${session.completedAt}`);
    }
    
    // TODOS os pagamentos relacionados
    console.log('\n=== TODOS OS PAGAMENTOS ===');
    const payments = await Payment.find({
      $or: [
        { appointment: apt8h._id },
        { appointmentId: apt8h._id.toString() }
      ]
    }).sort({ createdAt: 1 }).lean();
    
    payments.forEach((p, i) => {
      console.log(`\n${i+1}. ID: ${p._id}`);
      console.log(`   Status: ${p.status}`);
      console.log(`   Valor: R$ ${p.amount || p.value}`);
      console.log(`   Origem: ${p.paymentOrigin || 'N/A'}`);
      console.log(`   Method: ${p.paymentMethod}`);
      console.log(`   Created: ${p.createdAt}`);
      console.log(`   CorrelationId: ${p.correlationId || 'N/A'}`);
    });
    
    // Agora verifica o de 14h também
    console.log('\n\n=== AGENDAMENTO 14:00 (COMPARAÇÃO) ===');
    const apt14h = await Appointment.findById('69cad798122af7d586a5664e').lean();
    console.log(`ID: ${apt14h._id}`);
    console.log(`Status: ${apt14h.operationalStatus}`);
    console.log(`Clinical: ${apt14h.clinicalStatus}`);
    console.log(`Payment: ${apt14h.paymentStatus}`);
    console.log(`Session: ${apt14h.session}`);
    
    const payments14h = await Payment.find({
      $or: [
        { appointment: apt14h._id },
        { appointmentId: apt14h._id.toString() }
      ]
    }).lean();
    
    console.log(`\nPagamentos (${payments14h.length}):`);
    payments14h.forEach((p, i) => {
      console.log(`  ${i+1}. ${p._id} | ${p.status} | R$ ${p.amount || p.value}`);
    });
    
  } catch (err) {
    console.error('Erro:', err.message);
  } finally {
    await mongoose.disconnect();
  }
}

check();
