// tests/scenarios/concurrency-race.scenario.js
// Cenário CRÍTICO: Race condition - 2 completes simultâneos no mesmo pacote

import mongoose from 'mongoose';
import api from '../framework/ApiClient.js';


export default {
  name: 'Race Condition - 2 completes simultâneos',
  
  async setup(ctx) {
    const { fixtures } = ctx;
    
    const doctor = await fixtures.doctor();
    const patient = await fixtures.patient();
    
    // Pacote com apenas 1 sessão disponível (força contenção)
    const pkg = await fixtures.package(
      { patient, doctor },
      { 
        paymentType: 'per-session',
        sessionValue: 200,
        totalSessions: 1,
        sessionsDone: 0,
        sessionsAvailable: 1  // Só 1 sessão!
      }
    );
    
    // Cria 2 agendamentos para o MESMO pacote
    const appointment1 = await fixtures.appointment(
      { patient, doctor, package: pkg },
      { clinicalStatus: 'pending', operationalStatus: 'confirmed' }
    );
    
    const appointment2 = await fixtures.appointment(
      { patient, doctor, package: pkg },
      { clinicalStatus: 'pending', operationalStatus: 'confirmed' }
    );
    
    return { doctor, patient, pkg, appointment1, appointment2 };
  },
  
  async execute({ data }) {
    const { appointment1, appointment2 } = data;
    
    // DISPARA 2 COMPLETES SIMULTÂNEOS (race condition)
    const promise1 = api.patch(
      `/api/v2/appointments/${appointment1._id}/complete`,
      {},
      { timeout: 10000 }
    );
    
    const promise2 = api.patch(
      `/api/v2/appointments/${appointment2._id}/complete`,
      {},
      { timeout: 10000 }
    );
    
    // Aguarda ambos (um vai suceder, outro vai falhar ou ser idempotente)
    const results = await Promise.allSettled([promise1, promise2]);
    
    return { results };
  },
  
  async assert({ data, runner }) {
    const { pkg, appointment1, appointment2, patient } = data;
    
    // Aguarda processamento (pode demorar mais por conta do lock)
    await runner.sleep(3000);
    
    // 1. Package deve ter exatamente 1 sessão consumida (não 2!)
    const packageUpdated = await mongoose.connection.db
      .collection('packages')
      .findOne({ _id: pkg._id });
    
    if (packageUpdated.sessionsDone > 1) {
      throw new Error(`
        🔥 RACE CONDITION DETECTADA!
        sessionsDone: ${packageUpdated.sessionsDone} (esperado: 1)
        O pacote consumiu mais sessões do que deveria!
      `);
    }
    
    console.log(`  ✅ sessionsDone: ${packageUpdated.sessionsDone} (correto)`);
    
    // 2. Deve ter exatamente 1 invoice (não 2!)
    const invoiceCount = await mongoose.connection.db
      .collection('invoices')
      .countDocuments({ patient: patient._id });
    
    if (invoiceCount > 1) {
      throw new Error(`
        🔥 DUPLICAÇÃO DETECTADA!
        ${invoiceCount} invoices criadas (esperado: 1)
      `);
    }
    
    console.log(`  ✅ invoices: ${invoiceCount} (correto)`);
    
    // 3. Um appointment deve estar completed, outro...?
    // Pode estar: completed (se foi o primeiro) ou ainda scheduled (se foi bloqueado)
    const apt1 = await mongoose.connection.db
      .collection('appointments')
      .findOne({ _id: appointment1._id });
    const apt2 = await mongoose.connection.db
      .collection('appointments')
      .findOne({ _id: appointment2._id });
    
    const completedCount = [apt1, apt2].filter(a => a.clinicalStatus === 'completed').length;
    
    if (completedCount === 0) {
      throw new Error('Nenhum appointment foi completado!');
    }
    
    if (completedCount > 1 && packageUpdated.sessionsAvailable < 0) {
      throw new Error('Race condition: ambos completaram sem verificar saldo!');
    }
    
    console.log(`  ✅ completed appointments: ${completedCount}`);
    
    // 4. Eventos: deve ter 1 INVOICE_CREATED (não 2)
    const invoiceEvents = await mongoose.connection.db
      .collection('outboxevents')
      .countDocuments({
        eventType: 'INVOICE_CREATED',
        'payload.patientId': patient._id.toString()
      });
    
    if (invoiceEvents > 1) {
      throw new Error(`Evento duplicado: ${invoiceEvents} INVOICE_CREATED`);
    }
    
    console.log(`  ✅ invoice events: ${invoiceEvents}`);
  },
  
  async cleanup({ fixtures }) {
    await fixtures.cleanup();
  }
};
