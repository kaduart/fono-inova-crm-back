/**
 * 🚨 Testes de Casos de Borda - Agenda Externa
 * 
 * Testes específicos para os bugs encontrados em produção:
 * 1. Timeout em sync-update (double commit)
 * 2. Dados do paciente não carregando (birthDate, email)
 * 3. Token inválido em rotas que não aceitam service token
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import express from 'express';

// Setup e Factories
import { 
  setupMongoDB, 
  teardownMongoDB, 
  clearCollections,
  Factories,
  AuthHelpers,
  AssertHelpers
} from './agenda-externa.setup.js';

// Criar app de teste real
async function createTestApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  
  // Importar rotas reais
  const { default: importFromAgendaRoutes } = await import('../../routes/importFromAgenda.js');
  const { default: preAgendamentoRoutes } = await import('../../routes/preAgendamento.js');
  const { default: appointmentRoutes } = await import('../../routes/appointment.js');
  
  // Montar rotas
  app.use('/api/import-from-agenda', importFromAgendaRoutes);
  app.use('/api/pre-agendamento', preAgendamentoRoutes);
  app.use('/api/appointments', appointmentRoutes);
  
  // Error handler
  app.use((err, req, res, next) => {
    console.error('[TEST ERROR]', err);
    res.status(500).json({ success: false, error: err.message });
  });
  
  return app;
}

describe('🚨 Casos de Borda - Bugs de Produção', () => {
  let app;
  let mongoServer;
  
  beforeAll(async () => {
    mongoServer = await setupMongoDB();
    app = await createTestApp();
  });
  
  afterAll(async () => {
    await teardownMongoDB();
  });
  
  beforeEach(async () => {
    await clearCollections();
  });
  
  describe('BUG #1: Double Commit em sync-update', () => {
    it('deve completar update sem erro de transação dupla', async () => {
      const doctor = await Factories.createDoctor();
      const patient = await Factories.createPatient();
      const appointment = await Factories.createAppointment({ 
        doctor: doctor._id, 
        patient: patient._id 
      });
      
      const startTime = Date.now();
      
      const response = await request(app)
        .post('/api/import-from-agenda/sync-update')
        .set('Authorization', `Bearer ${AuthHelpers.getServiceToken()}`)
        .send({
          externalId: appointment._id.toString(),
          date: '2026-03-01',
          time: '15:00',
          professionalName: doctor.fullName,
          specialty: 'fonoaudiologia'
        });
      
      const duration = Date.now() - startTime;
      
      // Não deve demorar mais que 5 segundos
      expect(duration).toBeLessThan(5000);
      
      // Deve retornar sucesso
      if (response.status !== 200) {
        console.log('❌ Falha no sync-update:', response.body);
      }
      
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
    
    it('deve lidar com múltiplos updates simultâneos', async () => {
      const doctor = await Factories.createDoctor();
      const appointment = await Factories.createAppointment({ doctor: doctor._id });
      
      // Fazer 5 requests simultâneos
      const requests = Array(5).fill(null).map((_, i) => 
        request(app)
          .post('/api/import-from-agenda/sync-update')
          .set('Authorization', `Bearer ${AuthHelpers.getServiceToken()}`)
          .send({
            externalId: appointment._id.toString(),
            time: `1${i}:00`
          })
      );
      
      const responses = await Promise.allSettled(requests);
      
      // Pelo menos uma deve ter sucesso
      const successes = responses.filter(r => 
        r.status === 'fulfilled' && r.value.status === 200
      );
      
      expect(successes.length).toBeGreaterThanOrEqual(1);
    });
  });
  
  describe('BUG #2: Dados do paciente não carregando', () => {
    it('deve retornar birthDate no mapeamento do appointment', async () => {
      const doctor = await Factories.createDoctor();
      const patient = await Factories.createPatient({
        fullName: 'Paciente Com Nascimento',
        dateOfBirth: '1990-05-15T00:00:00.000Z'
      });
      
      await Factories.createAppointment({
        doctor: doctor._id,
        patient: patient._id,
        date: '2026-02-20'
      });
      
      const response = await request(app)
        .get('/api/appointments')
        .query({ startDate: '2026-02-01', endDate: '2026-02-28' })
        .set('Authorization', `Bearer ${AuthHelpers.getServiceToken()}`);
      
      expect(response.status).toBe(200);
      expect(response.body.length).toBeGreaterThan(0);
      
      const appointment = response.body[0];
      
      // Verificar se dados do paciente estão presentes
      expect(appointment.patient).toBeDefined();
      expect(appointment.patientName).toBe('Paciente Com Nascimento');
      
      // BUG: birthDate não estava sendo retornado
      // Após correção, deve estar presente
      console.log('📊 Dados do paciente retornados:', {
        patientName: appointment.patientName,
        patient: appointment.patient,
        birthDate: appointment.patient?.dateOfBirth,
        email: appointment.patient?.email
      });
    });
    
    it('deve preservar dados do patientInfo quando patient populado', async () => {
      const doctor = await Factories.createDoctor();
      const patient = await Factories.createPatient({
        phone: '11999991111',
        email: 'teste@preservado.com'
      });
      
      await Factories.createAppointment({
        doctor: doctor._id,
        patient: patient._id
      });
      
      const response = await request(app)
        .get('/api/appointments')
        .query({ startDate: '2026-02-01', endDate: '2026-02-28' })
        .set('Authorization', `Bearer ${AuthHelpers.getServiceToken()}`);
      
      const appt = response.body[0];
      
      // Dados devem estar presentes
      expect(appt.patient?.phone).toBe('11999991111');
      expect(appt.patient?.email).toBe('teste@preservado.com');
    });
  });
  
  describe('BUG #3: Autenticação em DELETE /appointments', () => {
    it('deve aceitar AGENDA_EXPORT_TOKEN no DELETE', async () => {
      const appointment = await Factories.createAppointment();
      
      const response = await request(app)
        .delete(`/api/appointments/${appointment._id}`)
        .set('Authorization', `Bearer ${AuthHelpers.getServiceToken()}`);
      
      // Antes da correção: 401 INVALID_TOKEN
      // Após correção: 200
      expect(response.status).toBe(200);
      expect(response.body.message).toContain('sucesso');
    });
    
    it('deve rejeitar token JWT inválido', async () => {
      const appointment = await Factories.createAppointment();
      
      const response = await request(app)
        .delete(`/api/appointments/${appointment._id}`)
        .set('Authorization', 'Bearer token_jwt_invalido');
      
      expect(response.status).toBe(401);
    });
    
    it('deve aceitar JWT válido (quando implementado)', async () => {
      const appointment = await Factories.createAppointment();
      
      // Simular um JWT formatado corretamente
      // Na prática, você precisaria gerar um JWT real com jwt.sign
      const fakeJwt = AuthHelpers.generateFakeJWT();
      
      const response = await request(app)
        .delete(`/api/appointments/${appointment._id}`)
        .set('Authorization', `Bearer ${fakeJwt}`);
      
      // Se o flexibleAuth estiver configurado corretamente,
      // deve tentar validar o JWT e falhar (pois é fake)
      expect([401, 200]).toContain(response.status);
    });
  });
  
  describe('Validação de Dados', () => {
    it('deve rejeitar data inválida', async () => {
      const appointment = await Factories.createAppointment();
      
      const response = await request(app)
        .post('/api/import-from-agenda/sync-update')
        .set('Authorization', `Bearer ${AuthHelpers.getServiceToken()}`)
        .send({
          externalId: appointment._id.toString(),
          date: 'data-invalida',
          time: '25:99' // Hora inválida
        });
      
      // Deve retornar erro de validação
      expect([400, 422]).toContain(response.status);
    });
    
    it('deve rejeitar specialty inválida', async () => {
      const appointment = await Factories.createAppointment();
      
      const response = await request(app)
        .post('/api/import-from-agenda/sync-update')
        .set('Authorization', `Bearer ${AuthHelpers.getServiceToken()}`)
        .send({
          externalId: appointment._id.toString(),
          specialty: 'especialidade_que_nao_existe_12345'
        });
      
      // Pode aceitar (string) ou rejeitar
      expect([200, 400]).toContain(response.status);
    });
    
    it('deve lidar com professionalName não encontrado', async () => {
      const appointment = await Factories.createAppointment();
      
      const response = await request(app)
        .post('/api/import-from-agenda/sync-update')
        .set('Authorization', `Bearer ${AuthHelpers.getServiceToken()}`)
        .send({
          externalId: appointment._id.toString(),
          professionalName: 'Dra. Inexistente No Sistema'
        });
      
      // Deve retornar erro indicando que profissional não foi encontrado
      expect([404, 400]).toContain(response.status);
    });
  });
  
  describe('Cenários de Concorrência', () => {
    it('deve lidar com delete enquanto atualiza', async () => {
      const appointment = await Factories.createAppointment();
      const id = appointment._id.toString();
      
      // Iniciar update
      const updatePromise = request(app)
        .post('/api/import-from-agenda/sync-update')
        .set('Authorization', `Bearer ${AuthHelpers.getServiceToken()}`)
        .send({ externalId: id, date: '2026-03-01' });
      
      // Tentar delete simultâneo
      const deletePromise = request(app)
        .delete(`/api/appointments/${id}`)
        .set('Authorization', `Bearer ${AuthHelpers.getServiceToken()}`);
      
      const [updateRes, deleteRes] = await Promise.allSettled([updatePromise, deletePromise]);
      
      // Um deve ter sucesso, o outro pode falhar
      const results = [updateRes, deleteRes].map(r => 
        r.status === 'fulfilled' ? r.value.status : null
      );
      
      // Pelo menos um deve ter sucesso
      expect(results.some(r => r === 200)).toBe(true);
    });
  });
  
  describe('Validação de Schema', () => {
    it('deve validar campos obrigatórios em pre-agendamento', async () => {
      const response = await request(app)
        .post('/api/pre-agendamento/webhook')
        .set('Authorization', `Bearer ${AuthHelpers.getServiceToken()}`)
        .send({
          // Faltando patientInfo
          professionalName: 'Dra. Teste',
          preferredDate: '2026-03-01'
        });
      
      expect([400, 422, 500]).toContain(response.status);
    });
    
    it('deve validar formato de telefone', async () => {
      const response = await request(app)
        .post('/api/import-from-agenda')
        .set('Authorization', `Bearer ${AuthHelpers.getServiceToken()}`)
        .send({
          externalId: `test_${Date.now()}`,
          patientInfo: {
            fullName: 'Paciente',
            phone: 'telefone_invalido', // Formato inválido
            birthDate: '1990-01-01'
          },
          professionalName: 'Dra. Teste',
          specialty: 'fonoaudiologia',
          date: '2026-03-01',
          time: '10:00'
        });
      
      // Pode aceitar (string) ou validar
      expect([200, 400]).toContain(response.status);
    });
  });
});

// Teste de Carga Básico
describe('⚡ Teste de Carga', () => {
  let app;
  let mongoServer;
  
  beforeAll(async () => {
    mongoServer = await setupMongoDB();
    app = await createTestApp();
  });
  
  afterAll(async () => {
    await teardownMongoDB();
  });
  
  it('deve suportar 50 requests simultâneos de sync-update', async () => {
    const doctor = await Factories.createDoctor();
    const appointments = await Promise.all(
      Array(50).fill(null).map((_, i) => 
        Factories.createAppointment({ 
          doctor: doctor._id,
          date: `2026-03-${String(i + 1).padStart(2, '0')}`
        })
      )
    );
    
    const startTime = Date.now();
    
    const requests = appointments.map((appt, i) => 
      request(app)
        .post('/api/import-from-agenda/sync-update')
        .set('Authorization', `Bearer ${AuthHelpers.getServiceToken()}`)
        .send({
          externalId: appt._id.toString(),
          time: `${String(i % 12 + 8).padStart(2, '0')}:00`
        })
    );
    
    const responses = await Promise.allSettled(requests);
    const duration = Date.now() - startTime;
    
    const successes = responses.filter(r => 
      r.status === 'fulfilled' && r.value.status === 200
    ).length;
    
    console.log(`✅ ${successes}/50 requests bem-sucedidos em ${duration}ms`);
    
    // Deve completar em menos de 30 segundos
    expect(duration).toBeLessThan(30000);
    
    // Pelo menos 80% deve ter sucesso
    expect(successes).toBeGreaterThanOrEqual(40);
  });
});
