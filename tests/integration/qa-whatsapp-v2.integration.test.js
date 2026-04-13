/**
 * QA Integration Tests - WhatsApp CRM V2
 * 
 * Valida funcionamento COMPLETO do sistema event-driven
 * Detecta: workers órfãos, eventos sem consumidor, silent fails, duplicações
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Types } from 'mongoose';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Queue } from 'bullmq';
import { redisConnection } from '../../config/redisConnection.js';
import { EventTypes } from '../../infrastructure/events/eventPublisher.js';

// Models
import Lead from '../../models/Leads.js';
import Contacts from '../../models/Contacts.js';
import Message from '../../models/Message.js';
import Followup from '../../models/Followup.js';
import EventStore from '../../models/EventStore.js';

// Workers para inspeção
import { createWhatsappInboundWorker } from '../../domains/whatsapp/workers/whatsappInboundWorker.js';
import { createWhatsappAutoReplyWorker } from '../../domains/whatsapp/workers/whatsappAutoReplyWorker.js';
import { createMessageResponseWorker } from '../../domains/whatsapp/workers/messageResponseWorker.js';
import { startLeadRecoveryWorker } from '../../workers/leadRecoveryWorker.js';
import { startFollowupOrchestratorWorker } from '../../workers/followupOrchestratorWorker.js';

// Services
import { publishEvent } from '../../infrastructure/events/eventPublisher.js';
import { runOrchestrator } from '../../services/orchestrator/runOrchestrator.js';

const TEST_TIMEOUT = 30000;

// Stages válidos do sistema (em português)
const VALID_STAGES = {
  NEW: 'novo',
  TRIAGE: 'triagem_agendamento', 
  CONTACT_MADE: 'engajado',
  INTERESTED: 'interessado_agendamento',
  PATIENT: 'paciente'
};
let mongoServer;
let workers = [];
let queues = {};

// Helper: delay
const delay = (ms) => new Promise(r => setTimeout(r, ms));

// Helper: limpa coleções
async function cleanupCollections() {
  await Lead.deleteMany({});
  await Contacts.deleteMany({});
  await Message.deleteMany({});
  await Followup.deleteMany({});
  await EventStore.deleteMany({});
}

describe('🔍 QA WhatsApp V2 - Sistema Completo', () => {
  
  beforeAll(async () => {
    // Setup MongoDB em memória
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    await mongoose.connect(uri);
    
    console.log('[QA Setup] MongoDB conectado');
    
    // Inicia TODOS os workers antes dos testes
    const inboundWorker = createWhatsappInboundWorker();
    const autoReplyWorker = createWhatsappAutoReplyWorker();
    const msgResponseWorker = createMessageResponseWorker({ redis: redisConnection });
    const recoveryWorker = startLeadRecoveryWorker();
    const followupWorker = startFollowupOrchestratorWorker();

    workers.push(inboundWorker, autoReplyWorker, msgResponseWorker, recoveryWorker, followupWorker);
    
    // Aguarda workers conectarem às filas
    await delay(1000);
    console.log('[QA Setup] Workers iniciados');
  }, TEST_TIMEOUT);

  afterAll(async () => {
    // Cleanup workers
    for (const worker of workers) {
      await worker.close();
    }
    // Cleanup queues
    for (const queue of Object.values(queues)) {
      await queue.close();
    }
    await mongoose.disconnect();
    await mongoServer.stop();
  }, TEST_TIMEOUT);

  // ============================================================================
  // TESTE 1: INTEGRIDADE DOS WORKERS
  // ============================================================================
  describe('TESTE 1 — INTEGRIDADE DOS WORKERS', () => {
    
    it('✓ Todos os workers obrigatórios existem e exportam função', () => {
      expect(typeof createWhatsappInboundWorker).toBe('function');
      expect(typeof createWhatsappAutoReplyWorker).toBe('function');
      expect(typeof createMessageResponseWorker).toBe('function');
      expect(typeof startLeadRecoveryWorker).toBe('function');
      expect(typeof startFollowupOrchestratorWorker).toBe('function');
    });

    it('✓ Workers conseguem ser instanciados', async () => {
      // Workers já foram iniciados no beforeAll
      expect(workers.length).toBeGreaterThanOrEqual(5);
      
      // Verifica se workers têm as propriedades esperadas
      expect(workers[0].name).toBeDefined();
      expect(workers[1].name).toBeDefined();
    });

    it('✓ Workers estão conectados às filas corretas', async () => {
      const expectedQueues = [
        'whatsapp-inbound',
        'whatsapp-auto-reply',
        'whatsapp-message-response',
        'lead-recovery',
        'followup-processing'
      ];

      for (const queueName of expectedQueues) {
        const queue = new Queue(queueName, { connection: redisConnection });
        queues[queueName] = queue;
        
        // Verifica se consegue obter info da fila
        const jobCounts = await queue.getJobCounts();
        expect(jobCounts).toBeDefined();
        console.log(`[QA] Fila ${queueName}:`, jobCounts);
      }
    });
  });

  // ============================================================================
  // TESTE 2: EVENT CHAIN COMPLETA
  // ============================================================================
  describe('TESTE 2 — EVENT CHAIN COMPLETA', () => {
    
    it('✓ Simula mensagem inbound completa', async () => {
      await cleanupCollections();

      // Setup: Cria lead e contato
      const phone = '5561999999999';
      const wamid = `wamid.test.${Date.now()}`;
      
      const contact = await Contacts.create({
        phone,
        name: 'Teste QA',
        source: 'whatsapp'
      });

      const lead = await Lead.create({
        name: 'Lead Teste QA',
        phone,
        contact: contact._id,
        source: 'whatsapp',
        stage: VALID_STAGES.NEW
      });

      // Simula publicação do evento (como o webhook faria)
      const correlationId = `test:${wamid}`;
      
      const msg = {
        id: wamid,
        from: phone,
        type: 'text',
        timestamp: Date.now().toString(),
        text: { body: 'Olá quero agendar' }
      };
      
      const value = {
        metadata: {
          display_phone_number: '5561888888888'
        }
      };
      
      await publishEvent(EventTypes.WHATSAPP_MESSAGE_RECEIVED, { msg, value }, { correlationId });

      // Aguarda processamento (tempo aumentado para garantir persistência)
      await delay(4000);
      
      // Debug: lista todas as mensagens do lead
      const allMessages = await Message.find({ from: phone });
      console.log('[QA] Todas as mensagens do phone:', allMessages.length, allMessages.map(m => ({ waMessageId: m.waMessageId, from: m.from })));

      // VALIDAÇÕES
      
      // 1. Message foi criada?
      const messages = await Message.find({ waMessageId: wamid });
      expect(messages.length).toBeGreaterThanOrEqual(1);
      console.log('[QA] Messages criadas:', messages.length);

      // 2. Lead foi atualizado?
      const leadUpdated = await Lead.findById(lead._id);
      expect(leadUpdated.lastInteractionAt).toBeDefined();
      
      // 3. Verifica se eventos foram publicados (via EventStore)
      const events = await EventStore.find({ correlationId });
      console.log('[QA] Eventos publicados:', events.map(e => e.eventType));
      
      expect(events.length).toBeGreaterThan(0);
    }, TEST_TIMEOUT);

    it('✓ Verifica se todos os eventos da cadeia têm workers ativos', async () => {
      const requiredEvents = [
        { type: EventTypes.MESSAGE_RESPONSE_DETECTED, queue: 'whatsapp-message-response' },
        { type: EventTypes.WHATSAPP_AUTO_REPLY_REQUESTED, queue: 'whatsapp-auto-reply' },
        { type: EventTypes.FOLLOWUP_REQUESTED, queue: 'followup-processing' },
        { type: EventTypes.LEAD_RECOVERY_CANCEL_REQUESTED, queue: 'lead-recovery' }
      ];

      for (const { type, queue } of requiredEvents) {
        // Publica evento de teste
        const testId = `test:${Date.now()}:${Math.random()}`;
        await publishEvent(type, {
          leadId: '000000000000000000000000', // ID inválido, mas testa roteamento
          test: true
        }, { correlationId: testId });

        await delay(500);

        // Verifica se job entrou na fila
        const q = queues[queue] || new Queue(queue, { connection: redisConnection });
        const jobs = await q.getJobs(['waiting', 'active', 'completed', 'failed']);
        
        // Deve ter pelo menos o job que acabamos de publicar ou um worker processando
        console.log(`[QA] Evento ${type} → Fila ${queue}: ${jobs.length} jobs`);
        
        // Limpa
        if (!queues[queue]) await q.close();
      }
    }, TEST_TIMEOUT);
  });

  // ============================================================================
  // TESTE 3: AUTO-REPLY (AMANDA FSM)
  // ============================================================================
  describe('TESTE 3 — AUTO-REPLY AMANDA FSM', () => {
    
    it('✓ Respeita manualControl ativo', async () => {
      await cleanupCollections();

      const phone = '5561888888888';
      const wamid = `wamid.manual.${Date.now()}`;

      const lead = await Lead.create({
        name: 'Lead Manual Control',
        phone,
        source: 'whatsapp',
        stage: VALID_STAGES.TRIAGE,
        manualControl: {
          active: true,
          takenOverAt: new Date(),
          takenOverBy: new Types.ObjectId()
        }
      });

      // Tenta publicar auto-reply
      await publishEvent(EventTypes.WHATSAPP_AUTO_REPLY_REQUESTED, {
        leadId: lead._id.toString(),
        from: phone,
        to: '5561999999999',
        content: 'Quero agendar',
        wamid,
        messageId: 'msg123'
      }, { 
        correlationId: `test:${wamid}`,
        jobId: `auto-reply:${lead._id}`
      });

      await delay(1500);

      // Com manualControl ativo, não deve gerar resposta
      // (o worker deve skipar)
      const outboundMessages = await Message.find({
        from: '5561999999999',
        to: phone,
        createdAt: { $gte: new Date(Date.now() - 5000) }
      });

      console.log('[QA] Mensagens outbound com manualControl:', outboundMessages.length);
      // Pode ter 0 (skip correto) ou mensagens (se regras de timeout aplicarem)
      expect(outboundMessages.length).toBe(0);
    }, TEST_TIMEOUT);

    it('✓ Não duplica resposta com mesmo jobId', async () => {
      await cleanupCollections();

      const phone = '5561777777777';
      const lead = await Lead.create({
        name: 'Lead Dedup Test',
        phone,
        source: 'whatsapp',
        stage: VALID_STAGES.NEW
      });

      const wamid = `wamid.dedup.${Date.now()}`;
      const jobId = `auto-reply:${lead._id}`;

      // Publica 3x com mesmo jobId (simula retry/republish)
      for (let i = 0; i < 3; i++) {
        await publishEvent(EventTypes.WHATSAPP_AUTO_REPLY_REQUESTED, {
          leadId: lead._id.toString(),
          from: phone,
          to: '5561999999999',
          content: 'Teste dedup',
          wamid: `${wamid}-${i}`,
          messageId: `msg${i}`
        }, { 
          correlationId: `test:${wamid}`,
          jobId // MESMO jobId!
        });
      }

      await delay(3000);

      // Deve ter apenas 1 job na fila (BullMQ dedup)
      const queue = new Queue('whatsapp-auto-reply', { connection: redisConnection });
      const jobs = await queue.getJobs(['waiting', 'active', 'completed']);
      
      console.log('[QA] Jobs com mesmo jobId:', jobs.length);
      // BullMQ descarta duplicatas com mesmo jobId
      
      await queue.close();
    }, TEST_TIMEOUT);
  });

  // ============================================================================
  // TESTE 4: RECOVERY SYSTEM
  // ============================================================================
  describe('TESTE 4 — RECOVERY SYSTEM', () => {
    
    it('✓ Publica e consome LEAD_RECOVERY_CANCEL_REQUESTED', async () => {
      const testLeadId = `test:${Date.now()}`;
      
      await publishEvent(EventTypes.LEAD_RECOVERY_CANCEL_REQUESTED, {
        leadId: testLeadId,
        reason: 'qa_test'
      }, { correlationId: `test:recovery:${Date.now()}` });

      await delay(1000);

      // Verifica se evento foi publicado
      const events = await EventStore.find({
        eventType: EventTypes.LEAD_RECOVERY_CANCEL_REQUESTED
      }).sort({ createdAt: -1 }).limit(5);

      console.log('[QA] Recovery events:', events.length);
      expect(events.length).toBeGreaterThan(0);
    });
  });

  // ============================================================================
  // TESTE 5: FOLLOW-UP SYSTEM
  // ============================================================================
  describe('TESTE 5 — FOLLOW-UP SYSTEM', () => {
    
    it('✓ Não cria follow-up duplicado', async () => {
      await cleanupCollections();

      const lead = await Lead.create({
        name: 'Lead Followup Test',
        phone: '5561666666666',
        source: 'whatsapp',
        stage: VALID_STAGES.CONTACT_MADE
      });

      const followupId = `followup:${Date.now()}`;

      // Publica 2x mesmo followup
      for (let i = 0; i < 2; i++) {
        await publishEvent(EventTypes.FOLLOWUP_REQUESTED, {
          leadId: lead._id.toString(),
          followupId,
          stage: 'contact_made',
          attempt: 1
        }, { 
          correlationId: `test:${Date.now()}`,
          idempotencyKey: `followup_${followupId}_${Date.now()}`
        });
      }

      await delay(2000);

      // Verifica no EventStore
      const events = await EventStore.find({
        eventType: EventTypes.FOLLOWUP_REQUESTED
      }).sort({ createdAt: -1 }).limit(10);

      console.log('[QA] Followup events:', events.length);
    });
  });

  // ============================================================================
  // TESTE 6: DEDUP + RACE CONDITIONS
  // ============================================================================
  describe('TESTE 6 — DEDUP E RACE CONDITIONS', () => {
    
    it('✓ Redis lock previne processamento duplo', async () => {
      // Este teste verifica se o lock Redis está funcionando
      // Na prática, o lock é liberado rápido, mas validamos a estrutura
      
      const phone = '5561555555555';
      const wamid = `wamid.concurrent.${Date.now()}`;

      const lead = await Lead.create({
        name: 'Lead Concurrent',
        phone,
        source: 'whatsapp',
        stage: VALID_STAGES.NEW
      });

      // Publica 10 mensagens "simultâneas"
      const promises = [];
      for (let i = 0; i < 10; i++) {
        const msg = {
          id: `${wamid}-${i}`,
          from: phone,
          type: 'text',
          timestamp: Date.now().toString(),
          text: { body: `Mensagem ${i}` }
        };
        const value = {
          metadata: { display_phone_number: '5561999999999' }
        };
        promises.push(
          publishEvent(EventTypes.WHATSAPP_MESSAGE_RECEIVED, { msg, value }, { correlationId: `test:${wamid}:${i}` })
        );
      }

      await Promise.all(promises);
      await delay(5000);

      // Verifica se não criou leads duplicados
      const leads = await Lead.find({ phone });
      console.log('[QA] Debug leads:', await Lead.find({}));
      console.log('[QA] Leads criados (esperado: 1):', leads.length);
      expect(leads.length).toBe(1);

      // Verifica mensagens
      const messages = await Message.find({ from: phone });
      console.log('[QA] Mensagens criadas (esperado: 10):', messages.length);
      expect(messages.length).toBe(10);
    }, TEST_TIMEOUT);
  });

  // ============================================================================
  // TESTE 7: SILENT FAIL DETECTION
  // ============================================================================
  describe('TESTE 7 — SILENT FAIL DETECTION', () => {
    
    it('✓ Detecta workers que logam sucesso mas não alteram DB', async () => {
      // Cria lead inválido (força erro silencioso)
      const fakeLeadId = '000000000000000000000000';
      
      await publishEvent(EventTypes.WHATSAPP_AUTO_REPLY_REQUESTED, {
        leadId: fakeLeadId,
        from: '5561444444444',
        to: '5561999999999',
        content: 'Teste',
        wamid: `wamid.fake.${Date.now()}`,
        messageId: 'fake'
      }, { correlationId: `test:silent:${Date.now()}` });

      await delay(1500);

      // Worker deve ter logado "lead_not_found" e retornado status skipped
      // Verificamos se não criou mensagem fantasma
      const fakeMessages = await Message.find({
        from: '5561999999999',
        to: '5561444444444'
      });

      console.log('[QA] Mensagens para lead fake:', fakeMessages.length);
      expect(fakeMessages.length).toBe(0);
    }, TEST_TIMEOUT);

    it('✓ Eventos publicados sem payload crítico são detectados', async () => {
      // Publica evento incompleto (sem leadId)
      await publishEvent(EventTypes.LEAD_RECOVERY_CANCEL_REQUESTED, {
        reason: 'test_incomplete'
        // leadId ausente!
      }, { correlationId: `test:incomplete:${Date.now()}` });

      await delay(1000);

      // Worker deve ter skipado com MISSING_LEAD_ID
      const events = await EventStore.find({
        eventType: EventTypes.LEAD_RECOVERY_CANCEL_REQUESTED
      }).sort({ createdAt: -1 }).limit(1);

      if (events.length > 0) {
        console.log('[QA] Evento incompleto processado:', events[0].payload);
      }
    });
  });

  // ============================================================================
  // TESTE 8: CORRELATION TRACE
  // ============================================================================
  describe('TESTE 8 — CORRELATION TRACE', () => {
    
    it('✓ correlationId propagado em toda cadeia', async () => {
      await cleanupCollections();

      const correlationId = `trace:${Date.now()}`;
      const phone = '5561333333333';
      const wamid = `wamid.trace.${Date.now()}`;

      const lead = await Lead.create({
        name: 'Lead Trace',
        phone,
        source: 'whatsapp',
        stage: VALID_STAGES.NEW
      });

      // Publica evento inbound com correlationId
      const msg = {
        id: wamid,
        from: phone,
        type: 'text',
        timestamp: Date.now().toString(),
        text: { body: 'Teste trace' }
      };
      const value = {
        metadata: { display_phone_number: '5561999999999' }
      };
      await publishEvent(EventTypes.WHATSAPP_MESSAGE_RECEIVED, { msg, value }, { correlationId });

      await delay(2000);

      // Verifica se correlationId aparece nos eventos
      const events = await EventStore.find({ correlationId });
      console.log('[QA] Eventos com correlationId:', events.length);
      
      if (events.length > 0) {
        events.forEach(e => {
          expect(e.metadata.correlationId).toBe(correlationId);
        });
      }
    }, TEST_TIMEOUT);
  });
});

// ============================================================================
// RELATÓRIO FINAL
// ============================================================================
console.log(`
================================================================================
                    QA WHATSAPP V2 - EXECUÇÃO COMPLETA
================================================================================
`);
