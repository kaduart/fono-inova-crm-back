// tests/scenarios/duplicate-event.scenario.js
// Cenário: Evento duplicado (simula retry de worker ou network glitch)

import mongoose from 'mongoose';
import { Queue } from 'bullmq';
import { redisConnection } from '../../infrastructure/queue/queueConfig.js';
import { publishEvent, EventTypes } from '../../infrastructure/events/eventPublisher.js';

export default {
  name: 'Duplicate Event - Worker retry não duplica dados',
  
  async setup(ctx) {
    const { fixtures } = ctx;
    
    const doctor = await fixtures.doctor();
    const patient = await fixtures.patient();
    const pkg = await fixtures.package(
      { patient, doctor },
      { paymentType: 'per-session' }
    );
    const appointment = await fixtures.appointment(
      { patient, doctor, package: pkg },
      { clinicalStatus: 'completed', operationalStatus: 'confirmed' }
    );
    
    // Conecta na fila
    const queue = new Queue('invoice-processing', { connection: redisConnection });
    
    return { doctor, patient, pkg, appointment, queue };
  },
  
  async execute({ data }) {
    const { appointment, patient, queue } = data;
    
    // PUBLICA O MESMO EVENTO 3x (simula retry ou duplicidade de rede)
    // Usa INVOICE_PER_SESSION_CREATE (comando) não INVOICE_CREATED (resultado)
    const eventPayload = {
      patientId: patient._id.toString(),
      appointmentId: appointment._id.toString(),
      sessionValue: 200
    };
    
    console.log('  📤 Publicando evento INVOICE_PER_SESSION_CREATE 3x (simulando duplicidade)...');
    
    await publishEvent(EventTypes.INVOICE_PER_SESSION_CREATE, eventPayload);
    await publishEvent(EventTypes.INVOICE_PER_SESSION_CREATE, eventPayload);  // Mesmo payload!
    await publishEvent(EventTypes.INVOICE_PER_SESSION_CREATE, eventPayload);  // Mesmo payload!
    
    return { eventPayload };
  },
  
  async assert({ data, runner }) {
    const { patient, appointment } = data;
    
    // Aguarda processamento
    await runner.sleep(2000);
    
    // 1. Deve ter APENAS 1 invoice (idempotência do worker)
    const invoiceCount = await mongoose.connection.db
      .collection('invoices')
      .countDocuments({ patient: patient._id });
    
    if (invoiceCount > 1) {
      throw new Error(`
        🔥 EVENTO DUPLICADO NÃO FOI TRATADO!
        ${invoiceCount} invoices criadas (esperado: 1)
        O worker não é idempotente!
      `);
    }
    
    if (invoiceCount === 0) {
      throw new Error('Nenhuma invoice criada!');
    }
    
    console.log(`  ✅ Apenas 1 invoice criada (idempotência OK)`);
    
    // 2. No outbox, deve ter 3 eventos (não é problema)
    // Mas apenas 1 foi processado com sucesso
    const outboxEvents = await mongoose.connection.db
      .collection('outboxevents')
      .find({
        eventType: 'INVOICE_PER_SESSION_CREATE',
        'payload.patientId': patient._id.toString()
      })
      .toArray();
    
    console.log(`  📊 Eventos no outbox: ${outboxEvents.length}`);
    
    const processedEvents = outboxEvents.filter(e => e.status === 'processed');
    console.log(`  ✅ Eventos processados: ${processedEvents.length}`);
    
    // 3. Se o sistema for perfeito, apenas 1 evento gera invoice
    // Os outros devem ser ignorados (idempotency key)
    
    // Verifica se o worker usou idempotency key corretamente
    const uniqueProcessed = new Set(processedEvents.map(e => e.idempotencyKey)).size;
    
    if (uniqueProcessed !== 1 && processedEvents.length > 1) {
      console.warn('  ⚠️  Múltiplos eventos processados - verificar idempotency key');
    }
  },
  
  async cleanup({ data, fixtures }) {
    const { queue } = data;
    await queue.close();
    await fixtures.cleanup();
  }
};
