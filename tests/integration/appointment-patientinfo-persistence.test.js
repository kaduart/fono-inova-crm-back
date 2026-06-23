/**
 * Smoke Test — Persistência de patientInfo no Update de Agendamento
 *
 * Bug corrigido: sanitizeAppointmentPayload descartava patientInfo silenciosamente.
 * O DTO mascarava o bug retornando dados do Patient populado como se tivessem sido salvos.
 *
 * Cobertura:
 *  Teste 1 — Editar somente telefone (merge: fullName deve ser preservado)
 *  Teste 2 — Editar somente nome (merge: phone deve ser preservado)
 *  Teste 3 — Editar todos os campos de contato
 *  Teste 4 — Appointment sem patient vinculado (pré-agendamento / órfão)
 *  Teste 5 — Outros campos editáveis (notes, date, time) não são afetados
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

// vi.mock é hoisted — intercepta antes de qualquer import real
vi.mock('../../services/syncService.js', () => ({
  syncEvent: vi.fn().mockResolvedValue(undefined),
  handlePackageSessionUpdate: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../services/appointmentStateOrchestrator.js', () => ({
  appointmentStateOrchestrator: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../services/projections/syncAffectedViews.js', () => ({
  syncAffectedViews: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../services/appointment/helpers/socketHelper.js', () => ({
  emitSocket: vi.fn().mockResolvedValue(undefined),
}));

let replSet;
let Patient;
let Appointment;
let updateCmd;

beforeAll(async () => {
  // Replica set de 1 nó — necessário para suporte a transações MongoDB
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri());

  Patient     = (await import('../../models/Patient.js')).default;
  Appointment = (await import('../../models/Appointment.js')).default;
  // Doctor precisa ser registrado no mongoose antes do DTO tentar popular
  await import('../../models/Doctor.js');
  updateCmd   = (await import('../../services/appointment/commands/updateAppointmentCommand.js')).default;
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet.stop();
});

// ─── Helper ─────────────────────────────────────────────────────────────────

async function createTestData(patientOverrides = {}, appointmentOverrides = {}) {
  const patient = await Patient.create({
    fullName:    patientOverrides.fullName    ?? 'Paciente Original',
    phone:       patientOverrides.phone       ?? '62911111111',
    email:       patientOverrides.email       ?? 'original@test.com',
    dateOfBirth: patientOverrides.dateOfBirth ?? new Date('1985-03-15'),
  });

  const fakeDoctor = new mongoose.Types.ObjectId();

  const appointment = await Appointment.create({
    date:              '2026-07-01',
    time:              '10:00',
    patient:           patient._id,
    doctor:            fakeDoctor,
    operationalStatus: 'scheduled',
    specialty:         'fonoaudiologia',
    patientInfo: {
      fullName:  patient.fullName,
      phone:     patient.phone,
      email:     patient.email,
      birthDate: '1985-03-15',
    },
    ...appointmentOverrides,
  });

  return { patient, appointment };
}

const adminUser = () => ({ _id: new mongoose.Types.ObjectId(), role: 'admin' });

// ─── Testes ─────────────────────────────────────────────────────────────────

describe('Smoke Test — Persistência de patientInfo no Update de Agendamento', () => {

  // ── Teste 1 ─────────────────────────────────────────────────────────────

  describe('Teste 1 — Editar somente telefone', () => {
    it('persiste phone no Patient e preserva fullName no snapshot', async () => {
      const { patient, appointment } = await createTestData();

      const antes = {
        'Patient.phone':                  patient.phone,
        'Appointment.patientInfo.phone':  appointment.patientInfo.phone,
        'Appointment.patientInfo.fullName': appointment.patientInfo.fullName,
      };

      const payload = { patientInfo: { phone: '62999999999' } };

      await updateCmd.execute(appointment._id.toString(), payload, adminUser());

      const patientDepois     = await Patient.findById(patient._id).lean();
      const appointmentDepois = await Appointment.findById(appointment._id).lean();

      console.log('\n[Teste 1] ANTES:', antes);
      console.log('[Teste 1] PAYLOAD:', payload);
      console.log('[Teste 1] DEPOIS:', {
        'Patient.phone':                    patientDepois.phone,
        'Appointment.patientInfo.phone':    appointmentDepois.patientInfo.phone,
        'Appointment.patientInfo.fullName': appointmentDepois.patientInfo.fullName,
      });

      // Phone atualizado no Patient (SSOT)
      expect(patientDepois.phone).toBe('62999999999');
      // Phone atualizado no snapshot do Appointment
      expect(appointmentDepois.patientInfo.phone).toBe('62999999999');
      // fullName NÃO apagado (merge, não overwrite)
      expect(appointmentDepois.patientInfo.fullName).toBe('Paciente Original');
    });
  });

  // ── Teste 2 ─────────────────────────────────────────────────────────────

  describe('Teste 2 — Editar somente nome', () => {
    it('persiste fullName no Patient e preserva phone no snapshot', async () => {
      const { patient, appointment } = await createTestData();

      const payload = { patientInfo: { fullName: 'Paciente Novo Nome' } };

      await updateCmd.execute(appointment._id.toString(), payload, adminUser());

      const patientDepois     = await Patient.findById(patient._id).lean();
      const appointmentDepois = await Appointment.findById(appointment._id).lean();

      console.log('\n[Teste 2] Patient.fullName após:', patientDepois.fullName);
      console.log('[Teste 2] patientInfo.phone preservado:', appointmentDepois.patientInfo.phone);

      expect(patientDepois.fullName).toBe('Paciente Novo Nome');
      expect(appointmentDepois.patientInfo.fullName).toBe('Paciente Novo Nome');
      // phone não foi enviado — deve ser preservado no snapshot
      expect(appointmentDepois.patientInfo.phone).toBe('62911111111');
    });
  });

  // ── Teste 3 ─────────────────────────────────────────────────────────────

  describe('Teste 3 — Editar todos os campos de contato', () => {
    it('persiste fullName, phone, email e birthDate no Patient e no snapshot', async () => {
      const { patient, appointment } = await createTestData();

      const antes = {
        fullName:  patient.fullName,
        phone:     patient.phone,
        email:     patient.email,
      };

      const payload = {
        patientInfo: {
          fullName:  'João Silva Editado',
          phone:     '62988888888',
          email:     'joao.novo@test.com',
          birthDate: '1990-06-20',
        },
      };

      await updateCmd.execute(appointment._id.toString(), payload, adminUser());

      const patientDepois     = await Patient.findById(patient._id).lean();
      const appointmentDepois = await Appointment.findById(appointment._id).lean();

      console.log('\n[Teste 3] ANTES (Patient):', antes);
      console.log('[Teste 3] PAYLOAD.patientInfo:', payload.patientInfo);
      console.log('[Teste 3] DEPOIS (Patient):', {
        fullName: patientDepois.fullName,
        phone:    patientDepois.phone,
        email:    patientDepois.email,
        dateOfBirth: patientDepois.dateOfBirth,
      });
      console.log('[Teste 3] DEPOIS (snapshot):', appointmentDepois.patientInfo);

      expect(patientDepois.fullName).toBe('João Silva Editado');
      expect(patientDepois.phone).toBe('62988888888');
      expect(patientDepois.email).toBe('joao.novo@test.com');
      expect(new Date(patientDepois.dateOfBirth).getFullYear()).toBe(1990);

      expect(appointmentDepois.patientInfo.fullName).toBe('João Silva Editado');
      expect(appointmentDepois.patientInfo.phone).toBe('62988888888');
      expect(appointmentDepois.patientInfo.email).toBe('joao.novo@test.com');
    });
  });

  // ── Teste 4 ─────────────────────────────────────────────────────────────

  describe('Teste 4 — Appointment sem patient vinculado (pré-agendamento / órfão)', () => {
    it('atualiza snapshot sem erro quando patient === null', async () => {
      const appointment = await Appointment.create({
        date:              '2026-07-02',
        time:              '11:00',
        operationalStatus: 'pre_agendado',
        specialty:         'fonoaudiologia',
        patientInfo: {
          fullName: 'Lead Sem Cadastro',
          phone:    '62977777777',
        },
      });

      const payload = {
        patientInfo: {
          phone:    '62966666666',
          fullName: 'Lead Atualizado',
        },
      };

      await expect(
        updateCmd.execute(appointment._id.toString(), payload, adminUser())
      ).resolves.toBeDefined();

      const appointmentDepois = await Appointment.findById(appointment._id).lean();

      console.log('\n[Teste 4] patientInfo snapshot (órfão):', appointmentDepois.patientInfo);

      // Snapshot deve ser atualizado mesmo sem patient vinculado
      expect(appointmentDepois.patientInfo.phone).toBe('62966666666');
      expect(appointmentDepois.patientInfo.fullName).toBe('Lead Atualizado');
    });
  });

  // ── Teste 5 ─────────────────────────────────────────────────────────────

  describe('Teste 5 — Outros campos editáveis não são afetados pelo fix', () => {
    it('notes, responsible, date e time continuam persistindo normalmente', async () => {
      const { appointment } = await createTestData();

      const payload = {
        notes:       'Observação nova do smoke test',
        responsible: 'Secretária Teste',
        date:        '2026-08-15',
        time:        '14:30',
        patientInfo: { phone: '62955555555' },
      };

      await updateCmd.execute(appointment._id.toString(), payload, adminUser());

      const appointmentDepois = await Appointment.findById(appointment._id).lean();

      console.log('\n[Teste 5] Campos gerais após update:', {
        notes:       appointmentDepois.notes,
        responsible: appointmentDepois.responsible,
        date:        appointmentDepois.date,
        time:        appointmentDepois.time,
        'patientInfo.phone': appointmentDepois.patientInfo.phone,
      });

      expect(appointmentDepois.notes).toBe('Observação nova do smoke test');
      expect(appointmentDepois.responsible).toBe('Secretária Teste');
      expect(new Date(appointmentDepois.date).toISOString()).toContain('2026-08-15');
      expect(appointmentDepois.time).toBe('14:30');
      expect(appointmentDepois.patientInfo.phone).toBe('62955555555');
    });
  });
});
