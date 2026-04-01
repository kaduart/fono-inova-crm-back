/**
 * E2E V2 - Replay Tests
 * 
 * Testa reconstrução do sistema a partir do event store
 * Usa buildPatientView diretamente (não depende de workers rodando)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import Patient from '../../../models/Patient.js';
import { publishEvent } from '../../../infrastructure/events/eventPublisher.js';
import { buildPatientView } from '../../../domains/clinical/services/patientProjectionService.js';

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';

describe('🔄 V2 Replay Tests', () => {
  
  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  it('Rebuild: apaga view e reconstrói do evento', async () => {
    // 1. Cria paciente e processa projeção
    const patient = await Patient.create({
      fullName: 'Replay Test',
      email: `replay_${Date.now()}@test.com`,
      phone: '11999999999',
      dateOfBirth: new Date('1990-01-01')
    });

    await publishEvent('PATIENT_CREATED', {
      patientId: patient._id.toString(),
      fullName: patient.fullName
    });

    // Processa projeção inicial
    await buildPatientView(patient._id.toString());

    // 2. Captura view original
    const originalView = await mongoose.connection.db.collection('patients_view')
      .findOne({ patientId: patient._id });
    expect(originalView).toBeTruthy();

    // 3. Apaga view (simula desastre)
    await mongoose.connection.db.collection('patients_view')
      .deleteOne({ patientId: patient._id });

    // 4. Re-processa projeção (simula replay)
    await buildPatientView(patient._id.toString());

    // 5. Verifica view reconstruída
    const rebuiltView = await mongoose.connection.db.collection('patients_view')
      .findOne({ patientId: patient._id });

    expect(rebuiltView).toBeTruthy();
    expect(rebuiltView.fullName).toBe(originalView.fullName);
    expect(rebuiltView.patientId.toString()).toBe(originalView.patientId.toString());

    // Limpa
    await Patient.deleteOne({ _id: patient._id });
    await mongoose.connection.db.collection('patients_view')
      .deleteMany({ patientId: patient._id });
  }, 20000);

  it('Determinismo: mesmo evento = mesmo resultado', async () => {
    const patient = await Patient.create({
      fullName: 'Deterministic Test',
      email: `det_${Date.now()}@test.com`,
      phone: '11999999999',
      dateOfBirth: new Date('1990-01-01')
    });

    // Primeiro processamento
    await publishEvent('PATIENT_CREATED', {
      patientId: patient._id.toString(),
      fullName: patient.fullName
    });

    await buildPatientView(patient._id.toString());

    const view1 = await mongoose.connection.db.collection('patients_view')
      .findOne({ patientId: patient._id });

    // Apaga e re-processa
    await mongoose.connection.db.collection('patients_view')
      .deleteOne({ patientId: patient._id });

    await buildPatientView(patient._id.toString());

    const view2 = await mongoose.connection.db.collection('patients_view')
      .findOne({ patientId: patient._id });

    // Mesmo resultado
    expect(view2.fullName).toBe(view1.fullName);
    expect(view2.patientId.toString()).toBe(view1.patientId.toString());

    // Limpa
    await Patient.deleteOne({ _id: patient._id });
    await mongoose.connection.db.collection('patients_view')
      .deleteMany({ patientId: patient._id });
  }, 20000);

  it('Event sourcing: múltiplos eventos geram projeção correta', async () => {
    const patient = await Patient.create({
      fullName: 'Event Sourcing Test',
      email: `es_${Date.now()}@test.com`,
      phone: '11999999999',
      dateOfBirth: new Date('1990-01-01')
    });

    // Publica múltiplos eventos
    const result1 = await publishEvent('PATIENT_CREATED', {
      patientId: patient._id.toString(),
      fullName: patient.fullName
    });

    const result2 = await publishEvent('PATIENT_UPDATED', {
      patientId: patient._id.toString(),
      updates: { phone: '11777777777' }
    });

    // Verifica que eventos foram publicados
    expect(result1.eventId).toBeTruthy();
    expect(result2.eventId).toBeTruthy();

    // Processa projeção
    await buildPatientView(patient._id.toString());

    // Verifica view foi criada
    const view = await mongoose.connection.db.collection('patients_view')
      .findOne({ patientId: patient._id });
    expect(view).toBeTruthy();
    expect(view.fullName).toBe('Event Sourcing Test');

    // Limpa
    await Patient.deleteOne({ _id: patient._id });
    await mongoose.connection.db.collection('patients_view')
      .deleteMany({ patientId: patient._id });
  }, 20000);
});
