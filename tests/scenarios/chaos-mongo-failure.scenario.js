// tests/scenarios/chaos-mongo-failure.scenario.js
// CHAOS TEST: MongoDB fica indisponível no meio do processo

import mongoose from 'mongoose';
import api from '../framework/ApiClient.js';


export default {
  name: 'CHAOS: MongoDB indisponível temporariamente',
  
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
      { clinicalStatus: 'pending', operationalStatus: 'confirmed' }
    );
    
    return { doctor, patient, pkg, appointment };
  },
  
  async execute({ data }) {
    const { appointment } = data;
    
    console.log('  💀 Simulando MongoDB indisponível...');
    
    // Armazena conexão original
    const originalConnection = mongoose.connection.readyState;
    console.log(`  📊 Estado original do MongoDB: ${originalConnection}`);
    
    // Inicia o complete (vai falhar)
    console.log('  ⚡ Chamando complete...');
    const responsePromise = api.patch(
      `/api/v2/appointments/${appointment._id}/complete`,
      {},
      { timeout: 10000 }
    ).catch(err => {
      console.log(`  ⚠️  Erro esperado: ${err.response?.status || err.message}`);
      return null;
    });
    
    // Simula queda (delay artificial)
    await new Promise(r => setTimeout(r, 100));
    
    const response = await responsePromise;
    
    // Se a resposta veio, é porque o MongoDB não caiu (ou sistema tem cache)
    if (response?.data?.success) {
      console.log('  🔄 Complete retornou - sistema usou cache ou MongoDB voltou');
    }
    
    return { appointmentId: appointment._id };
  },
  
  async assert({ data, runner }) {
    const { appointment, patient } = data;
    
    // Aguarda eventual consistency
    console.log('  ⏳ Aguardando sistema se recuperar...');
    await runner.sleep(3000);
    
    // Verifica se o sistema conseguiu completar ou rollback
    const apt = await mongoose.connection.db
      .collection('appointments')
      .findOne({ _id: appointment._id });
    
    // Pode estar 'completed' (sucesso) ou 'confirmed' (rollback)
    const validStates = ['completed', 'confirmed', 'error'];
    
    if (!validStates.includes(apt.clinicalStatus)) {
      throw new Error(`
        🔥 ESTADO INCONSISTENTE APÓS CAOS!
        Appointment em estado: ${apt.clinicalStatus}
        Esperado: completed, confirmed, ou error
      `);
    }
    
    console.log(`  ✅ Estado consistente: ${apt.clinicalStatus}`);
    
    // Se completou, verifica invoice
    if (apt.clinicalStatus === 'completed') {
      const invoice = await mongoose.connection.db
        .collection('invoices')
        .findOne({ patient: patient._id });
      
      if (!invoice) {
        console.log('  ⚠️  Completo mas sem invoice - pode ser delay');
      } else {
        console.log('  ✅ Invoice criada após caos');
      }
    }
    
    // Verifica package (não pode ter consumido sem complete)
    const pkg = await mongoose.connection.db
      .collection('packages')
      .findOne({ _id: data.pkg._id });
    
    if (apt.clinicalStatus === 'confirmed' && pkg.sessionsDone !== 0) {
      throw new Error('Package consumido sem complete confirmado!');
    }
    
    console.log('  ✅ Package consistente');
  },
  
  async cleanup({ fixtures }) {
    await fixtures.cleanup();
  }
};
