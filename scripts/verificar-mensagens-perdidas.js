/**
 * 🔍 Verifica mensagens do WhatsApp perdidas durante a falha do webhook
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

// Schema do EventStore
const EventStoreSchema = new mongoose.Schema({
  eventId: String,
  eventType: String,
  domain: String,
  status: String,
  timestamp: Date,
  payload: mongoose.Schema.Types.Mixed
}, { collection: 'eventstores' });

const RawWebhookLogSchema = new mongoose.Schema({
  body: mongoose.Schema.Types.Mixed,
  receivedAt: Date
}, { collection: 'raw_webhook_logs' });

async function verificarMensagens() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Conectado ao MongoDB\n');

    const EventStore = mongoose.model('EventStore', EventStoreSchema);
    const RawWebhookLog = mongoose.model('RawWebhookLog', RawWebhookLogSchema);

    // 1. Verificar EventStore
    const eventosWhatsApp = await EventStore.find({
      domain: 'whatsapp',
      timestamp: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
    }).sort({ timestamp: -1 }).limit(20);

    console.log('📊 Eventos WhatsApp (últimos 7 dias):', eventosWhatsApp.length);
    eventosWhatsApp.forEach(e => {
      console.log(`  - ${e.eventType} | ${e.status} | ${e.timestamp.toISOString()}`);
    });

    // 2. Verificar RawWebhookLog (logs brutos)
    const logsBrutos = await RawWebhookLog.find({
      receivedAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
    }).sort({ receivedAt: -1 }).limit(20);

    console.log('\n📋 Logs brutos do webhook (últimos 7 dias):', logsBrutos.length);
    logsBrutos.forEach(l => {
      const entry = l.body?.entry?.[0];
      const change = entry?.changes?.[0];
      const message = change?.value?.messages?.[0];
      const from = message?.from;
      console.log(`  - De: ${from || 'N/A'} | ${l.receivedAt.toISOString()}`);
    });

    // 3. Verificar mensagens não processadas
    const pendentes = await EventStore.countDocuments({
      domain: 'whatsapp',
      status: { $in: ['pending', 'failed'] },
      timestamp: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
    });

    console.log('\n🚨 Mensagens pendentes/falhas:', pendentes);

    if (pendentes > 0) {
      console.log('\n💡 Para reprocessar, execute:');
      console.log('  node scripts/reprocessar-eventos-whatsapp.js');
    }

    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('❌ Erro:', err.message);
    process.exit(1);
  }
}

verificarMensagens();
