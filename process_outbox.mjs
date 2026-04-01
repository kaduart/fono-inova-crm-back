import mongoose from 'mongoose';
import { publishEvent } from './infrastructure/events/eventPublisher.js';

const uri = 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';

const outboxSchema = new mongoose.Schema({
  eventId: String,
  eventType: String,
  status: String,
  payload: mongoose.Schema.Types.Mixed,
  options: mongoose.Schema.Types.Mixed,
  attempts: { type: Number, default: 0 },
  lastError: String,
  publishedAt: Date
});

async function process() {
  try {
    await mongoose.connect(uri);
    const Outbox = mongoose.model('Outbox', outboxSchema);
    
    // Busca evento de invoice
    const event = await Outbox.findOne({
      eventId: 'INVOICE_PER_SESSION_CREATE_1774902243781_r8jpyzqns'
    });
    
    if (!event) {
      console.log('Evento não encontrado');
      return;
    }
    
    console.log('=== PROCESSANDO EVENTO ===');
    console.log(`Type: ${event.eventType}`);
    console.log(`Status: ${event.status}`);
    
    // Publica o evento
    const result = await publishEvent(
      event.eventType,
      event.payload,
      event.options || {}
    );
    
    console.log('✅ Evento publicado:', result);
    
    // Atualiza status
    event.status = 'published';
    event.publishedAt = new Date();
    await event.save();
    
    console.log('✅ Status atualizado para published');
    
  } catch (err) {
    console.error('❌ Erro:', err.message);
  } finally {
    await mongoose.disconnect();
  }
}

process();
