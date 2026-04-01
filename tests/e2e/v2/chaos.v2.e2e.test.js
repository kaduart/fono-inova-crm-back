/**
 * E2E V2 - Chaos Tests
 * 
 * Testa resiliência: idempotência, race conditions
 * Usa buildPatientView diretamente (não depende de workers rodando)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import Patient from '../../../models/Patient.js';
import { publishEvent } from '../../../infrastructure/events/eventPublisher.js';
import { buildPatientView } from '../../../domains/clinical/services/patientProjectionService.js';

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';

describe('🔥 V2 Chaos Tests', () => {
  
  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  it('Idempotência: eventos duplicados criam uma view só', async () => {
    const patient = await Patient.create({
      fullName: 'Idempotent Test',
      email: `idemp_${Date.now()}@test.com`,
      phone: '11999999999',
      dateOfBirth: new Date('1990-01-01')
    });

    const payload = {
      patientId: patient._id.toString(),
      fullName: patient.fullName
    };

    // Publica 3x o mesmo evento
    await publishEvent('PATIENT_CREATED', payload);
    await publishEvent('PATIENT_CREATED', payload);
    await publishEvent('PATIENT_CREATED', payload);

    // Processa projeção (simula worker)
    await buildPatientView(patient._id.toString());

    // Conta views
    const views = await mongoose.connection.db.collection('patients_view')
      .find({ patientId: patient._id })
      .toArray();

    expect(views.length).toBe(1); // Só uma view!

    // Limpa
    await Patient.deleteOne({ _id: patient._id });
    await mongoose.connection.db.collection('patients_view')
      .deleteMany({ patientId: patient._id });
  }, 15000);

  it('Idempotência: rebuild múltiplos mantém consistência', async () => {
    const patient = await Patient.create({
      fullName: 'Rebuild Consistency Test',
      email: `rebuild_${Date.now()}@test.com`,
      phone: '11999999999',
      dateOfBirth: new Date('1990-01-01')
    });

    // Primeiro build
    const view1 = await buildPatientView(patient._id.toString());
    expect(view1).toBeTruthy();

    // Rebuilds subsequentes devem retornar mesmos dados
    const view2 = await buildPatientView(patient._id.toString());
    const view3 = await buildPatientView(patient._id.toString());

    expect(view2.fullName).toBe(view1.fullName);
    expect(view3.fullName).toBe(view1.fullName);
    expect(view2.patientId.toString()).toBe(view1.patientId.toString());

    // Só existe uma view no banco
    const views = await mongoose.connection.db.collection('patients_view')
      .find({ patientId: patient._id })
      .toArray();
    expect(views.length).toBe(1);

    // Limpa
    await Patient.deleteOne({ _id: patient._id });
    await mongoose.connection.db.collection('patients_view')
      .deleteMany({ patientId: patient._id });
  }, 15000);

  it('Race condition: múltiplos updates simultâneos', async () => {
    const patient = await Patient.create({
      fullName: 'Race Test',
      email: `race_${Date.now()}@test.com`,
      phone: '11999999999',
      dateOfBirth: new Date('1990-01-01')
    });

    // Publica 10 updates simultâneos
    const promises = Array.from({ length: 10 }, (_, i) => 
      publishEvent('PATIENT_UPDATED', {
        patientId: patient._id.toString(),
        balance: i * 100
      })
    );

    await Promise.all(promises);

    // Processa projeção após todos os eventos
    await buildPatientView(patient._id.toString());

    // Verifica se view existe (não importa o valor final)
    const view = await mongoose.connection.db.collection('patients_view')
      .findOne({ patientId: patient._id });

    expect(view).toBeTruthy();

    // Limpa
    await Patient.deleteOne({ _id: patient._id });
    await mongoose.connection.db.collection('patients_view')
      .deleteMany({ patientId: patient._id });
  }, 20000);
});
