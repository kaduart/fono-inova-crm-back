/**
 * 🛠️ Test Helpers - Utilitários para testes E2E
 */

import axios from 'axios';
import { Queue } from 'bullmq';
import Redis from 'ioredis';

// Configurações
const API_URL = process.env.API_URL || 'http://localhost:5000';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// Cliente HTTP para testes
export function createTestContext() {
  const api = axios.create({
    baseURL: API_URL,
    timeout: 30000,
    headers: {
      'Content-Type': 'application/json'
    }
  });

  // Adicionar auth se necessário
  const token = process.env.TEST_TOKEN;
  if (token) {
    api.defaults.headers.common['Authorization'] = `Bearer ${token}`;
  }

  return { api };
}

// Aguardar worker processar
export async function waitForWorker(queueName, timeout = 10000) {
  const redis = new Redis(REDIS_URL);
  const queue = new Queue(queueName, { connection: redis });
  
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    const waiting = await queue.getWaitingCount();
    const active = await queue.getActiveCount();
    
    if (waiting === 0 && active === 0) {
      await redis.quit();
      return true; // Fila vazia, workers processaram
    }
    
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  await redis.quit();
  console.warn(`⚠️  Timeout aguardando ${queueName}`);
  return false;
}

// Limpar dados de teste
export async function cleanupTestData(testData) {
  const { doctor, patient } = testData;
  
  if (!doctor || !patient) return;
  
  try {
    // Importar models dinamicamente para evitar circular dependency
    const { default: Appointment } = await import('../../models/Appointment.js');
    const { default: Payment } = await import('../../models/Payment.js');
    const { default: Session } = await import('../../models/Session.js');
    const { default: Doctor } = await import('../../models/Doctor.js');
    const { default: Patient } = await import('../../models/Patient.js');
    
    // Limpar em ordem (dependências primeiro)
    await Payment.deleteMany({
      $or: [
        { patient: patient._id },
        { doctor: doctor._id }
      ]
    });
    
    await Session.deleteMany({
      $or: [
        { patient: patient._id },
        { doctor: doctor._id }
      ]
    });
    
    await Appointment.deleteMany({
      $or: [
        { patient: patient._id },
        { doctor: doctor._id }
      ]
    });
    
    await Patient.deleteOne({ _id: patient._id });
    await Doctor.deleteOne({ _id: doctor._id });
    
  } catch (error) {
    console.error('Erro ao limpar dados de teste:', error.message);
  }
}

// Fixture Factory
export class FixtureFactory {
  constructor(models) {
    this.models = models;
    this.created = [];
  }

  async createDoctor(data = {}) {
    const doctor = await this.models.Doctor.create({
      fullName: `Dr. Teste ${Date.now()}`,
      email: `dr.teste.${Date.now()}@test.com`,
      specialty: 'fonoaudiologia',
      cpf: String(Math.floor(Math.random() * 99999999999)).padStart(11, '0'),
      phone: '61999999999',
      status: 'active',
      ...data
    });
    
    this.created.push({ model: 'Doctor', id: doctor._id });
    return doctor;
  }

  async createPatient(data = {}) {
    const patient = await this.models.Patient.create({
      fullName: `Paciente Teste ${Date.now()}`,
      email: `paciente.teste.${Date.now()}@test.com`,
      phone: '61988888888',
      cpf: String(Math.floor(Math.random() * 99999999999)).padStart(11, '0'),
      ...data
    });
    
    this.created.push({ model: 'Patient', id: patient._id });
    return patient;
  }

  async createAppointment(data = {}) {
    const appointment = await this.models.Appointment.create({
      date: new Date(),
      time: '14:00',
      specialty: 'fonoaudiologia',
      serviceType: 'individual_session',
      operationalStatus: 'scheduled',
      clinicalStatus: 'pending',
      sessionValue: 150,
      paymentMethod: 'dinheiro',
      billingType: 'particular',
      ...data
    });
    
    this.created.push({ model: 'Appointment', id: appointment._id });
    return appointment;
  }

  async cleanup() {
    // Limpar na ordem inversa
    for (const item of this.created.reverse()) {
      try {
        await this.models[item.model].deleteOne({ _id: item.id });
      } catch (e) {
        console.warn(`Erro ao deletar ${item.model} ${item.id}:`, e.message);
      }
    }
  }
}

// Assert helpers
export const assert = {
  equals: (actual, expected, message) => {
    if (actual !== expected) {
      throw new Error(
        message || `Esperado ${expected}, mas recebeu ${actual}`
      );
    }
  },
  
  exists: (value, message) => {
    if (value === null || value === undefined) {
      throw new Error(message || 'Valor deveria existir, mas é null/undefined');
    }
  },
  
  notExists: (value, message) => {
    if (value !== null && value !== undefined) {
      throw new Error(message || `Valor deveria ser null/undefined, mas é ${value}`);
    }
  },
  
  includes: (haystack, needle, message) => {
    if (!haystack.includes(needle)) {
      throw new Error(
        message || `"${haystack}" deveria conter "${needle}"`
      );
    }
  },
  
  isTrue: (value, message) => {
    if (value !== true) {
      throw new Error(message || `Esperado true, mas recebeu ${value}`);
    }
  }
};

// Logger para testes
export function createTestLogger(testName) {
  return {
    step: (msg) => console.log(`  [${testName}] ${msg}`),
    success: (msg) => console.log(`  ✅ [${testName}] ${msg}`),
    error: (msg) => console.log(`  ❌ [${testName}] ${msg}`),
    warn: (msg) => console.log(`  ⚠️  [${testName}] ${msg}`),
    info: (msg) => console.log(`  ℹ️  [${testName}] ${msg}`)
  };
}
