/**
 * PATCH /api/v2/patients/:id/status: ao inativar, cancela as sessões futuras
 * na mesma transação (Kadu, 11/11/2026). Versão com mocks para rodar no CI;
 * o fluxo real com Mongo está em tests/integration/patient-inactivation-cancels-agenda.test.js.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import express from 'express';
import request from 'supertest';

const PATIENT_ID = new mongoose.Types.ObjectId();
const APPT_IDS = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];

const patientUpdateOne = vi.fn().mockResolvedValue({ modifiedCount: 1 });
const apptFind = vi.fn();
const apptCount = vi.fn().mockResolvedValue(0);
const bulkCancel = vi.fn();

vi.mock('../../middleware/amandaAuth.js', () => ({
  flexibleAuth: (req, _res, next) => {
    req.user = { id: 'u1', role: req.headers['x-role'] || 'secretary', name: 'Recepção' };
    next();
  },
}));
vi.mock('../../models/Patient.js', () => ({
  default: {
    findById: () => ({ select: () => ({ lean: async () => ({ _id: PATIENT_ID, status: 'active' }) }) }),
    updateOne: (...a) => patientUpdateOne(...a),
  },
}));
vi.mock('../../models/Appointment.js', () => ({
  default: {
    find: (...a) => { apptFind(...a); return { select: () => ({ session: () => ({ lean: async () => APPT_IDS.map(_id => ({ _id })) }) }) }; },
    countDocuments: (...a) => apptCount(...a),
  },
}));
vi.mock('../../models/PatientsView.js', () => ({ default: { findOne: () => ({ select: () => ({ lean: async () => null }) }) } }));
vi.mock('../../domains/clinical/services/patientProjectionService.js', () => ({ buildPatientView: vi.fn().mockResolvedValue(null) }));
vi.mock('../../services/appointment/commands/bulkCancelAppointmentsCommand.js', () => ({
  executeWithSession: (...a) => bulkCancel(...a),
}));

let app;
const fakeSession = { withTransaction: async (fn) => fn(), endSession: vi.fn() };

beforeAll(async () => {
  vi.spyOn(mongoose, 'startSession').mockResolvedValue(fakeSession);
  const router = (await import('../../routes/patient.v2.js')).default;
  app = express();
  app.use(express.json());
  app.use('/api/v2/patients', router);
});

beforeEach(() => {
  patientUpdateOne.mockClear();
  apptFind.mockClear();
  bulkCancel.mockReset();
  fakeSession.endSession.mockClear();
});

describe('inativar paciente cancela a agenda futura', () => {
  it('cancela as sessões futuras com motivo e origem patient_inactivated', async () => {
    bulkCancel.mockResolvedValue({ canceled: 2, canceledIds: APPT_IDS, errors: [] });
    const res = await request(app).patch(`/api/v2/patients/${PATIENT_ID}/status`).send({ status: 'inactive', reason: 'outro' });
    expect(res.status).toBe(200);
    expect(res.body.data.canceledFutureAppointments).toBe(2);
    expect(apptFind.mock.calls[0][0].operationalStatus.$in).toEqual(['scheduled', 'confirmed', 'pre_agendado']);
    const [ids, params, , session] = bulkCancel.mock.calls[0];
    expect(ids).toEqual(APPT_IDS);
    expect(params).toMatchObject({ reason: 'Paciente inativado: Outro', cancelSource: 'patient_inactivated' });
    expect(session).toBe(fakeSession);
    expect(patientUpdateOne.mock.calls[0][2]).toEqual({ session: fakeSession });
    expect(fakeSession.endSession).toHaveBeenCalled();
  });

  it('se algum cancelamento falhar, devolve 409 e não confirma a transação', async () => {
    bulkCancel.mockResolvedValue({ canceled: 1, canceledIds: [APPT_IDS[0]], errors: [{ id: APPT_IDS[1], error: 'x' }] });
    const res = await request(app).patch(`/api/v2/patients/${PATIENT_ID}/status`).send({ status: 'inactive', reason: 'outro' });
    expect(res.status).toBe(409);
    expect(fakeSession.endSession).toHaveBeenCalled();
  });

  it('cancelFutureAppointments=false só inativa', async () => {
    const res = await request(app).patch(`/api/v2/patients/${PATIENT_ID}/status`)
      .send({ status: 'inactive', reason: 'financeiro', cancelFutureAppointments: false });
    expect(res.status).toBe(200);
    expect(bulkCancel).not.toHaveBeenCalled();
    expect(patientUpdateOne).toHaveBeenCalledTimes(1);
  });

  it('reativar não mexe na agenda', async () => {
    const res = await request(app).patch(`/api/v2/patients/${PATIENT_ID}/status`).send({ status: 'active' });
    expect(res.status).toBe(200);
    expect(bulkCancel).not.toHaveBeenCalled();
  });
});
