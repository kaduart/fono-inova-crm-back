/**
 * E2E V2 - Testes com MongoDB Atlas
 * 
 * Usa banco crm_development (Atlas)
 * Cria dados reais e limpa após teste
 * INICIA WORKERS para processar eventos
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import Patient from '../../../models/Patient.js';
import { publishEvent } from '../../../infrastructure/events/eventPublisher.js';
import { buildPatientView } from '../../../domains/clinical/services/patientProjectionService.js';

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';

describe('🧪 V2 E2E - Atlas', () => {
  
  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    console.log('✅ Conectado ao Atlas');
  });

  afterAll(async () => {
    await mongoose.disconnect();
    console.log('✅ Desconectado');
  });

  it('Cria paciente + publica evento + processa projeção + verifica view', async () => {
    // 1. Cria paciente no modelo (dados reais)
    const patient = await Patient.create({
      fullName: 'E2E Test Patient',
      email: `e2e_${Date.now()}@test.com`,
      phone: '11999999999',
      dateOfBirth: new Date('1990-01-01')
    });

    console.log('✅ Paciente criado:', patient._id.toString());

    // 2. Publica evento
    const eventResult = await publishEvent('PATIENT_CREATED', {
      patientId: patient._id.toString(),
      fullName: patient.fullName,
      email: patient.email
    });

    console.log('✅ Evento publicado:', eventResult.eventId);

    // 3. PROCESSA a projeção diretamente (simula o worker)
    // Isso garante que o teste não depende do worker estar rodando em background
    const view = await buildPatientView(patient._id.toString(), {
      correlationId: eventResult.correlationId
    });

    console.log('✅ View construída:', view ? 'sucesso' : 'falha');

    // 4. Verifica view foi criada
    expect(view).toBeTruthy();
    expect(view.fullName).toBe('E2E Test Patient');
    expect(view.patientId.toString()).toBe(patient._id.toString());
    
    console.log('✅ View validada:', {
      fullName: view.fullName,
      patientId: view.patientId.toString(),
      version: view.snapshot?.version
    });

    // 5. Limpa (apaga paciente e view)
    await Patient.deleteOne({ _id: patient._id });
    await mongoose.connection.db.collection('patients_view')
      .deleteOne({ patientId: patient._id });
    console.log('✅ Limpo');
  }, 30000);

  it('Fluxo completo: evento → projeção → leitura da view', async () => {
    // 1. Cria paciente
    const patient = await Patient.create({
      fullName: 'Fluxo Completo Test',
      email: `fluxo_${Date.now()}@test.com`,
      phone: '11888888888',
      dateOfBirth: new Date('1985-05-15')
    });

    // 2. Publica evento
    await publishEvent('PATIENT_CREATED', {
      patientId: patient._id.toString(),
      fullName: patient.fullName,
      email: patient.email
    });

    // 3. Processa projeção
    await buildPatientView(patient._id.toString());

    // 4. Lê da view (simula query do frontend)
    const viewFromDb = await mongoose.connection.db.collection('patients_view')
      .findOne({ patientId: patient._id });

    // 5. Validações
    expect(viewFromDb).toBeTruthy();
    expect(viewFromDb.fullName).toBe('Fluxo Completo Test');
    expect(viewFromDb.email).toBe(patient.email);
    expect(viewFromDb.snapshot).toBeTruthy();
    expect(viewFromDb.snapshot.version).toBeGreaterThanOrEqual(1);

    // 6. Limpa
    await Patient.deleteOne({ _id: patient._id });
    await mongoose.connection.db.collection('patients_view')
      .deleteOne({ patientId: patient._id });
  }, 30000);
});
