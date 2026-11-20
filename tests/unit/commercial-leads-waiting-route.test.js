/**
 * GET /api/v2/commercial/leads-waiting e POST /contacts (lead_reply): fila "Lead sem resposta".
 * Versão com mocks (sem banco) para rodar no CI. Dados fictícios.
 * A regra em si está em tests/unit/commercialRules.humanWait.test.js.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import express from 'express';
import request from 'supertest';

const oid = () => new mongoose.Types.ObjectId();
const ANA = oid();
const agora = Date.now();
const minAtras = m => new Date(agora - m * 60_000);
const diasAtras = d => new Date(agora - d * 86_400_000);

const handoff = (at, extra = {}) => ({
  currentState: 'HANDOFF', autoReplyEnabled: true,
  manualControl: { active: true, takenOverAt: at, takenOverBy: null, ...extra },
  amandaAgent: { handoff: { motivo: 'pediu atendente', at } },
});

const L = {
  comAna: { _id: oid(), name: 'Lead Ana', status: 'novo', ...handoff(minAtras(10), { takenOverAt: minAtras(9), takenOverBy: ANA }) },
  agenda: { _id: oid(), name: 'Lead Agenda', status: 'novo', ...handoff(minAtras(30), { takenOverAt: minAtras(25) }) },
  ninguem: { _id: oid(), name: 'Lead Ninguém', status: 'novo', ...handoff(minAtras(40)) },
  falhou: { _id: oid(), name: 'Lead Envio Falhou', status: 'novo', ...handoff(minAtras(50)) },
  respondido: { _id: oid(), name: 'Lead Respondido', status: 'novo', ...handoff(minAtras(60)) },
  marcado: { _id: oid(), name: 'Lead Marcado', status: 'novo', ...handoff(minAtras(70)) },
  marcaAntiga: { _id: oid(), name: 'Lead Marca Antiga', status: 'novo', ...handoff(minAtras(15)) },
  comAmanda: { _id: oid(), name: 'Lead Amanda', status: 'novo', currentState: 'GREETING', autoReplyEnabled: true, manualControl: { active: false } },
  antigo: { _id: oid(), name: 'Lead Encaminhado Há 5 Dias', status: 'novo', ...handoff(diasAtras(5)) },
};

const msgRows = [
  { _id: L.comAna._id, lastInboundAt: minAtras(11), lastHumanReplyAt: null, lastContent: 'oi' },
  { _id: L.agenda._id, lastInboundAt: minAtras(31), lastHumanReplyAt: null, lastContent: 'quero agendar' },
  { _id: L.ninguem._id, lastInboundAt: minAtras(41), lastHumanReplyAt: null },
  // envio falhou: nenhuma Message manual aceita é gravada, então não há lastHumanReplyAt
  { _id: L.falhou._id, lastInboundAt: minAtras(51), lastHumanReplyAt: null },
  { _id: L.respondido._id, lastInboundAt: minAtras(61), lastHumanReplyAt: minAtras(55) },
  { _id: L.marcado._id, lastInboundAt: minAtras(71), lastHumanReplyAt: null },
  { _id: L.marcaAntiga._id, lastInboundAt: minAtras(16), lastHumanReplyAt: null },
  { _id: L.comAmanda._id, lastInboundAt: minAtras(5), lastHumanReplyAt: null },
  { _id: L.antigo._id, lastInboundAt: diasAtras(5), lastHumanReplyAt: diasAtras(4) },
];
const marks = [
  { _id: L.marcado._id, at: minAtras(65), handoffAt: L.marcado.amandaAgent.handoff.at },
  { _id: L.marcaAntiga._id, at: minAtras(14), handoffAt: diasAtras(1) },
];

const leadFind = vi.fn();
const leadFindById = vi.fn();
const msgAggregate = vi.fn();
const contactCreate = vi.fn();
const contactFindOne = vi.fn();

vi.mock('../../middleware/auth.js', () => ({
  auth: (req, _res, next) => { req.user = req.headers['x-agenda'] ? undefined : { _id: 'u1', role: 'secretary' }; next(); },
  authorize: () => (_req, _res, next) => next(),
}));
vi.mock('../../config/bullConfig.js', () => ({ whatsappSendQueue: {} }));
vi.mock('../../services/appointment/attendanceConfirmation.service.js', () => ({ markAttendanceConfirmationQueued: vi.fn() }));
vi.mock('../../services/commercial/evaluationConfirmationQueues.js', () => ({
  evaluationsWithoutPackage: vi.fn(), unconfirmedNextDay: vi.fn(), confirmationReminderText: vi.fn(),
}));
vi.mock('../../services/commercial/salesSummary.js', () => ({ leadsSummary: vi.fn(), roiSummary: vi.fn(), idleSlotsBySpecialty: vi.fn() }));
vi.mock('../../models/Appointment.js', () => ({ default: {} }));
vi.mock('../../models/Patient.js', () => ({ default: {} }));
vi.mock('../../models/Package.js', () => ({ default: {} }));
vi.mock('../../models/Doctor.js', () => ({ default: {} }));
vi.mock('../../models/Leads.js', () => ({
  default: {
    find: (...a) => { leadFind(...a); return { lean: async () => Object.values(L) }; },
    findById: (...a) => ({ lean: async () => leadFindById(...a) }),
  },
}));
vi.mock('../../models/Message.js', () => ({ default: { aggregate: async (...a) => { msgAggregate(...a); return msgRows; } } }));
vi.mock('../../models/User.js', () => ({
  default: { find: () => ({ lean: async () => [{ _id: ANA, fullName: 'Ana Recepção' }] }) },
}));
vi.mock('../../models/CommercialContact.js', () => ({
  CONTACT_KINDS: ['reactivation', 'renewal', 'fit', 'lead_reply', 'evaluation', 'evaluation_lost', 'churn', 'churn_pause'],
  default: {
    aggregate: async () => marks,
    findOne: (...a) => ({ lean: async () => contactFindOne(...a) }),
    create: async (doc) => { contactCreate(doc); return { _id: oid(), ...doc }; },
  },
}));

let app;
beforeAll(async () => {
  const router = (await import('../../routes/commercial.v2.js')).default;
  app = express();
  app.use(express.json());
  app.use('/api/v2/commercial', router);
});
beforeEach(() => { vi.clearAllMocks(); contactFindOne.mockReturnValue(null); });

describe('GET /leads-waiting', () => {
  it('lista quem espera resposta humana, com responsável, e conta à parte os leads com a Amanda', async () => {
    const res = await request(app).get('/api/v2/commercial/leads-waiting');
    expect(res.status).toBe(200);
    const { items, withAmanda, minutes } = res.body.data;
    const byName = Object.fromEntries(items.map(i => [i.name, i]));

    expect(minutes).toBe(0);
    expect(withAmanda).toBe(1);
    expect(byName['Lead Amanda']).toBeUndefined();

    expect(byName['Lead Ana'].assignee).toEqual({ kind: 'atendente', id: String(ANA), name: 'Ana Recepção' });
    expect(byName['Lead Ana'].reason).toBe('handoff');
    expect(byName['Lead Ana'].waitingMinutes).toBe(10);
    expect(byName['Lead Ana'].handoffMotivo).toBe('pediu atendente');

    expect(byName['Lead Agenda'].assignee).toEqual({ kind: 'nao_identificado' });
    expect(byName['Lead Ninguém'].assignee).toEqual({ kind: 'ninguem' });
    expect(byName['Lead Envio Falhou']).toBeDefined();
    expect(byName['Lead Respondido']).toBeUndefined();
    expect(byName['Lead Marcado']).toBeUndefined();
    // marcação de outro encaminhamento não encerra o atual
    expect(byName['Lead Marca Antiga']).toBeDefined();
    // resposta dada depois de um encaminhamento antigo (fora da janela) é encontrada
    expect(byName['Lead Encaminhado Há 5 Dias']).toBeUndefined();

    // mais antigo primeiro
    const mins = items.map(i => i.waitingMinutes);
    expect([...mins].sort((a, b) => b - a)).toEqual(mins);
  });

  it('busca mensagens desde o encaminhamento mais antigo ainda aberto e só conta manual aceita', async () => {
    await request(app).get('/api/v2/commercial/leads-waiting');
    const pipeline = msgAggregate.mock.calls[0][0];
    expect(pipeline[0].$match.timestamp.$gte.getTime()).toBe(L.antigo.amandaAgent.handoff.at.getTime());
    const cond = JSON.stringify(pipeline[2].$group.lastHumanReplyAt);
    expect(cond).toContain('"manual"');
    expect(cond).toContain('["sent","delivered","read"]');
  });

  it('espera mínima: minutes=20 tira quem espera há menos; hours (front antigo) continua aceito', async () => {
    let res = await request(app).get('/api/v2/commercial/leads-waiting?minutes=20');
    expect(res.body.data.items.every(i => i.waitingMinutes >= 20)).toBe(true);
    res = await request(app).get('/api/v2/commercial/leads-waiting?hours=2');
    expect(res.body.data.minutes).toBe(120);
  });
});

describe('POST /contacts lead_reply ("Marcar como respondido")', () => {
  it('grava o encaminhamento atual e que o fechamento foi informado pela atendente', async () => {
    leadFindById.mockReturnValue(L.marcaAntiga);
    const res = await request(app).post('/api/v2/commercial/contacts')
      .send({ targetType: 'lead', targetId: String(L.marcaAntiga._id), kind: 'lead_reply' });
    expect(res.status).toBe(201);
    expect(contactCreate.mock.calls[0][0]).toMatchObject({
      kind: 'lead_reply', closure: 'informado_pela_atendente', handoffAt: L.marcaAntiga.amandaAgent.handoff.at,
    });
    // dedupe por encaminhamento: só reaproveita a marcação do mesmo encaminhamento
    expect(contactFindOne.mock.calls[0][0].handoffAt).toEqual(L.marcaAntiga.amandaAgent.handoff.at);
  });

  it('lead sem encaminhamento atual: marcação fica com handoffAt nulo', async () => {
    leadFindById.mockReturnValue(L.comAmanda);
    await request(app).post('/api/v2/commercial/contacts')
      .send({ targetType: 'lead', targetId: String(L.comAmanda._id), kind: 'lead_reply' });
    expect(contactCreate.mock.calls[0][0].handoffAt).toBeNull();
  });

  it('recusa lead_reply para paciente e lead inexistente', async () => {
    let res = await request(app).post('/api/v2/commercial/contacts')
      .send({ targetType: 'patient', targetId: String(oid()), kind: 'lead_reply' });
    expect(res.status).toBe(400);
    leadFindById.mockReturnValue(null);
    res = await request(app).post('/api/v2/commercial/contacts')
      .send({ targetType: 'lead', targetId: String(oid()), kind: 'lead_reply' });
    expect(res.status).toBe(404);
    expect(contactCreate).not.toHaveBeenCalled();
  });
});
