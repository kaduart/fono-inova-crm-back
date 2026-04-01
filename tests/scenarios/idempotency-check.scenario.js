// tests/scenarios/idempotency-check.scenario.js
// Cenário: Valida idempotência (mesma operação 2x não duplica)

import mongoose from 'mongoose';
import api from '../framework/ApiClient.js';

export default {
  name: 'Idempotência - Complete chamado 2x',
  
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
      { clinicalStatus: 'pending' }
    );
    
    return { doctor, patient, pkg, appointment };
  },
  
  async execute({ data }) {
    const { appointment } = data;
    
    // CHAMA 2x O MESMO ENDPOINT (simula duplo clique/retry)
    const promise1 = api.patch(
      `/api/v2/appointments/${appointment._id}/complete`,
      {},
      { timeout: 5000 }
    );
    
    const promise2 = api.patch(
      `/api/v2/appointments/${appointment._id}/complete`,
      {},
      { timeout: 5000 }
    );
    
    // Aguarda ambas (uma vai dar idempotent, outra success)
    const results = await Promise.allSettled([promise1, promise2]);
    
    return { results };
  },
  
  async assert({ data, runner }) {
    const { patient, appointment } = data;
    
    // Aguarda processamento
    await runner.sleep(2000);
    
    // 🔥 VALIDAÇÃO CRÍTICA: Não duplicou invoice
    await runner.assertIdempotency('invoices', { patient: patient._id }, 1);
    
    // 🔥 VALIDAÇÃO CRÍTICA: Não duplicou payment
    await runner.assertIdempotency('payments', { appointment: appointment._id }, 1);
    
    // 🔥 VALIDAÇÃO CRÍTICA: Não duplicou evento
    const events = await mongoose.connection.db
      .collection('outboxevents')
      .countDocuments({ 
        eventType: 'INVOICE_CREATED',
        'payload.patientId': patient._id.toString()
      });
    
    if (events > 1) {
      throw new Error(`Evento duplicado: ${events} eventos INVOICE_CREATED`);
    }
    
    // Valida que appointment está completed (não em estado inconsistente)
    await runner.assertDatabase('appointments',
      { _id: appointment._id },
      { clinicalStatus: 'completed' }
    );
  },
  
  async cleanup({ fixtures }) {
    await fixtures.cleanup();
  }
};
