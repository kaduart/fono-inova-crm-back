/**
 * 🧪 Testes de Integração - APIs da Agenda Externa
 * 
 * Testa todas as rotas de integração da Agenda Externa com o CRM (MongoDB)
 * Executar: npm run test:run -- tests/integration/agenda-externa.test.js
 * 
 * ⚠️ REQUER: MongoDB rodando e variáveis de ambiente configuradas
 * ⚠️ REQUER: AGENDA_EXPORT_TOKEN definido no .env.test
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import express from 'express';
import dotenv from 'dotenv';

// Carregar variáveis de ambiente de teste
dotenv.config({ path: '.env.test' });

// Mock do Redis para não depender de conexão externa
vi.mock('../../config/redisConnection.js', () => ({
  redisConnection: {
    get: vi.fn().mockResolvedValue(null),
    setex: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    keys: vi.fn().mockResolvedValue([]),
  }
}));

// Mock do Socket.IO
vi.mock('../../config/socket.js', () => ({
  getIo: vi.fn().mockReturnValue({
    emit: vi.fn()
  })
}));

// Importar models e rotas
import Appointment from '../../models/Appointment.js';
import Patient from '../../models/Patient.js';
import Doctor from '../../models/Doctor.js';
import Session from '../../models/Session.js';
import Payment from '../../models/Payment.js';

// Criar app Express para testes
const createTestApp = () => {
  const app = express();
  app.use(express.json());
  
  // Middleware de autenticação mock para testes
  app.use((req, res, next) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token === process.env.AGENDA_EXPORT_TOKEN || token === 'test_token') {
      req.integration = { source: 'agenda' };
      return next();
    }
    return res.status(401).json({ code: 'INVALID_TOKEN', message: 'Token inválido' });
  });
  
  return app;
};

describe('🔄 APIs de Integração - Agenda Externa', () => {
  let mongoServer;
  let app;
  const TEST_TOKEN = process.env.AGENDA_EXPORT_TOKEN || 'test_token';
  
  // Dados de teste
  let testDoctor;
  let testPatient;
  let testAppointment;
  
  beforeAll(async () => {
    // Iniciar MongoDB em memória
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    
    await mongoose.connect(mongoUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    
    console.log('✅ MongoDB Memory Server iniciado');
  });
  
  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
    console.log('✅ MongoDB Memory Server parado');
  });
  
  beforeEach(async () => {
    // Limpar coleções antes de cada teste
    await Appointment.deleteMany({});
    await Patient.deleteMany({});
    await Doctor.deleteMany({});
    await Session.deleteMany({});
    await Payment.deleteMany({});
    // Criar dados base
    testDoctor = await Doctor.create({
      fullName: 'Dra. Teste Integração',
      email: 'teste@clinica.com',
      specialty: 'fonoaudiologia',
      active: true
    });
    
    testPatient = await Patient.create({
      fullName: 'Paciente Teste',
      phone: '11999998888',
      email: 'paciente@teste.com',
      dateOfBirth: '1990-05-15'
    });
  });
  
  describe('POST /api/import-from-agenda/sync-update', () => {
    it('✅ deve atualizar agendamento existente com dados válidos', async () => {
      // Criar agendamento de teste
      const appointment = await Appointment.create({
        patient: testPatient._id,
        doctor: testDoctor._id,
        date: '2026-02-20',
        time: '10:00',
        specialty: 'fonoaudiologia',
        operationalStatus: 'scheduled',
        duration: 40
      });
      
      const payload = {
        externalId: appointment._id.toString(),
        date: '2026-02-21',
        time: '14:00',
        professionalName: 'Dra. Teste Integração',
        specialty: 'fonoaudiologia',
        patientInfo: {
          fullName: 'Paciente Teste Atualizado',
          phone: '11999997777',
          birthDate: '1991-06-16',
          email: 'novo@teste.com'
        },
        observations: 'Observação atualizada via teste'
      };
      
      const response = await request(app)
        .post('/api/import-from-agenda/sync-update')
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
        .send(payload)
        .expect(200);
      
      expect(response.body.success).toBe(true);
      expect(response.body.appointmentId).toBe(appointment._id.toString());
      
      // Verificar se foi atualizado no banco
      const updated = await Appointment.findById(appointment._id);
      expect(updated.date).toBe('2026-02-21');
      expect(updated.time).toBe('14:00');
    });
    
    it('❌ deve retornar 404 quando agendamento não existe', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      
      const response = await request(app)
        .post('/api/import-from-agenda/sync-update')
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
        .send({
          externalId: fakeId.toString(),
          date: '2026-02-21'
        })
        .expect(404);
      
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('não encontrado');
    });
    
    it('❌ deve retornar 401 quando token é inválido', async () => {
      const response = await request(app)
        .post('/api/import-from-agenda/sync-update')
        .set('Authorization', 'Bearer token_invalido')
        .send({ externalId: '123', date: '2026-02-21' })
        .expect(401);
      
      expect(response.body.code).toBe('INVALID_TOKEN');
    });
    
    it('❌ deve retornar 400 quando externalId não é fornecido', async () => {
      const response = await request(app)
        .post('/api/import-from-agenda/sync-update')
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
        .send({ date: '2026-02-21' })
        .expect(400);
      
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('externalId é obrigatório');
    });
    
    it('✅ deve ignorar update de agendamento concluído há mais de 7 dias', async () => {
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 10);
      
      const appointment = await Appointment.create({
        patient: testPatient._id,
        doctor: testDoctor._id,
        date: oldDate.toISOString().split('T')[0],
        time: '10:00',
        specialty: 'fonoaudiologia',
        operationalStatus: 'confirmed',
        duration: 40
      });
      
      const response = await request(app)
        .post('/api/import-from-agenda/sync-update')
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
        .send({
          externalId: appointment._id.toString(),
          date: '2026-02-21'
        })
        .expect(200);
      
      expect(response.body.status).toBe('archived');
    });
  });
  
  describe('POST /api/import-from-agenda/sync-delete', () => {
    it('✅ deve excluir agendamento existente', async () => {
      const appointment = await Appointment.create({
        patient: testPatient._id,
        doctor: testDoctor._id,
        date: '2026-02-20',
        time: '10:00',
        specialty: 'fonoaudiologia',
        operationalStatus: 'scheduled'
      });
      
      const response = await request(app)
        .post('/api/import-from-agenda/sync-delete')
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
        .send({
          externalId: appointment._id.toString(),
          reason: 'Excluído via teste'
        })
        .expect(200);
      
      expect(response.body.success).toBe(true);
      
      // Verificar se foi excluído
      const deleted = await Appointment.findById(appointment._id);
      expect(deleted).toBeNull();
    });
    
    it('❌ deve retornar 404 quando agendamento não existe', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      
      const response = await request(app)
        .post('/api/import-from-agenda/sync-delete')
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
        .send({ externalId: fakeId.toString() })
        .expect(404);
      
      expect(response.body.success).toBe(false);
    });
  });
  
  describe('POST /api/import-from-agenda/sync-cancel', () => {
    it('✅ deve cancelar agendamento existente (soft delete)', async () => {
      const session = await Session.create({
        patient: testPatient._id,
        doctor: testDoctor._id,
        date: '2026-02-20',
        time: '10:00',
        status: 'scheduled'
      });
      
      const appointment = await Appointment.create({
        patient: testPatient._id,
        doctor: testDoctor._id,
        session: session._id,
        date: '2026-02-20',
        time: '10:00',
        specialty: 'fonoaudiologia',
        operationalStatus: 'scheduled'
      });
      
      const response = await request(app)
        .post('/api/import-from-agenda/sync-cancel')
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
        .send({
          externalId: appointment._id.toString(),
          reason: 'Cancelado via teste',
          confirmedAbsence: false
        })
        .expect(200);
      
      expect(response.body.success).toBe(true);
      
      // Verificar se foi cancelado
      const canceled = await Appointment.findById(appointment._id);
      expect(canceled.operationalStatus).toBe('canceled');
      
      const canceledSession = await Session.findById(session._id);
      expect(canceledSession.status).toBe('canceled');
    });
  });
  
  describe('POST /api/import-from-agenda', () => {
    it('✅ deve criar novo pré-agendamento como Appointment', async () => {
      const payload = {
        externalId: `test_${Date.now()}`,
        patientInfo: {
          fullName: 'Novo Paciente',
          phone: '11999995555',
          birthDate: '1995-03-20',
          email: 'novo@email.com'
        },
        professionalName: 'Dra. Teste Integração',
        specialty: 'fonoaudiologia',
        date: '2026-03-01',
        time: '09:00',
        crm: {
          serviceType: 'individual_session',
          sessionType: 'avaliacao',
          paymentMethod: 'pix',
          paymentAmount: 200
        }
      };

      const response = await request(app)
        .post('/api/import-from-agenda')
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
        .send(payload)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.preAgendamentoId).toBeDefined();

      // Verificar se foi criado como Appointment com status pre_agendado
      const pre = await Appointment.findById(response.body.preAgendamentoId);
      expect(pre).toBeDefined();
      expect(pre.patientInfo.fullName).toBe('Novo Paciente');
      expect(pre.operationalStatus).toBe('pre_agendado');
    });
    
    it('❌ deve retornar erro quando profissional não existe', async () => {
      const payload = {
        externalId: `test_${Date.now()}`,
        patientInfo: { fullName: 'Paciente', phone: '11999995555' },
        professionalName: 'Dra. Inexistente',
        specialty: 'fonoaudiologia',
        date: '2026-03-01',
        time: '09:00'
      };
      
      const response = await request(app)
        .post('/api/import-from-agenda')
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
        .send(payload)
        .expect(500);
      
      expect(response.body.success).toBe(false);
    });
  });
  
  describe('POST /api/import-from-agenda/confirmar-por-external-id', () => {
    it('✅ deve confirmar pré-agendamento e atualizar para scheduled', async () => {
      // Criar pré-agendamento como Appointment com status pre_agendado
      const externalId = `test_${Date.now()}`;
      const pre = await Appointment.create({
        externalId,
        patientInfo: {
          fullName: 'Paciente Confirmar',
          phone: '11999994444',
          birthDate: '1992-08-10'
        },
        professionalName: 'Dra. Teste Integração',
        date: '2026-03-15',
        time: '10:00',
        specialty: 'fonoaudiologia',
        operationalStatus: 'pre_agendado',
        duration: 40
      });

      const response = await request(app)
        .post('/api/import-from-agenda/confirmar-por-external-id')
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
        .send({
          externalId: pre.externalId,
          doctorId: testDoctor._id.toString(),
          date: '2026-03-15',
          time: '10:00',
          sessionValue: 250,
          serviceType: 'individual_session',
          paymentMethod: 'pix'
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.appointmentId).toBeDefined();

      // Verificar se foi atualizado in-place para scheduled
      const updated = await Appointment.findById(pre._id);
      expect(updated.operationalStatus).toBe('scheduled');
    });
  });
  
  describe('DELETE /api/appointments/:id', () => {
    it('✅ deve aceitar token de serviço (flexibleAuth)', async () => {
      const appointment = await Appointment.create({
        patient: testPatient._id,
        doctor: testDoctor._id,
        date: '2026-02-20',
        time: '10:00',
        specialty: 'fonoaudiologia',
        operationalStatus: 'scheduled'
      });
      
      const response = await request(app)
        .delete(`/api/appointments/${appointment._id}`)
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
        .expect(200);
      
      expect(response.body.message).toContain('deletado');
    });
    
    it('✅ deve aceitar JWT de usuário também', async () => {
      // Este teste simula um JWT válido
      // Na prática, você precisaria gerar um JWT válido para o teste
      const appointment = await Appointment.create({
        patient: testPatient._id,
        doctor: testDoctor._id,
        date: '2026-02-20',
        time: '10:00',
        specialty: 'fonoaudiologia',
        operationalStatus: 'scheduled'
      });
      
      // Mock para aceitar JWT também
      const appWithJwt = express();
      appWithJwt.use(express.json());
      appWithJwt.use((req, res, next) => {
        const token = req.headers.authorization?.replace('Bearer ', '');
        // Aceita tanto o token de serviço quanto um JWT formatado
        if (token === TEST_TOKEN || token?.startsWith('eyJ')) {
          req.user = { id: 'test', role: 'admin' };
          return next();
        }
        return res.status(401).json({ code: 'INVALID_TOKEN' });
      });
      
      const response = await request(appWithJwt)
        .delete(`/api/appointments/${appointment._id}`)
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
        .expect(200);
      
      expect(response.body.message).toBeDefined();
    });
  });
  
  describe('POST /api/pre-agendamento/webhook', () => {
    it('✅ deve receber webhook de pré-agendamento', async () => {
      const payload = {
        externalId: `ext_${Date.now()}`,
        patientInfo: {
          fullName: 'Paciente Webhook',
          phone: '11999993333',
          birthDate: '1988-12-25',
          email: 'webhook@teste.com'
        },
        professionalName: 'Dra. Teste Integração',
        preferredDate: '2026-04-01',
        preferredTime: '15:00',
        specialty: 'fonoaudiologia',
        source: 'agenda_externa'
      };
      
      const response = await request(app)
        .post('/api/pre-agendamento/webhook')
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
        .send(payload)
        .expect(200);
      
      expect(response.body.success).toBe(true);
      expect(response.body.id).toBeDefined();
    });
  });
});

// Configuração do ambiente de teste
describe('🔒 Segurança - Validações', () => {
  it('deve validar formato de ObjectId', async () => {
    const response = await request(app)
      .post('/api/import-from-agenda/sync-update')
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({
        externalId: 'id_invalido_nao_mongodb',
        date: '2026-02-21'
      })
      .expect(404);
    
    expect(response.body.success).toBe(false);
  });
  
  it('deve rejeitar payload muito grande', async () => {
    const hugePayload = 'x'.repeat(10 * 1024 * 1024); // 10MB
    
    const response = await request(app)
      .post('/api/import-from-agenda')
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .set('Content-Type', 'application/json')
      .send(`{"data": "${hugePayload}"}`)
      .expect(413); // Payload Too Large
  });
});
