// tests/scenarios/chaos-worker-dies.scenario.js
// CHAOS TEST: Worker morre no meio do processamento

import mongoose from 'mongoose';
import api from '../framework/ApiClient.js';
import { Queue, Worker } from 'bullmq';
import { redisConnection } from '../../infrastructure/queue/queueConfig.js';


export default {
  name: 'CHAOS: Worker morre no meio do processamento',
  
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
    
    // Conecta na fila
    const queue = new Queue('complete-orchestrator', { connection: redisConnection });
    
    return { doctor, patient, pkg, appointment, queue };
  },
  
  async execute({ data }) {
    const { appointment, queue } = data;
    
    console.log('  💀 Iniciando caos: worker vai morrer no meio...');
    
    // 1. Chama complete (cria job)
    const responsePromise = api.patch(
      `/api/v2/appointments/${appointment._id}/complete`,
      {},
      { timeout: 5000 }
    );
    
    // 2. Espera job aparecer na fila
    await new Promise(r => setTimeout(r, 500));
    const jobs = await queue.getJobs(['waiting', 'active']);
    const job = jobs.find(j => 
      j.data.payload?.appointmentId === appointment._id.toString()
    );
    
    if (!job) {
      throw new Error('Job não encontrado na fila');
    }
    
    console.log(`  💣 Matando job ${job.id} no meio do processamento...`);
    
    // 3. MATA O JOB (simula worker crashando)
    await job.discard();
    await job.remove();
    
    console.log('  ☠️  Job removido (simulando worker morto)');
    
    // 4. Recria o job (simula retry automático ou intervenção)
    console.log('  🔄 Recriando job (simulando retry)...');
    const { publishEvent } = await import('../../infrastructure/events/eventPublisher.js');
    
    await publishEvent('APPOINTMENT_COMPLETE_REQUESTED', {
      appointmentId: appointment._id.toString(),
      correlationId: `chaos-retry-${Date.now()}`
    });
    
    return { jobId: job.id };
  },
  
  async assert({ data, runner }) {
    const { appointment, patient } = data;
    
    // Aguarda MUITO tempo (retry + processamento)
    console.log('  ⏳ Aguardando retry e processamento...');
    await runner.sleep(5000);
    
    // 1. Verifica se appointment foi completado (eventual consistency)
    const apt = await mongoose.connection.db
      .collection('appointments')
      .findOne({ _id: appointment._id });
    
    if (apt.clinicalStatus !== 'completed') {
      throw new Error(`
        🔥 CAOS FALHOU: Sistema não se recuperou!
        Appointment ainda está: ${apt.clinicalStatus}
        O retry deveria ter completado!
      `);
    }
    
    console.log('  ✅ Sistema se recuperou! Appointment completed');
    
    // 2. Verifica se invoice foi criada (consistência eventual)
    const invoice = await mongoose.connection.db
      .collection('invoices')
      .findOne({ patient: patient._id });
    
    if (!invoice) {
      throw new Error('Invoice não foi criada após retry!');
    }
    
    console.log('  ✅ Invoice criada após caos');
    
    // 3. Verifica se não duplicou (idempotência no retry)
    const invoiceCount = await mongoose.connection.db
      .collection('invoices')
      .countDocuments({ patient: patient._id });
    
    if (invoiceCount > 1) {
      throw new Error(`Duplicação no caos: ${invoiceCount} invoices`);
    }
    
    console.log('  ✅ Sem duplicação (idempotência funcionou no caos)');
    
    // 4. Package consumiu certo?
    const pkg = await mongoose.connection.db
      .collection('packages')
      .findOne({ _id: data.pkg._id });
    
    if (pkg.sessionsDone !== 1) {
      throw new Error(`Package inconsistente: ${pkg.sessionsDone} sessions`);
    }
    
    console.log('  ✅ Package consistente após caos');
  },
  
  async cleanup({ data, fixtures }) {
    const { queue } = data;
    await queue.close();
    await fixtures.cleanup();
  }
};
