/**
 * Auditoria 31/10/2026 (rodada 2): rotas que respondiam sem login.
 * Garante 401 sem token, 403 para terapeuta e passagem para staff/agenda.
 * Os handlers não são executados nos casos negados (nada toca o banco).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { requireStaff, requireStaffOrAgenda } from '../../middleware/requireRole.js';
import { flexibleAuth, isAgendaServiceRequestAllowed } from '../../middleware/amandaAuth.js';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.AGENDA_EXPORT_TOKEN = 'agenda-token-test';

const tok = (role) => jwt.sign({ id: '64b000000000000000000001', role }, process.env.JWT_SECRET);

function appWith(guards) {
  const app = express();
  app.post('/api/whatsapp-web/send', ...guards, (req, res) => res.json({ ok: true, role: req.user.role }));
  app.post('/api/v2/liminar-contracts', ...guards, (req, res) => res.json({ ok: true }));
  return app;
}

describe('requireStaff / requireStaffOrAgenda', () => {
  let staffApp, agendaApp;
  beforeAll(() => {
    staffApp = appWith([flexibleAuth, requireStaff]);
    agendaApp = appWith([flexibleAuth, requireStaffOrAgenda]);
  });

  it('sem token → 401', async () => {
    const r = await request(staffApp).post('/api/v2/liminar-contracts');
    expect(r.status).toBe(401);
  });

  it('terapeuta → 403', async () => {
    const r = await request(staffApp).post('/api/v2/liminar-contracts').set('Authorization', `Bearer ${tok('doctor')}`);
    expect(r.status).toBe(403);
  });

  it('admin e secretária passam', async () => {
    for (const role of ['admin', 'secretary']) {
      const r = await request(staffApp).post('/api/v2/liminar-contracts').set('Authorization', `Bearer ${tok(role)}`);
      expect(r.status).toBe(200);
    }
  });

  it('token da agenda: envia WhatsApp, mas não mexe em liminar', async () => {
    const ok = await request(agendaApp).post('/api/whatsapp-web/send').set('Authorization', 'Bearer agenda-token-test');
    expect(ok.status).toBe(200);
    expect(ok.body.role).toBe('agenda_service');
    const denied = await request(agendaApp).post('/api/v2/liminar-contracts').set('Authorization', 'Bearer agenda-token-test');
    expect(denied.status).toBe(403);
  });

  it('escopo da agenda inclui status/envio/reconexão do WhatsApp', () => {
    const req = (method, originalUrl) => ({ method, originalUrl });
    expect(isAgendaServiceRequestAllowed(req('GET', '/api/whatsapp-web/status'))).toBe(true);
    expect(isAgendaServiceRequestAllowed(req('POST', '/api/whatsapp-vps/send'))).toBe(true);
    expect(isAgendaServiceRequestAllowed(req('POST', '/api/whatsapp-web/reconnect'))).toBe(true);
    expect(isAgendaServiceRequestAllowed(req('POST', '/api/amanda/send'))).toBe(false);
  });
});

describe('canal da Agenda com login próprio', () => {
  it('secretária logada na agenda (X-Client) é tratada como canal agenda', async () => {
    const { isAgendaChannel } = await import('../../middleware/amandaAuth.js');
    const app = express();
    app.get('/x', flexibleAuth, (req, res) => res.json({ agenda: isAgendaChannel(req.user) }));
    const withHeader = await request(app).get('/x').set('Authorization', `Bearer ${tok('secretary')}`).set('X-Client', 'agenda-externa');
    expect(withHeader.body.agenda).toBe(true);
    const erp = await request(app).get('/x').set('Authorization', `Bearer ${tok('secretary')}`);
    expect(erp.body.agenda).toBe(false);
    const doctor = await request(app).get('/x').set('Authorization', `Bearer ${tok('doctor')}`).set('X-Client', 'agenda-externa');
    expect(doctor.body.agenda).toBe(false);
  });
});
