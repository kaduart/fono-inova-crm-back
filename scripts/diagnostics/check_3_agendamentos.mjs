import mongoose from 'mongoose';

const uri = 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';

async function check() {
  try {
    await mongoose.connect(uri);
    
    const Appointment = mongoose.model('Appointment', new mongoose.Schema({}, { strict: false }));
    const Payment = mongoose.model('Payment', new mongoose.Schema({}, { strict: false }));
    const Patient = mongoose.model('Patient', new mongoose.Schema({}, { strict: false }));
    
    // Busca paciente "Paciente Teste P..."
    const patient = await Patient.findOne({
      fullName: { $regex: /Paciente Teste/i }
    }).lean();
    
    if (!patient) {
      console.log('Paciente não encontrado');
      return;
    }
    
    console.log('=== PACIENTE ===');
    console.log(`ID: ${patient._id}`);
    console.log(`Nome: ${patient.fullName}`);
    
    // Busca agendamentos do paciente de 30/03/2026
    const startDate = new Date('2026-03-30');
    const endDate = new Date('2026-03-31');
    
    const appointments = await Appointment.find({
      patient: patient._id,
      date: { $gte: startDate, $lt: endDate }
    }).sort({ time: 1 }).lean();
    
    console.log(`\n=== AGENDAMENTOS (${appointments.length}) ===`);
    
    for (const apt of appointments) {
      console.log(`\n📅 ${apt.time} - ID: ${apt._id}`);
      console.log(`   Status: ${apt.operationalStatus} | Clinical: ${apt.clinicalStatus} | Payment: ${apt.paymentStatus}`);
      console.log(`   Type: ${apt.type} | Source: ${apt.source}`);
      console.log(`   Package: ${apt.package || 'null'}`);
      console.log(`   Session: ${apt.session || 'null'}`);
      console.log(`   Valor: R$ ${apt.sessionValue || 0}`);
      
      // Busca pagamentos relacionados
      const payments = await Payment.find({
        $or: [
          { appointment: apt._id },
          { 'appointmentId': apt._id.toString() }
        ]
      }).lean();
      
      if (payments.length > 0) {
        console.log(`   💰 Pagamentos (${payments.length}):`);
        payments.forEach((p, i) => {
          console.log(`      ${i+1}. ID: ${p._id} | Status: ${p.status} | Valor: R$ ${p.amount || p.value}`);
          console.log(`         Origem: ${p.paymentOrigin || 'N/A'} | Method: ${p.paymentMethod}`);
        });
      }
    }
    
    // Busca TODOS os pagamentos do paciente
    console.log(`\n=== TODOS OS PAGAMENTOS DO PACIENTE ===`);
    const allPayments = await Payment.find({
      patient: patient._id
    }).sort({ createdAt: -1 }).limit(10).lean();
    
    allPayments.forEach((p, i) => {
      console.log(`\n${i+1}. ID: ${p._id}`);
      console.log(`   Status: ${p.status} | Valor: R$ ${p.amount || p.value}`);
      console.log(`   Origem: ${p.paymentOrigin || 'N/A'}`);
      console.log(`   Appointment: ${p.appointment || 'N/A'}`);
      console.log(`   Created: ${p.createdAt}`);
    });
    
  } catch (err) {
    console.error('Erro:', err.message);
  } finally {
    await mongoose.disconnect();
  }
}

check();
