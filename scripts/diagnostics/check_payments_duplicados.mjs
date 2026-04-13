import mongoose from 'mongoose';

const uri = 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';

async function check() {
  try {
    await mongoose.connect(uri);
    
    const Payment = mongoose.model('Payment', new mongoose.Schema({}, { strict: false }));
    
    // Busca TODOS os pagamentos recentes (últimas 2 horas)
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    
    const payments = await Payment.find({
      createdAt: { $gte: twoHoursAgo }
    }).sort({ createdAt: -1 }).lean();
    
    console.log(`=== PAGAMENTOS RECENTES (${payments.length}) ===`);
    
    // Agrupa por appointment
    const byAppointment = {};
    
    payments.forEach(p => {
      const aptId = p.appointment?.toString() || p.appointmentId;
      if (!aptId) return;
      
      if (!byAppointment[aptId]) {
        byAppointment[aptId] = [];
      }
      byAppointment[aptId].push(p);
    });
    
    // Mostra appointments com múltiplos pagamentos
    console.log('\n=== APPOINTMENTS COM PAGAMENTOS ===');
    for (const [aptId, pmtList] of Object.entries(byAppointment)) {
      console.log(`\n📅 Appointment: ${aptId}`);
      console.log(`   Quantidade de pagamentos: ${pmtList.length}`);
      
      if (pmtList.length > 1) {
        console.log('   🚨 DUPLICADO!');
      }
      
      pmtList.forEach((p, i) => {
        console.log(`   ${i+1}. ${p._id} | ${p.status} | R$ ${p.amount || p.value || 0} | ${p.createdAt.toISOString()}`);
      });
    }
    
  } catch (err) {
    console.error('Erro:', err.message);
  } finally {
    await mongoose.disconnect();
  }
}

check();
