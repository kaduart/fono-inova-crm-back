import mongoose from 'mongoose';

const uri = 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';

async function check() {
  try {
    await mongoose.connect(uri);
    
    const Appointment = mongoose.model('Appointment', new mongoose.Schema({}, { strict: false }));
    const Payment = mongoose.model('Payment', new mongoose.Schema({}, { strict: false }));
    const Patient = mongoose.model('Patient', new mongoose.Schema({}, { strict: false }));
    
    // Busca agendamentos criados nas últimas 2 horas
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    
    const appointments = await Appointment.find({
      createdAt: { $gte: twoHoursAgo }
    }).sort({ createdAt: -1 }).limit(20).lean();
    
    console.log(`=== AGENDAMENTOS RECENTES (${appointments.length}) ===`);
    
    for (const apt of appointments) {
      const patient = await Patient.findById(apt.patient).select('fullName').lean();
      const dateStr = apt.date ? new Date(apt.date).toLocaleDateString('pt-BR') : 'N/A';
      
      console.log(`\n📅 ${dateStr} ${apt.time || ''} - ${patient?.fullName || 'Paciente N/A'}`);
      console.log(`   ID: ${apt._id}`);
      console.log(`   Status: ${apt.operationalStatus} | Clinical: ${apt.clinicalStatus} | Payment: ${apt.paymentStatus}`);
      console.log(`   Valor: R$ ${apt.sessionValue || 0} | Type: ${apt.type}`);
      console.log(`   Package: ${apt.package || 'null'} | Session: ${apt.session || 'null'}`);
      
      // Verifica pagamentos
      const payments = await Payment.find({
        $or: [
          { appointment: apt._id },
          { appointmentId: apt._id.toString() }
        ]
      }).lean();
      
      if (payments.length > 0) {
        console.log(`   💰 Pagamentos (${payments.length}):`);
        payments.forEach(p => {
          console.log(`      - ID: ${p._id} | ${p.status} | R$ ${p.amount || p.value || 0} | ${p.paymentOrigin || 'N/A'}`);
        });
      }
    }
    
  } catch (err) {
    console.error('Erro:', err.message);
  } finally {
    await mongoose.disconnect();
  }
}

check();
