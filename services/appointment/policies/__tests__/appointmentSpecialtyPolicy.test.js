/**
 * Testes do AppointmentSpecialtyPolicy — auditoria de 2026-07-07.
 *
 * Cobre o guard `validateDoctorSpecialty`, único ponto reutilizado por
 * createAppointmentCommand e updateAppointmentCommand. Os casos "update sem
 * trocar médico", "update trocando especialidade" e "update trocando médico"
 * são exercitados aqui através da mesma resolução de valor efetivo que
 * updateAppointmentCommand.js faz antes de chamar a política
 * (`safeBody.specialty !== undefined ? safeBody.specialty : appointment.specialty`,
 * idem pra doctor) — a política em si não sabe se é create ou update, só
 * recebe a combinação final.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { validateDoctorSpecialty } from '../appointmentSpecialtyPolicy.js';

let mongoServer;
let Doctor;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await import('../../../../models/index.js');
  Doctor = mongoose.model('Doctor');
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Doctor.collection.deleteMany({});
});

const createDoctor = (specialty) => {
  const uniqueId = new mongoose.Types.ObjectId().toString();
  return Doctor.create({
    fullName: 'Dra. Teste',
    specialty,
    email: `dra.teste.${uniqueId}@example.com`,
    phoneNumber: '11999999999',
    licenseNumber: `LIC-${uniqueId}`,
  });
};

describe('AppointmentSpecialtyPolicy — validateDoctorSpecialty', () => {
  it('médico compatível: não lança erro quando doctor.specialty === specialty', async () => {
    const doctor = await createDoctor('fonoaudiologia');

    await expect(
      validateDoctorSpecialty({ doctorId: doctor._id, specialty: 'fonoaudiologia' })
    ).resolves.toBeUndefined();
  });

  it('médico incompatível: lança DOCTOR_SPECIALTY_MISMATCH (400) quando especialidades divergem', async () => {
    const doctor = await createDoctor('psicologia');

    await expect(
      validateDoctorSpecialty({ doctorId: doctor._id, specialty: 'terapia_ocupacional' })
    ).rejects.toMatchObject({
      status: 400,
      code: 'DOCTOR_SPECIALTY_MISMATCH',
    });
  });

  it('não valida quando doctorId está ausente (deixa outro guard exigir o campo)', async () => {
    await expect(
      validateDoctorSpecialty({ doctorId: null, specialty: 'fonoaudiologia' })
    ).resolves.toBeUndefined();
  });

  it('não valida quando specialty está ausente', async () => {
    const doctor = await createDoctor('fonoaudiologia');

    await expect(
      validateDoctorSpecialty({ doctorId: doctor._id, specialty: undefined })
    ).resolves.toBeUndefined();
  });

  it('não lança erro quando o médico não existe (responsabilidade de outro guard)', async () => {
    const inexistentId = new mongoose.Types.ObjectId();

    await expect(
      validateDoctorSpecialty({ doctorId: inexistentId, specialty: 'fonoaudiologia' })
    ).resolves.toBeUndefined();
  });

  describe('cenários de update (mesma resolução de valor efetivo do updateAppointmentCommand)', () => {
    it('update sem trocar médico nem especialidade: combinação já consistente permanece válida', async () => {
      const doctor = await createDoctor('psicologia');
      // appointment existente já tinha doctor=doctor._id, specialty='psicologia';
      // payload não envia nem doctorId nem specialty -> efetivo = valores atuais
      const effectiveDoctorId = doctor._id; // appointment.doctor (mantido)
      const effectiveSpecialty = 'psicologia'; // appointment.specialty (mantido)

      await expect(
        validateDoctorSpecialty({ doctorId: effectiveDoctorId, specialty: effectiveSpecialty })
      ).resolves.toBeUndefined();
    });

    it('update trocando especialidade: nova specialty não bate com o médico mantido', async () => {
      const doctor = await createDoctor('fonoaudiologia');
      // payload manda specialty='psicologia', doctorId não é enviado -> mantém o médico atual
      const effectiveDoctorId = doctor._id; // appointment.doctor (mantido)
      const effectiveSpecialty = 'psicologia'; // safeBody.specialty (novo, do payload)

      await expect(
        validateDoctorSpecialty({ doctorId: effectiveDoctorId, specialty: effectiveSpecialty })
      ).rejects.toMatchObject({ status: 400, code: 'DOCTOR_SPECIALTY_MISMATCH' });
    });

    it('update trocando médico: novo médico não atende a especialidade mantida', async () => {
      const novoMedico = await createDoctor('terapia_ocupacional');
      // payload manda doctorId novo, specialty não é enviada -> mantém a specialty atual do appointment
      const effectiveDoctorId = novoMedico._id; // safeBody.doctorId (novo, do payload)
      const effectiveSpecialty = 'fonoaudiologia'; // appointment.specialty (mantida)

      await expect(
        validateDoctorSpecialty({ doctorId: effectiveDoctorId, specialty: effectiveSpecialty })
      ).rejects.toMatchObject({ status: 400, code: 'DOCTOR_SPECIALTY_MISMATCH' });
    });

    it('update trocando médico E especialidade de forma consistente: passa', async () => {
      const novoMedico = await createDoctor('terapia_ocupacional');
      const effectiveDoctorId = novoMedico._id;
      const effectiveSpecialty = 'terapia_ocupacional';

      await expect(
        validateDoctorSpecialty({ doctorId: effectiveDoctorId, specialty: effectiveSpecialty })
      ).resolves.toBeUndefined();
    });
  });
});
