/**
 * E2E V2 - Worker Integration Test
 * 
 * Testa o fluxo completo: evento → fila → worker → projeção
 * Este é o único teste que depende do worker rodando (verifica integração real)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { Queue } from 'bullmq';
import Patient from '../../../models/Patient.js';
import { publishEvent } from '../../../infrastructure/events/eventPublisher.js';
import { buildPatientView } from '../../../domains/clinical/services/patientProjectionService.js';
import { redisConnection } from '../../../infrastructure/queue/queueConfig.js';

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';

describe('🔌 V2 Worker Integration', () => {
  let patientProjectionQueue;
  
  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    
    // Conecta na fila de projeção
    patientProjectionQueue = new Queue('patient-projection', { 
      connection: redisConnection 
    });
    
    console.log('✅ Conectado ao Atlas e Redis');
  });

  afterAll(async () => {
    await patientProjectionQueue.close();
    await mongoose.disconnect();
    console.log('✅ Desconectado');
  });

  it('Evento publicado chega na fila correta', async () => {
    const patient = await Patient.create({
      fullName: 'Worker Integration Test',
      email: `worker_${Date.now()}@test.com`,
      phone: '11999999999',
      dateOfBirth: new Date('1990-01-01')
    });

    // Publica evento
    const result = await publishEvent('PATIENT_CREATED', {
      patientId: patient._id.toString(),
      fullName: patient.fullName,
      email: patient.email
    });

    // Verifica que foi para a fila correta
    expect(result.queues).toContain('patient-projection');
    expect(result.jobs.length).toBeGreaterThan(0);
    expect(result.jobs[0].queue).toBe('patient-projection');

    // Verifica que o job existe na fila (não necessariamente processado)
    const job = await patientProjectionQueue.getJob(result.jobs[0].jobId);
    expect(job).toBeTruthy();
    expect(job.data.eventType).toBe('PATIENT_CREATED');
    expect(job.data.payload.patientId).toBe(patient._id.toString());

    // Limpa
    await Patient.deleteOne({ _id: patient._id });
    await mongoose.connection.db.collection('patients_view')
      .deleteOne({ patientId: patient._id });
    
    // Remove job da fila
    if (job) await job.remove();
  }, 15000);

  it('Payload é serializado/deserializado corretamente', async () => {
    const patient = await Patient.create({
      fullName: 'Serialization Test',
      email: `serial_${Date.now()}@test.com`,
      phone: '11888888888',
      dateOfBirth: new Date('1985-03-15')
    });

    const payload = {
      patientId: patient._id.toString(),
      fullName: patient.fullName,
      email: patient.email,
      nested: {
        phone: patient.phone,
        dateOfBirth: patient.dateOfBirth.toISOString()
      }
    };

    // Publica
    const result = await publishEvent('PATIENT_CREATED', payload);

    // Recupera job da fila
    const job = await patientProjectionQueue.getJob(result.jobs[0].jobId);
    
    // Verifica que payload foi preservado corretamente
    expect(job.data.payload.fullName).toBe(payload.fullName);
    expect(job.data.payload.nested.phone).toBe(payload.nested.phone);
    expect(job.data.payload.patientId).toBe(payload.patientId);

    // Limpa
    await Patient.deleteOne({ _id: patient._id });
    if (job) await job.remove();
  }, 15000);

  it('Fila tem configuração de retry correta', async () => {
    const patient = await Patient.create({
      fullName: 'Retry Config Test',
      email: `retry_${Date.now()}@test.com`,
      phone: '11777777777',
      dateOfBirth: new Date('1990-01-01')
    });

    const result = await publishEvent('PATIENT_CREATED', {
      patientId: patient._id.toString(),
      fullName: patient.fullName
    });

    const job = await patientProjectionQueue.getJob(result.jobs[0].jobId);
    
    // Verifica configurações do job
    expect(job.opts.attempts).toBe(5);
    expect(job.opts.backoff).toBeDefined();
    expect(job.opts.backoff.type).toBe('exponential');

    // Limpa
    await Patient.deleteOne({ _id: patient._id });
    if (job) await job.remove();
  }, 15000);

  it('End-to-end: evento → fila → projeção manual (simula worker)', async () => {
    const patient = await Patient.create({
      fullName: 'End-to-End Test',
      email: `e2e_${Date.now()}@test.com`,
      phone: '11666666666',
      dateOfBirth: new Date('1992-07-20')
    });

    // 1. Publica evento
    const result = await publishEvent('PATIENT_CREATED', {
      patientId: patient._id.toString(),
      fullName: patient.fullName,
      email: patient.email
    });

    // 2. Verifica na fila
    const job = await patientProjectionQueue.getJob(result.jobs[0].jobId);
    expect(job).toBeTruthy();

    // 3. Processa como o worker faria
    const projectionResult = await buildPatientView(
      job.data.payload.patientId,
      { correlationId: job.data.correlationId }
    );

    // 4. Verifica projeção
    expect(projectionResult).toBeTruthy();
    expect(projectionResult.fullName).toBe(patient.fullName);

    // 5. Verifica no banco
    const view = await mongoose.connection.db.collection('patients_view')
      .findOne({ patientId: patient._id });
    
    expect(view).toBeTruthy();
    expect(view.fullName).toBe(patient.fullName);
    expect(view.email).toBe(patient.email);

    console.log('✅ End-to-end completo:', {
      eventId: result.eventId,
      jobId: job.id,
      viewCreated: !!view,
      viewVersion: view.snapshot?.version
    });

    // Limpa
    await Patient.deleteOne({ _id: patient._id });
    await mongoose.connection.db.collection('patients_view')
      .deleteOne({ patientId: patient._id });
    if (job) await job.remove();
  }, 20000);
});
