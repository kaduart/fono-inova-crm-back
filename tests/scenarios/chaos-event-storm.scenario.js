// tests/scenarios/chaos-event-storm.scenario.js
// CHAOS TEST: Storm de eventos (100+ simultâneos)

import mongoose from 'mongoose';
import api from '../framework/ApiClient.js';

const CONCURRENT_REQUESTS = 100;

export default {
  name: `CHAOS: Event Storm (${CONCURRENT_REQUESTS} requests simultâneos)`,
  timeout: 120000, // 2 minutos
  
  async setup(ctx) {
    const { fixtures } = ctx;
    
    // Cria múltiplos pacientes/appointments
    const doctors = await Promise.all(Array(5).fill(0).map(() => fixtures.doctor()));
    const patients = await Promise.all(Array(20).fill(0).map(() => fixtures.patient()));
    
    const appointments = [];
    
    for (let i = 0; i < CONCURRENT_REQUESTS; i++) {
      const patient = patients[i % patients.length];
      const doctor = doctors[i % doctors.length];
      
      const pkg = await fixtures.package(
        { patient, doctor },
        { paymentType: 'per-session' }
      );
      
      const appointment = await fixtures.appointment(
        { patient, doctor, package: pkg },
        { clinicalStatus: 'pending', operationalStatus: 'confirmed' }
      );
      
      appointments.push({
        appointment,
        patient,
        doctor,
        pkg
      });
    }
    
    return { appointments, doctors, patients };
  },
  
  async execute({ data }) {
    const { appointments } = data;
    
    console.log(`  🌩️  Disparando ${CONCURRENT_REQUESTS} completes simultâneos...`);
    console.time('storm');
    
    const startTime = Date.now();
    
    // Dispara TODOS de uma vez
    const promises = appointments.map(({ appointment }, index) => 
      api.patch(
        `/api/v2/appointments/${appointment._id}/complete`,
        {},
        { 
          timeout: 30000,
          headers: { 'X-Storm-Index': index }
        }
      ).then(res => ({ success: true, index, time: Date.now() - startTime }))
       .catch(err => ({ 
         success: false, 
         index, 
         error: err.response?.data?.error || err.message,
         time: Date.now() - startTime 
       }))
    );
    
    const results = await Promise.all(promises);
    
    console.timeEnd('storm');
    
    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;
    
    console.log(`  📊 Sucessos: ${successCount}, Falhas: ${failCount}`);
    
    // Tempo médio
    const avgTime = results.reduce((acc, r) => acc + r.time, 0) / results.length;
    console.log(`  ⏱️  Tempo médio: ${avgTime.toFixed(0)}ms`);
    
    // P95
    const sortedTimes = results.map(r => r.time).sort((a, b) => a - b);
    const p95 = sortedTimes[Math.floor(sortedTimes.length * 0.95)];
    console.log(`  📈 P95: ${p95}ms`);
    
    return { results, successCount, failCount, avgTime, p95 };
  },
  
  async assert({ data, runner }) {
    const { appointments } = data;
    
    console.log('  ⏳ Aguardando processamento da fila...');
    await runner.sleep(10000);
    
    // Verifica consistência de TODOS
    console.log('  🔍 Validando consistência...');
    
    let completedCount = 0;
    let invoiceCount = 0;
    let inconsistent = 0;
    
    for (const { appointment, patient, pkg } of appointments) {
      const apt = await mongoose.connection.db
        .collection('appointments')
        .findOne({ _id: appointment._id });
      
      if (apt.clinicalStatus === 'completed') {
        completedCount++;
        
        // Verifica invoice
        const invoice = await mongoose.connection.db
          .collection('invoices')
          .findOne({ patient: patient._id });
        
        if (invoice) {
          invoiceCount++;
        } else {
          console.log(`  ⚠️  Appointment completed sem invoice`);
        }
        
        // Verifica package
        const updatedPkg = await mongoose.connection.db
          .collection('packages')
          .findOne({ _id: pkg._id });
        
        if (updatedPkg.sessionsDone !== 1) {
          console.log(`  🔥 Package inconsistente: ${updatedPkg.sessionsDone} sessions`);
          inconsistent++;
        }
      }
    }
    
    console.log(`\n  📊 RESULTADO DO STORM:`);
    console.log(`  ✅ Completados: ${completedCount}/${CONCURRENT_REQUESTS}`);
    console.log(`  ✅ Invoices: ${invoiceCount}/${completedCount}`);
    console.log(`  🔥 Inconsistências: ${inconsistent}`);
    
    // Taxa mínima de sucesso: 95%
    const successRate = (completedCount / CONCURRENT_REQUESTS) * 100;
    
    if (successRate < 95) {
      throw new Error(`
        🔥 STORM FALHOU!
        Taxa de sucesso: ${successRate.toFixed(1)}%
        Esperado: >= 95%
      `);
    }
    
    console.log(`  ✅ Taxa de sucesso: ${successRate.toFixed(1)}%`);
    
    // Verifica duplicações
    const pipeline = [
      { $group: { _id: '$patient', count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } }
    ];
    
    const duplicates = await mongoose.connection.db
      .collection('invoices')
      .aggregate(pipeline)
      .toArray();
    
    if (duplicates.length > 0) {
      throw new Error(`
        🔥 DUPLICAÇÃO NO STORM!
        ${duplicates.length} pacientes com invoices duplicadas
      `);
    }
    
    console.log('  ✅ Sem duplicações!');
    
    // Performance
    if (data.result.p95 > 10000) {
      console.log(`  ⚠️  P95 alto: ${data.result.p95}ms`);
    }
  },
  
  async cleanup({ fixtures }) {
    await fixtures.cleanup();
  }
};
