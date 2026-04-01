import mongoose from 'mongoose';

const uri = 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';

async function check() {
  try {
    await mongoose.connect(uri);
    
    const EventStore = mongoose.model('EventStore', new mongoose.Schema({}, { strict: false }));
    
    // Busca eventos relacionados aos agendamentos
    const events = await EventStore.find({
      $or: [
        { aggregateId: '69cad540122af7d586a5650d' },
        { aggregateId: '69cad798122af7d586a5664e' },
        { 'payload.appointmentId': '69cad540122af7d586a5650d' },
        { 'payload.appointmentId': '69cad798122af7d586a5664e' }
      ]
    }).sort({ createdAt: 1 }).lean();
    
    console.log(`=== EVENTOS ENCONTRADOS (${events.length}) ===`);
    
    events.forEach((e, i) => {
      console.log(`\n${i+1}. ${e.eventType}`);
      console.log(`   Aggregate: ${e.aggregateId}`);
      console.log(`   Status: ${e.status}`);
      console.log(`   Created: ${e.createdAt}`);
      if (e.payload) {
        const payload = typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload;
        console.log(`   Payload:`, JSON.stringify(payload).substring(0, 150));
      }
    });
    
  } catch (err) {
    console.error('Erro:', err.message);
  } finally {
    await mongoose.disconnect();
  }
}

check();
