import mongoose from 'mongoose';

const uri = 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';

async function check() {
  try {
    await mongoose.connect(uri);
    
    const Appointment = mongoose.model('Appointment', new mongoose.Schema({}, { strict: false }));
    const Payment = mongoose.model('Payment', new mongoose.Schema({}, { strict: false }));
    const Session = mongoose.model('Session', new mongoose.Schema({}, { strict: false }));
    
    // Busca o agendamento completo das 8h
    const apt = await Appointment.findById('69cad540122af7d586a5650d').lean();
    
    console.log('=== AGENDAMENTO 08:00 COMPLETO ===');
    console.log(JSON.stringify(apt, null, 2));
    
    console.log('\n=== SESSÃO ===');
    const session = await Session.findById(apt.session).lean();
    console.log(JSON.stringify(session, null, 2));
    
    console.log('\n=== PAGAMENTO ===');
    const payment = await Payment.findOne({
      $or: [
        { appointment: apt._id },
        { appointmentId: apt._id.toString() }
      ]
    }).lean();
    console.log(JSON.stringify(payment, null, 2));
    
  } catch (err) {
    console.error('Erro:', err.message);
  } finally {
    await mongoose.disconnect();
  }
}

check();
