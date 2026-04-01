// tests/scenarios/chaos-partial-commit.scenario.js
// CHAOS TEST: Commit parcial (crash no meio do processamento)

import mongoose from 'mongoose';
import api from '../framework/ApiClient.js';
import { Queue } from 'bullmq';
import { redisConnection } from '../../infrastructure/queue/queueConfig.js';


export default {
  name: 'CHAOS: Partial commit (crash após payment, antes de invoice)',
  
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
    
    const queue = new Queue('complete-orchestrator', { connection: redisConnection });
    
    return { doctor, patient, pkg, appointment, queue };
  },
  
  async execute({ data }) {
    const { appointment, queue } = data;
    
    console.log('  💀 Simulando crash após payment, antes de invoice...');
    
    // Inicia complete
    const response = await api.patch(
      `/api/v2/appointments/${appointment._id}/complete`,
      {},
      { timeout: 10000 }
    );
    
    if (!response.data.success) {
      throw new Error('Complete falhou inicialmente');
    }
    
    console.log('  ✅ Complete iniciado');
    
    // Espera um pouco para o worker começar
    await new Promise(r => setTimeout(r, 2000));
    
    // Pausa a fila (simula crash do worker)
    console.log('  ⏸️  Pausando fila (simulando crash)...');
    await queue.pause();
    
    // Limpa a fila (remove jobs pendentes)
    const waitingJobs = await queue.getWaiting();
    console.log(`  🗑️  Removendo ${waitingJobs.length} jobs pendentes`);
    
    for (const job of waitingJobs) {
      await job.remove();
    }
    
    // Aguarda um pouco
    await new Promise(r => setTimeout(r, 1000));
    
    // Resume a fila
    console.log('  ▶️  Resumindo fila...');
    await queue.resume();
    
    // Recria o evento (simula retry)
    console.log('  🔄 Recriando evento...');
    const { publishEvent } = await import('../../infrastructure/events/eventPublisher.js');
    
    await publishEvent('APPOINTMENT_COMPLETE_REQUESTED', {
      appointmentId: appointment._id.toString(),
      correlationId: `chaos-partial-${Date.now()}`
    });
    
    return { appointmentId: appointment._id };
  },
  
  async assert({ data, runner }) {
    const { appointment, patient, pkg } = data;
    
    console.log('  ⏳ Aguardando recuperação...');
    await runner.sleep(5000);
    
    // Verifica estado final
    const apt = await mongoose.connection.db
      .collection('appointments')
      .findOne({ _id: appointment._id });
    
    if (apt.clinicalStatus !== 'completed') {
      throw new Error(`
        🔥 RECUPERAÇÃO FALHOU!
        Appointment: ${apt.clinicalStatus}
        Deveria estar: completed
      `);
    }
    
    console.log('  ✅ Appointment completado após recuperação');
    
    // Verifica payment
    const payments = await mongoose.connection.db
      .collection('payments')
      .find({ 
        $or: [
          { appointment: appointment._id },
          { 'metadata.appointmentId': appointment._id.toString() }
        ]
      })
      .toArray();
    
    console.log(`  📊 Payments encontrados: ${payments.length}`);
    
    if (payments.length === 0) {
      throw new Error('Nenhum payment encontrado!');
    }
    
    // Verifica invoices
    const invoices = await mongoose.connection.db
      .collection('invoices')
      .find({ patient: patient._id })
      .toArray();
    
    console.log(`  📊 Invoices: ${invoices.length}`);
    
    if (invoices.length === 0) {
      throw new Error('Nenhuma invoice após recuperação!');
    }
    
    if (invoices.length > 1) {
      throw new Error(`
        🔥 DUPLICAÇÃO NO CHAOS!
        ${invoices.length} invoices para o mesmo paciente
      `);
    }
    
    console.log('  ✅ Invoice única (idempotência)');
    
    // Verifica package
    const updatedPkg = await mongoose.connection.db
      .collection('packages')
      .findOne({ _id: pkg._id });
    
    if (updatedPkg.sessionsDone !== 1) {
      throw new Error(`
        🔥 PACKAGE INCONSISTENTE!
        Sessions done: ${updatedPkg.sessionsDone}
        Esperado: 1
      `);
    }
    
    console.log('  ✅ Package consistente');
    
    // Verifica se payment está vinculado à invoice
    const invoice = invoices[0];
    const paymentIds = payments.map(p => p._id.toString());
    const linkedPayments = invoice.payments.map(p => p.toString());
    
    const allLinked = paymentIds.every(pid => linkedPayments.includes(pid));
    
    if (!allLinked) {
      console.log('  ⚠️  Nem todos os payments vinculados à invoice');
    } else {
      console.log('  ✅ Todos payments vinculados');
    }
  },
  
  async cleanup({ data, fixtures }) {
    const { queue } = data;
    await queue.resume().catch(() => {});
    await queue.close();
    await fixtures.cleanup();
  }
};
