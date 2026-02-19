/**
 * 🧪 Setup para Testes de Integração - Agenda Externa
 * 
 * Este arquivo configura o ambiente de testes:
 * - Banco MongoDB em memória (MongoMemoryServer)
 * - Variáveis de ambiente de teste
 * - Mocks para serviços externos (Redis, Socket.IO, etc.)
 */

import { vi } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

// 🔧 Configuração das variáveis de ambiente de teste
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test_secret_key_nao_usar_em_producao';
process.env.AGENDA_EXPORT_TOKEN = 'agenda_export_token_test_12345';
process.env.ADMIN_API_TOKEN = 'admin_api_token_test_67890';

// 🎭 Mocks Globais

// Mock do Redis
vi.mock('../../config/redisConnection.js', () => ({
  redisConnection: {
    get: vi.fn().mockResolvedValue(null),
    setex: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    keys: vi.fn().mockResolvedValue([]),
    exists: vi.fn().mockResolvedValue(0),
    expire: vi.fn().mockResolvedValue(1),
  }
}));

// Mock do Socket.IO
vi.mock('../../config/socket.js', () => ({
  getIo: vi.fn().mockReturnValue({
    emit: vi.fn(),
    to: vi.fn().mockReturnValue({ emit: vi.fn() }),
  }),
  initializeSocket: vi.fn()
}));

// Mock do BullMQ/Queue
vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({
    add: vi.fn().mockResolvedValue({ id: 'test-job-id' }),
    getJob: vi.fn().mockResolvedValue(null),
  })),
  Worker: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Mock do SendGrid
vi.mock('@sendgrid/mail', () => ({
  setApiKey: vi.fn(),
  send: vi.fn().mockResolvedValue([{ statusCode: 202 }]),
}));

// 🗄️ MongoDB Memory Server
let mongoServer;

export async function setupMongoDB() {
  mongoServer = await MongoMemoryServer.create({
    instance: {
      dbName: 'crm_test_agenda_externa',
    },
    binary: {
      version: '6.0.0', // Versão compatível
    },
  });
  
  const mongoUri = mongoServer.getUri();
  
  await mongoose.connect(mongoUri, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
  
  console.log('✅ MongoDB Memory Server conectado:', mongoUri);
  return mongoServer;
}

export async function teardownMongoDB() {
  await mongoose.disconnect();
  if (mongoServer) {
    await mongoServer.stop();
    console.log('✅ MongoDB Memory Server parado');
  }
}

export async function clearCollections() {
  const collections = mongoose.connection.collections;
  
  for (const key in collections) {
    await collections[key].deleteMany({});
  }
  console.log('🧹 Coleções limpas');
}

// 🏭 Factory para criar dados de teste
export const Factories = {
  async createDoctor(overrides = {}) {
    const Doctor = (await import('../../models/Doctor.js')).default;
    return Doctor.create({
      fullName: 'Dra. Teste',
      email: `teste_${Date.now()}@clinica.com`,
      specialty: 'fonoaudiologia',
      active: true,
      ...overrides
    });
  },
  
  async createPatient(overrides = {}) {
    const Patient = (await import('../../models/Patient.js')).default;
    return Patient.create({
      fullName: 'Paciente Teste',
      phone: '11999998888',
      email: `paciente_${Date.now()}@teste.com`,
      dateOfBirth: '1990-05-15',
      ...overrides
    });
  },
  
  async createAppointment(overrides = {}) {
    const Appointment = (await import('../../models/Appointment.js')).default;
    const doctor = overrides.doctor || (await this.createDoctor())._id;
    const patient = overrides.patient || (await this.createPatient())._id;
    
    return Appointment.create({
      patient,
      doctor,
      date: '2026-02-20',
      time: '10:00',
      specialty: 'fonoaudiologia',
      operationalStatus: 'scheduled',
      duration: 40,
      ...overrides
    });
  },
  
  async createPreAgendamento(overrides = {}) {
    const PreAgendamento = (await import('../../models/PreAgendamento.js')).default;
    return PreAgendamento.create({
      externalId: `test_${Date.now()}`,
      patientInfo: {
        fullName: 'Paciente Pré-Agendamento',
        phone: '11999997777',
        birthDate: '1992-08-10',
      },
      professionalName: 'Dra. Teste',
      preferredDate: '2026-03-15',
      preferredTime: '10:00',
      specialty: 'fonoaudiologia',
      status: 'novo',
      ...overrides
    });
  },
  
  async createSession(overrides = {}) {
    const Session = (await import('../../models/Session.js')).default;
    const doctor = overrides.doctor || (await this.createDoctor())._id;
    const patient = overrides.patient || (await this.createPatient())._id;
    
    return Session.create({
      patient,
      doctor,
      date: '2026-02-20',
      time: '10:00',
      specialty: 'fonoaudiologia',
      status: 'scheduled',
      ...overrides
    });
  }
};

// 🔑 Helpers de Autenticação
export const AuthHelpers = {
  getServiceToken() {
    return process.env.AGENDA_EXPORT_TOKEN;
  },
  
  getAdminToken() {
    return process.env.ADMIN_API_TOKEN;
  },
  
  getInvalidToken() {
    return 'token_invalido_12345';
  },
  
  generateFakeJWT() {
    // Simula um JWT formatado (não válido, mas com formato correto)
    return 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6InRlc3QiLCJyb2xlIjoiYWRtaW4ifQ.fake';
  }
};

// 📊 Helpers de Assert
export const AssertHelpers = {
  expectSuccess(response) {
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  },
  
  expectError(response, statusCode) {
    expect(response.status).toBe(statusCode);
    expect(response.body.success).toBe(false);
  },
  
  expectNotFound(response) {
    this.expectError(response, 404);
    expect(response.body.error).toContain('não encontrado');
  },
  
  expectUnauthorized(response) {
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('INVALID_TOKEN');
  },
  
  expectValidationError(response) {
    this.expectError(response, 400);
  }
};

// 🚀 Setup Global
export async function setup() {
  console.log('\n🚀 Iniciando ambiente de testes...\n');
  await setupMongoDB();
}

export async function teardown() {
  console.log('\n🛑 Finalizando ambiente de testes...\n');
  await teardownMongoDB();
}
