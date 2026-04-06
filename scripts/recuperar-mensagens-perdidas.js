/**
 * 🔄 Recupera mensagens do WhatsApp perdidas durante falha do webhook
 * Busca em raw_webhook_logs e reprocessa
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { publishEvent } from '../infrastructure/events/eventPublisher.js';

dotenv.config();

const RawWebhookLogSchema = new mongoose.Schema({
  body: mongoose.Schema.Types.Mixed,
  receivedAt: Date,
  headers: mongoose.Schema.Types.Mixed
}, { collection: 'raw_webhook_logs' });

async function recuperarMensagens() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Conectado ao MongoDB\n');

    const RawWebhookLog = mongoose.model('RawWebhookLog', RawWebhookLogSchema);

    // Busca logs dos últimos 7 dias
    const logs = await RawWebhookLog.find({
      receivedAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
    }).sort({ receivedAt: 1 });

    console.log(`📋 Total de logs encontrados: ${logs.length}\n`);

    let mensagensEncontradas = 0;
    let mensagensReprocessadas = 0;

    for (const log of logs) {
      const entry = log.body?.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;
      const message = value?.messages?.[0];

      if (!message) continue; // Skip se não é mensagem (pode ser status update)

      mensagensEncontradas++;
      const from = message.from;
      const content = message.text?.body || '[mídia]';

      console.log(`📩 Mensagem ${mensagensEncontradas}:`);
      console.log(`   De: ${from}`);
      console.log(`   Conteúdo: ${content.substring(0, 50)}...`);
      console.log(`   Data: ${log.receivedAt.toISOString()}`);

      try {
        // Republica o evento
        await publishEvent('WHATSAPP_MESSAGE_RECEIVED', {
          msg: message,
          value: value
        });

        mensagensReprocessadas++;
        console.log('   ✅ Reprocessada com sucesso!\n');

        // Pequeno delay para não sobrecarregar
        await new Promise(r => setTimeout(r, 500));

      } catch (err) {
        console.log(`   ❌ Erro ao reprocessar: ${err.message}\n`);
      }
    }

    console.log('═══════════════════════════════════════════════');
    console.log(`✅ Concluído!`);
    console.log(`📊 Mensagens encontradas: ${mensagensEncontradas}`);
    console.log(`📊 Mensagens reprocessadas: ${mensagensReprocessadas}`);
    console.log('═══════════════════════════════════════════════');

    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('❌ Erro:', err.message);
    process.exit(1);
  }
}

// Confirma antes de executar
console.log('🚨 ISSO VAI REPROCESSAR TODAS AS MENSAGENS DOS ÚLTIMOS 7 DIAS!');
console.log('As mensagens serão reenviadas para a fila de processamento.\n');

recuperarMensagens();
