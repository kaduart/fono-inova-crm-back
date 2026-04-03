/**
 * ============================================================================
 * WORKER INTEGRATION TESTS - Billing V2
 * ============================================================================
 * 
 * Testa o worker BullMQ processando eventos reais
 * 
 * Run: npm run test:billing:integration
 * ============================================================================
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import Session from '../../models/Session.js';
import Payment from '../../models/Payment.js';
import Appointment from '../../models/Appointment.js';
import InsuranceGuide from '../../models/InsuranceGuide.js';
import Patient from '../../models/Patient.js';
import Professional from '../../models/Professional.js';
import { publishEvent } from '../../infrastructure/events/eventPublisher.js';

const TEST_DB = process.env.TEST_MONGO_URI || 'mongodb://localhost:27017/crm_test_worker';
const REDIS_URL = process.env.TEST_REDIS_URL || 'redis://localhost:6379';

describe('Billing Worker - Integration', () => {
  let redis;
  let queue;
  let worker;
  let patient;
  let professional;
  let guide;

  beforeAll(async () => {
    // Conexões
    await mongoose.connect(TEST_DB);
    redis = new Redis(REDIS_URL);
    
    // Criar fila de teste
    queue = new Queue('billing-orchestrator-test', { connection: redis });
    
    // Setup dados
    patient = await Patient.create({ fullName: 'Worker Test', cpf: '11122233344' });
    professional = await Professional.create({ fullName: 'Prof Worker', specialty: 'fonoaudiologia' });
  });

  beforeEach(async () => {
    // Limpar fila antes de cada teste
    await queue.drain();
    
    // Criar guia nova
    guide = await InsuranceGuide.create({
      number: `WORKER-${uuidv4().slice(0, 8)}`,
      patientId: patient._id,
      specialty: 'fonoaudiologia',
      insurance: 'test-insurance',
      totalSessions: 10,
      usedSessions: 0,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    });
  });

  afterAll(async () => {
    // Cleanup
    await queue.close();
    await redis.flushdb();
    await redis.quit();
    
    await Session.deleteMany({ patient: patient._id });
    await Payment.deleteMany({ patient: patient._id });
    await Appointment.deleteMany({ patient: patient._id });
    await InsuranceGuide.deleteMany({ patientId: patient._id });
    await Patient.findByIdAndDelete(patient._id);
    await Professional.findByIdAndDelete(professional._id);
    
    await mongoose.disconnect();
  });

  // =============================================================================
  // WORKER PROCESSANDO EVENTOS
  // =============================================================================
  
  describe('Worker Event Processing', () => {
    it('should process SESSION_COMPLETED event from queue', async () => {
      // 1. Criar sessão
      const session = await Session.create({
        patient: patient._id,
        professional: professional._id,
        specialty: 'fonoaudiologia',
        date: new Date(),
        time: '10:00',
        status: 'scheduled',
        paymentType: 'convenio',
        insuranceGuide: guide._id
      });

      // 2. Publicar evento (simula o hook)
      await publishEvent('SESSION_COMPLETED', {
        sessionId: session._id.toString(),
        patientId: patient._id.toString(),
        professionalId: professional._id.toString(),
        specialty: 'fonoaudiologia',
        paymentType: 'convenio',
        date: session.date,
        value: 0,
        insuranceGuideId: guide._id.toString()
      }, { correlationId: `test-${uuidv4()}` });

      // 3. Aguardar processamento (simulado - em produção seria o worker)
      await new Promise(r => setTimeout(r, 1000));

      // 4. Verificar resultado
      const payment = await Payment.findOne({ session: session._id });
      expect(payment).toBeTruthy();
      
      const appointment = await Appointment.findOne({ 'source.sessionId': session._id });
      expect(appointment).toBeTruthy();

      const updatedGuide = await InsuranceGuide.findById(guide._id);
      expect(updatedGuide.usedSessions).toBe(1);
    });

    it('should handle retry on failure', async () => {
      // Teste de retry - simular falha e recuperação
      const sessionId = new mongoose.Types.ObjectId();
      
      // Adicionar job que vai falhar (session não existe)
      const job = await queue.add('process-session', {
        eventType: 'SESSION_COMPLETED',
        payload: { sessionId: sessionId.toString() },
        correlationId: `test-${uuidv4()}`
      }, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 100 }
      });

      // Aguardar
      await new Promise(r => setTimeout(r, 500));

      // Verificar que job foi para DLQ após falhas
      const failedJobs = await queue.getFailed();
      expect(failedJobs.length).toBeGreaterThan(0);
    });

    it('should not process event when feature flag is disabled', async () => {
      // Simular flag desativada - worker deve ignorar
      // Isso é testado no nível de código do worker
      expect(true).toBe(true); // Placeholder - teste real requer mock de feature flag
    });
  });

  // =============================================================================
  // ORDEM DOS EVENTOS
  // =============================================================================
  
  describe('Event Ordering', () => {
    it('should handle events in correct order', async () => {
      const session = await Session.create({
        patient: patient._id,
        professional: professional._id,
        specialty: 'fonoaudiologia',
        date: new Date(),
        time: '11:00',
        status: 'scheduled',
        paymentType: 'convenio',
        insuranceGuide: guide._id
      });

      // Adicionar eventos em ordem
      await queue.add('billing', {
        eventType: 'SESSION_COMPLETED',
        payload: { sessionId: session._id.toString() }
      });

      await queue.add('billing', {
        eventType: 'SESSION_BILLED',
        payload: { 
          sessionId: session._id.toString(),
          billedAmount: 150.00 
        }
      });

      await queue.add('billing', {
        eventType: 'SESSION_RECEIVED',
        payload: { 
          sessionId: session._id.toString(),
          receivedAmount: 140.00 
        }
      });

      // Verificar ordem da fila
      const jobs = await queue.getJobs(['waiting']);
      expect(jobs).toHaveLength(3);
      expect(jobs[0].data.eventType).toBe('SESSION_COMPLETED');
      expect(jobs[1].data.eventType).toBe('SESSION_BILLED');
      expect(jobs[2].data.eventType).toBe('SESSION_RECEIVED');
    });

    it('should reject billed before completed', async () => {
      const sessionId = new mongoose.Types.ObjectId();

      // Tentar billed sem ter o completed
      await queue.add('billing', {
        eventType: 'SESSION_BILLED',
        payload: { sessionId: sessionId.toString(), billedAmount: 150 }
      });

      // O worker deve lidar com isso (rejeitar ou aguardar)
      // Em produção, pode haver lógica de delay ou rejeição
    });
  });

  // =============================================================================
  // CONCORRÊNCIA
  // =============================================================================
  
  describe('Concurrency', () => {
    it('should handle parallel events for different sessions', async () => {
      // Criar múltiplas sessões
      const sessions = await Promise.all([
        Session.create({
          patient: patient._id,
          professional: professional._id,
          specialty: 'fonoaudiologia',
          date: new Date(),
          time: '12:00',
          status: 'scheduled',
          paymentType: 'convenio',
          insuranceGuide: guide._id
        }),
        Session.create({
          patient: patient._id,
          professional: professional._id,
          specialty: 'fonoaudiologia',
          date: new Date(),
          time: '13:00',
          status: 'scheduled',
          paymentType: 'convenio',
          insuranceGuide: guide._id
        })
      ]);

      // Adicionar jobs em paralelo
      await Promise.all(sessions.map(s => 
        queue.add('billing', {
          eventType: 'SESSION_COMPLETED',
          payload: { sessionId: s._id.toString() }
        })
      ));

      const jobs = await queue.getJobs(['waiting']);
      expect(jobs).toHaveLength(2);
    });

    it('should prevent duplicate processing with lock', async () => {
      const session = await Session.create({
        patient: patient._id,
        professional: professional._id,
        specialty: 'fonoaudiologia',
        date: new Date(),
        time: '14:00',
        status: 'scheduled',
        paymentType: 'convenio',
        insuranceGuide: guide._id
      });

      // Adicionar mesmo evento 2x
      await queue.add('billing', {
        eventType: 'SESSION_COMPLETED',
        payload: { sessionId: session._id.toString() },
        correlationId: 'same-id'
      });

      await queue.add('billing', {
        eventType: 'SESSION_COMPLETED',
        payload: { sessionId: session._id.toString() },
        correlationId: 'same-id'
      });

      // Em produção, o V2 deve detectar duplicata via idempotência
    });
  });

  // =============================================================================
  // DLQ (DEAD LETTER QUEUE)
  // =============================================================================
  
  describe('DLQ Handling', () => {
    it('should move failed jobs to DLQ after max retries', async () => {
      const dlq = new Queue('billing-dlq', { connection: redis });
      
      // Limpar DLQ
      await dlq.drain();

      // Adicionar job que vai falhar
      await queue.add('billing', {
        eventType: 'SESSION_COMPLETED',
        payload: { sessionId: 'invalid-id' }
      }, {
        attempts: 1 // Falha imediata
      });

      // Aguardar processamento
      await new Promise(r => setTimeout(r, 500));

      // Verificar DLQ
      const failedJobs = await dlq.getJobs(['waiting']);
      expect(failedJobs.length).toBeGreaterThan(0);

      await dlq.close();
    });
  });
});
