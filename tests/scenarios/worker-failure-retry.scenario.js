// tests/scenarios/worker-failure-retry.scenario.js
// Cenário CRÍTICO: Worker falha, evento fica pendente, retry funciona

import mongoose from 'mongoose';
import api from '../framework/ApiClient.js';
import { Queue } from 'bullmq';
import { redisConnection } from '../../infrastructure/queue/queueConfig.js';


export default {
  name: 'Worker Failure + Retry - Sistema se recupera',
  
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
    
    // Conecta na fila para manipular (simular falha)
    const queue = new Queue('complete-orchestrator', { connection: redisConnection });
    
    return { doctor, patient, pkg, appointment, queue };
  },
  
  async execute({ data }) {
    const { appointment, queue } = data;
    
    // 1. Chama complete
    const response = await api.patch(
      `/api/v2/appointments/${appointment._id}/complete`,
      {},
      { timeout: 5000 }
    );
    
    // 2. SIMULA FALHA: Move job para failed (como se worker tivesse caído)
    const jobs = await queue.getJobs(['waiting', 'active']);
    const job = jobs.find(j => 
      j.data.payload?.appointmentId === appointment._id.toString()
    );
    
    if (job) {
      // Move para failed (simula crash)
      await job.moveToFailed(new Error('Simulated worker crash'), true);
      console.log('  ⚠️  Job movido para failed (simulando falha)');
    }
    
    return { jobId: job?.id, appointmentId: appointment._id };
  },
  
  async assert({ data, runner }) {
    const { appointment, queue } = data;
    
    // 1. VERIFICA: Job está em failed
    const failedJobs = await queue.getFailed();
    const hasFailedJob = failedJobs.some(j => 
      j.data.payload?.appointmentId === appointment._id.toString()
    );
    
    if (!hasFailedJob) {
      throw new Error('Job deveria estar em failed');
    }
    console.log('  ✅ Job está em failed');
    
    // 2. RETRY: Reprocessa job manualmente (simula retry automático)
    const jobToRetry = failedJobs.find(j => 
      j.data.payload?.appointmentId === appointment._id.toString()
    );
    
    if (jobToRetry) {
      await jobToRetry.retry();
      console.log('  🔄 Job reprocessado (retry)');
    }
    
    // 3. Aguarda processamento do retry
    await runner.sleep(3000);
    
    // 4. VALIDA: Agora sim, invoice foi criada
    const invoice = await mongoose.connection.db
      .collection('invoices')
      .findOne({ patient: data.patient._id });
    
    if (!invoice) {
      throw new Error('Invoice não foi criada após retry');
    }
    
    console.log('  ✅ Invoice criada após retry');
    
    // 5. VALIDA: Evento foi processado
    await runner.assertEventEmitted('INVOICE_CREATED', {
      'payload.patientId': data.patient._id.toString()
    });
    
    // 6. VALIDA: Não duplicou (idempotência)
    await runner.assertIdempotency('invoices', { patient: data.patient._id }, 1);
    
    // Limpa fila
    await queue.close();
  },
  
  async cleanup({ data, fixtures }) {
    const { queue } = data;
    
    await queue.close();
    await fixtures.cleanup();
  }
};
