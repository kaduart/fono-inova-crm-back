import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flexibleAuth, isAgendaServiceRequestAllowed } from '../../middleware/amandaAuth.js';

const originalEnv = {
  agenda: process.env.AGENDA_EXPORT_TOKEN,
  admin: process.env.ADMIN_API_TOKEN,
};

function req(method, originalUrl, token = 'agenda-test-token') {
  return {
    method,
    originalUrl,
    headers: { authorization: `Bearer ${token}` },
  };
}

function response() {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
}

beforeEach(() => {
  process.env.AGENDA_EXPORT_TOKEN = 'agenda-test-token';
  process.env.ADMIN_API_TOKEN = 'amanda-test-token';
});

afterEach(() => {
  if (originalEnv.agenda === undefined) delete process.env.AGENDA_EXPORT_TOKEN;
  else process.env.AGENDA_EXPORT_TOKEN = originalEnv.agenda;
  if (originalEnv.admin === undefined) delete process.env.ADMIN_API_TOKEN;
  else process.env.ADMIN_API_TOKEN = originalEnv.admin;
});

describe('flexibleAuth — escopo mínimo do agenda-service', () => {
  it.each([
    ['GET', '/api/v2/appointments?startDate=2026-08-01'],
    ['GET', '/api/v2/appointments/507f1f77bcf86cd799439011'],
    ['GET', '/api/v2/appointments/available-slots?doctorId=507f1f77bcf86cd799439011'],
    ['POST', '/api/v2/appointments'],
    ['POST', '/api/v2/appointments/507f1f77bcf86cd799439011/reschedule'],
    ['PUT', '/api/v2/appointments/507f1f77bcf86cd799439011'],
    ['PATCH', '/api/v2/appointments/507f1f77bcf86cd799439011/admin-edit'],
    ['PATCH', '/api/v2/appointments/507f1f77bcf86cd799439011/cancel'],
    ['PATCH', '/api/v2/appointments/507f1f77bcf86cd799439011/confirm'],
    ['PATCH', '/api/v2/appointments/507f1f77bcf86cd799439011/post-appointment'],
    ['DELETE', '/api/v2/appointments/507f1f77bcf86cd799439011'],
    ['GET', '/api/v2/packages?patientId=507f1f77bcf86cd799439011'],
    ['DELETE', '/api/v2/packages/pkg1/sessions/session1'],
    ['PATCH', '/api/v2/packages/pkg1/sessions/session1/cancel'],
    ['GET', '/api/v2/patients?limit=1000'],
    ['PUT', '/api/v2/patients/507f1f77bcf86cd799439011'],
    ['GET', '/api/v2/doctors/active'],
    ['POST', '/api/v2/doctors'],
    ['DELETE', '/api/v2/doctors/507f1f77bcf86cd799439011'],
    ['GET', '/api/reminders'],
    ['GET', '/api/reminders/507f1f77bcf86cd799439011'],
    ['POST', '/api/reminders'],
    ['PATCH', '/api/reminders/507f1f77bcf86cd799439011'],
  ])('permite %s %s', (method, path) => {
    expect(isAgendaServiceRequestAllowed(req(method, path))).toBe(true);
  });

  it.each([
    ['GET', '/api/v2/evolutions/507f1f77bcf86cd799439011'],
    ['GET', '/api/v2/appointments/weekly-availability?startDate=2026-08-10'],
    ['DELETE', '/api/v2/evolutions/507f1f77bcf86cd799439011'],
    ['POST', '/api/v2/patients/admin/rebuild-all'],
    ['DELETE', '/api/v2/patients/507f1f77bcf86cd799439011'],
    ['GET', '/api/v2/packages/507f1f77bcf86cd799439011/debug'],
    ['PATCH', '/api/v2/appointments/507f1f77bcf86cd799439011/complete'],
  ])('nega %s %s', (method, path) => {
    expect(isAgendaServiceRequestAllowed(req(method, path))).toBe(false);
  });

  it('atribui identidade não administrativa quando a rota está no escopo', () => {
    const request = req('POST', '/api/v2/appointments');
    const res = response();
    const next = vi.fn();

    flexibleAuth(request, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(request.user).toEqual({
      id: 'agenda-service',
      role: 'agenda_service',
      isService: true,
    });
  });

  it('responde 403 sem chamar next fora do escopo', () => {
    const request = req('DELETE', '/api/v2/evolutions/507f1f77bcf86cd799439011');
    const res = response();
    const next = vi.fn();

    flexibleAuth(request, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'AGENDA_SERVICE_SCOPE_DENIED',
    }));
  });

  it('mantém o token interno da Amanda como serviço admin', () => {
    const request = req('POST', '/api/v2/appointments', 'amanda-test-token');
    const res = response();
    const next = vi.fn();

    flexibleAuth(request, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(request.user).toEqual({
      id: 'amanda-service',
      role: 'admin',
      isService: true,
    });
  });
});
