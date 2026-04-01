// tests/scenarios/stress-test.scenario.js
// Cenário: Carga - Múltiplos agendamentos sendo completados simultaneamente

import mongoose from 'mongoose';
import api from '../framework/ApiClient.js';

const CONCURRENT_REQUESTS = 10; // Número de requisições simultâneas

export default {
  name: `Stress Test - ${CONCURRENT_REQUESTS} completes simultâneos`,
  
  async setup(ctx) {
    const { fixtures } = ctx;
    
    const doctor = await fixtures.doctor();
    const patient = await fixtures.patient();
    
    // Pacote com sessões suficientes para todos
    const pkg = await fixtures.package(
      { patient, doctor },
      { 
        paymentType: 'per-session',
        sessionValue: 200,
        totalSessions: CONCURRENT_REQUESTS,
        sessionsDone: 0
      }
    );
    
    // Cria N agendamentos
    const appointments = [];
    for (let i = 0; i < CONCURRENT_REQUESTS; i++) {
      const apt = await fixtures.appointment(
        { patient, doctor, package: pkg },
        { clinicalStatus: 'pending', operationalStatus: 'confirmed' }
      );
      appointments.push(apt);
    }
    
    return { doctor, patient, pkg, appointments };
  },
  
  async execute({ data }) {
    const { appointments } = data;
    
    console.log(`  🚀 Disparando ${CONCURRENT_REQUESTS} requisições simultâneas...`);
    
    const startTime = Date.now();
    
    // Dispara TODOS ao mesmo tempo
    const promises = appointments.map(apt => 
      api.patch(
        `/api/v2/appointments/${apt._id}/complete`,
        {},
        { timeout: 15000 }
      ).catch(err => ({ error: true, message: err.message }))
    );
    
    const results = await Promise.all(promises);
    
    const duration = Date.now() - startTime;
    
    const successCount = results.filter(r => !r.error).length;
    const errorCount = results.filter(r => r.error).length;
    
    console.log(`  ⏱️  Duração: ${duration}ms`);
    console.log(`  ✅ Sucessos: ${successCount}`);
    console.log(`  ❌ Erros: ${errorCount}`);
    
    return { results, duration, successCount, errorCount };
  },
  
  async assert({ data, runner }) {
    const { pkg, patient, appointments } = data;
    
    // Aguarda processamento (pode demorar com muitos jobs)
    await runner.sleep(5000);
    
    // 1. Package deve ter todas as sessões consumidas
    const packageUpdated = await mongoose.connection.db
      .collection('packages')
      .findOne({ _id: pkg._id });
    
    console.log(`  📊 sessionsDone: ${packageUpdated.sessionsDone}/${CONCURRENT_REQUESTS}`);
    
    if (packageUpdated.sessionsDone !== CONCURRENT_REQUESTS) {
      throw new Error(`
        Sessões não batem!
        Esperado: ${CONCURRENT_REQUESTS}
        Obtido: ${packageUpdated.sessionsDone}
      `);
    }
    
    // 2. Deve ter exatamente N invoices
    const invoiceCount = await mongoose.connection.db
      .collection('invoices')
      .countDocuments({ patient: patient._id });
    
    console.log(`  📊 invoices: ${invoiceCount}/${CONCURRENT_REQUESTS}`);
    
    if (invoiceCount !== CONCURRENT_REQUESTS) {
      throw new Error(`
        Invoices não batem!
        Esperado: ${CONCURRENT_REQUESTS}
        Obtido: ${invoiceCount}
      `);
    }
    
    // 3. Todos os appointments devem estar completed
    const completedCount = await mongoose.connection.db
      .collection('appointments')
      .countDocuments({
        _id: { $in: appointments.map(a => a._id) },
        clinicalStatus: 'completed'
      });
    
    console.log(`  📊 completed: ${completedCount}/${CONCURRENT_REQUESTS}`);
    
    if (completedCount !== CONCURRENT_REQUESTS) {
      throw new Error(`
        Nem todos foram completados!
        Esperado: ${CONCURRENT_REQUESTS}
        Obtido: ${completedCount}
      `);
    }
    
    // 4. Valida performance (deve responder em tempo razoável)
    // Ajuste conforme necessário
    // if (duration > 30000) {
    //   console.warn(`  ⚠️  Performance: ${duration}ms (limite: 30000ms)`);
    // }
    
    console.log('  ✅ Stress test passou!');
  },
  
  async cleanup({ fixtures }) {
    await fixtures.cleanup();
  }
};
