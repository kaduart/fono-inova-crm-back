// routes/commercial.v2.js
/**
 * Filas comerciais V2 (Dashboard "Precisa de você" e Agenda). Ver docs/COMMERCIAL_QUEUES.md.
 *
 * GET  /api/v2/commercial/fit-candidates?specialty=fonoaudiologia  → encaixe de horário livre
 * GET  /api/v2/commercial/package-ending?threshold=2               → pacote acabando
 * GET  /api/v2/commercial/reactivation                             → sem próxima sessão
 * GET  /api/v2/commercial/leads-waiting?hours=2                    → lead novo sem resposta
 * POST /api/v2/commercial/contacts                                 → registra o contato feito
 *
 * Só leitura em Appointment/Patient/Package/Lead/Message. A única escrita é em
 * CommercialContact (coleção própria).
 */

import express from 'express';
import mongoose from 'mongoose';
import moment from 'moment-timezone';
import { auth, authorize } from '../middleware/auth.js';
import Appointment from '../models/Appointment.js';
import Patient from '../models/Patient.js';
import Package from '../models/Package.js';
import Doctor from '../models/Doctor.js';
import Lead from '../models/Leads.js';
import Message from '../models/Message.js';
import CommercialContact from '../models/CommercialContact.js';
import { sendApiError } from '../errors/buildErrorResponse.js';
import { leadsSummary, roiSummary, idleSlotsBySpecialty } from '../services/commercial/salesSummary.js';
import { AppError } from '../errors/AppError.js';
import {
  OPEN_LEAD_STATUSES, FUTURE_STATUSES, normalizeArea, waitingSince,
  sortFitLeads, packagesEnding, sortByRecentContact, daysBetween,
} from '../services/commercial/commercialRules.js';

const router = express.Router();
const TIMEZONE = 'America/Sao_Paulo';
const staff = [auth, authorize(['admin', 'secretary'])];

const oid = id => new mongoose.Types.ObjectId(String(id));
const clampInt = (v, def, min, max) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

async function lastContacts(targetIds, kind) {
  if (!targetIds.length) return {};
  const rows = await CommercialContact.aggregate([
    { $match: { target: { $in: targetIds.map(oid) }, ...(kind ? { kind } : {}) } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: '$target', at: { $first: '$createdAt' } } },
  ]);
  return Object.fromEntries(rows.map(r => [r._id.toString(), r.at]));
}

// Pacientes atendidos nos últimos `lookbackDays` sem nenhuma sessão futura
// (na especialidade, quando informada).
async function patientsWithoutNext({ specialty, lookbackDays = 120, minDays = 0, limit = 50 }) {
  const now = moment().tz(TIMEZONE);
  const since = now.clone().subtract(lookbackDays, 'days').startOf('day').toDate();
  const todayStart = now.clone().startOf('day').toDate();
  const specMatch = specialty ? { specialty } : {};

  const recent = await Appointment.aggregate([
    {
      $match: {
        ...specMatch,
        patient: { $exists: true, $ne: null },
        isDeleted: { $ne: true },
        operationalStatus: 'completed',
        date: { $gte: since, $lt: todayStart },
      },
    },
    { $sort: { date: -1 } },
    { $group: { _id: '$patient', lastSessionAt: { $first: '$date' }, doctor: { $first: '$doctor' }, specialty: { $first: '$specialty' } } },
  ]);
  if (!recent.length) return [];

  const ids = recent.map(r => r._id);
  const withFuture = await Appointment.distinct('patient', {
    ...specMatch,
    patient: { $in: ids },
    isDeleted: { $ne: true },
    date: { $gte: todayStart },
    operationalStatus: { $in: FUTURE_STATUSES },
  });
  const futureSet = new Set(withFuture.map(String));

  const open = recent
    .filter(r => !futureSet.has(r._id.toString()))
    .map(r => ({ ...r, daysSince: daysBetween(r.lastSessionAt, now.toDate()) }))
    .filter(r => r.daysSince >= minDays)
    .sort((a, b) => a.daysSince - b.daysSince)
    .slice(0, limit);
  if (!open.length) return [];

  const pids = open.map(r => r._id);
  const [patients, doctors, contacts] = await Promise.all([
    Patient.find({ _id: { $in: pids } }, { fullName: 1, phone: 1 }).lean(),
    Doctor.find({ _id: { $in: open.map(r => r.doctor).filter(Boolean) } }, { fullName: 1 }).lean(),
    lastContacts(pids),
  ]);
  const pMap = Object.fromEntries(patients.map(p => [p._id.toString(), p]));
  const dMap = Object.fromEntries(doctors.map(d => [d._id.toString(), d.fullName]));

  return open
    .filter(r => pMap[r._id.toString()])
    .map(r => {
      const id = r._id.toString();
      return {
        patientId: id,
        name: pMap[id].fullName || 'Paciente',
        phone: pMap[id].phone || '',
        specialty: r.specialty || null,
        doctorId: r.doctor ? r.doctor.toString() : null,
        doctorName: r.doctor ? dMap[r.doctor.toString()] || null : null,
        lastSessionAt: r.lastSessionAt,
        daysSince: r.daysSince,
        lastContactAt: contacts[id] || null,
      };
    });
}

router.get('/fit-candidates', ...staff, async (req, res) => {
  try {
    const specialty = normalizeArea(req.query.specialty);
    if (!specialty) {
      return sendApiError(res, new AppError('BAD_REQUEST', 'Informe a especialidade do horário.', { status: 400 }), req);
    }
    const limit = clampInt(req.query.limit, 8, 1, 20);
    const since = moment().tz(TIMEZONE).subtract(60, 'days').toDate();

    // therapyArea do lead vem livre (Amanda, site, planilha): filtra no código, não no Mongo
    const rawLeads = await Lead.find(
      {
        status: { $in: OPEN_LEAD_STATUSES },
        convertedToPatient: { $in: [null, undefined] },
        therapyArea: { $nin: [null, ''] },
        lastInteractionAt: { $gte: since },
      },
      { name: 1, contact: 1, therapyArea: 1, status: 1, lastInteractionAt: 1, createdAt: 1 },
    ).sort({ lastInteractionAt: -1 }).limit(300).lean();

    const leadsMatched = sortFitLeads(rawLeads.filter(l => normalizeArea(l.therapyArea) === specialty)).slice(0, limit);
    const leadContacts = await lastContacts(leadsMatched.map(l => l._id), 'fit');
    const leads = leadsMatched.map(l => ({
      leadId: l._id.toString(),
      name: l.name || 'Lead sem nome',
      phone: l.contact?.phone || '',
      status: l.status,
      lastInteractionAt: l.lastInteractionAt || l.createdAt,
      lastContactAt: leadContacts[l._id.toString()] || null,
    }));

    const patients = await patientsWithoutNext({ specialty, lookbackDays: 120, minDays: 0, limit });

    res.json({ success: true, data: { specialty, leads, patients } });
  } catch (err) {
    console.error('[commercial.v2] /fit-candidates error:', err);
    sendApiError(res, err, req);
  }
});

router.get('/package-ending', ...staff, async (req, res) => {
  try {
    const threshold = clampInt(req.query.threshold, 2, 0, 5);
    // Convênio e liminar não renovam pacote (legado em Package, ver comentário no model)
    const active = await Package.find(
      { status: 'active', type: { $nin: ['convenio', 'liminar'] } },
      { patient: 1, doctor: 1, specialty: 1, totalSessions: 1, sessionsDone: 1, sessionValue: 1 },
    ).lean();

    const ending = packagesEnding(active, threshold);
    if (!ending.length) return res.json({ success: true, data: { threshold, items: [] } });

    const pids = [...new Set(ending.map(e => e.pkg.patient.toString()))].map(oid);
    const todayStart = moment().tz(TIMEZONE).startOf('day').toDate();
    const [patients, doctors, nextAppts, contacts] = await Promise.all([
      Patient.find({ _id: { $in: pids } }, { fullName: 1, phone: 1 }).lean(),
      Doctor.find({ _id: { $in: ending.map(e => e.pkg.doctor).filter(Boolean) } }, { fullName: 1 }).lean(),
      Appointment.find(
        { patient: { $in: pids }, isDeleted: { $ne: true }, date: { $gte: todayStart }, operationalStatus: { $in: FUTURE_STATUSES } },
        { patient: 1, date: 1, time: 1, specialty: 1 },
      ).sort({ date: 1 }).lean(),
      lastContacts(pids, 'renewal'),
    ]);
    const pMap = Object.fromEntries(patients.map(p => [p._id.toString(), p]));
    const dMap = Object.fromEntries(doctors.map(d => [d._id.toString(), d.fullName]));
    const nextMap = {};
    for (const a of nextAppts) {
      const k = `${a.patient}|${a.specialty || ''}`;
      if (!nextMap[k]) nextMap[k] = a;
    }

    const items = ending
      .filter(e => pMap[e.pkg.patient.toString()])
      .map(e => {
        const pid = e.pkg.patient.toString();
        const next = nextMap[`${pid}|${e.pkg.specialty || ''}`];
        return {
          patientId: pid,
          packageId: e.pkg._id.toString(),
          name: pMap[pid].fullName || 'Paciente',
          phone: pMap[pid].phone || '',
          specialty: e.pkg.specialty || null,
          doctorName: e.pkg.doctor ? dMap[e.pkg.doctor.toString()] || null : null,
          remaining: e.remaining,
          totalSessions: e.pkg.totalSessions || 0,
          nextSessionAt: next ? next.date : null,
          nextSessionTime: next?.time || null,
          lastContactAt: contacts[pid] || null,
        };
      })
      .sort((a, b) => a.remaining - b.remaining);

    res.json({ success: true, data: { threshold, items: sortByRecentContact(items) } });
  } catch (err) {
    console.error('[commercial.v2] /package-ending error:', err);
    sendApiError(res, err, req);
  }
});

router.get('/reactivation', ...staff, async (req, res) => {
  try {
    const minDays = clampInt(req.query.minDays, 7, 0, 90);
    const items = await patientsWithoutNext({ lookbackDays: 120, minDays, limit: clampInt(req.query.limit, 50, 1, 200) });
    res.json({ success: true, data: { minDays, items: sortByRecentContact(items) } });
  } catch (err) {
    console.error('[commercial.v2] /reactivation error:', err);
    sendApiError(res, err, req);
  }
});

router.get('/leads-waiting', ...staff, async (req, res) => {
  try {
    const hours = clampInt(req.query.hours, 2, 1, 48);
    const now = new Date();
    // "Lead novo": entrou nos últimos 3 dias
    const since = moment().tz(TIMEZONE).subtract(3, 'days').toDate();
    const leads = await Lead.find(
      { status: { $in: OPEN_LEAD_STATUSES }, convertedToPatient: { $in: [null, undefined] }, createdAt: { $gte: since } },
      { name: 1, contact: 1, therapyArea: 1, status: 1, origin: 1, createdAt: 1, interactions: { $slice: -1 } },
    ).lean();
    if (!leads.length) return res.json({ success: true, data: { hours, items: [] } });

    const lastMsgs = await Message.aggregate([
      { $match: { lead: { $in: leads.map(l => l._id) } } },
      { $sort: { timestamp: -1 } },
      { $group: { _id: '$lead', direction: { $first: '$direction' }, timestamp: { $first: '$timestamp' }, content: { $first: '$content' } } },
    ]);
    const msgMap = Object.fromEntries(lastMsgs.map(m => [m._id.toString(), m]));
    // "Respondido" marcado na fila conta como resposta (a equipe pode ter respondido por fora do ERP)
    const replied = await lastContacts(leads.map(l => l._id), 'lead_reply');

    const limitMs = hours * 3_600_000;
    const items = leads
      .map(l => {
        const msg = msgMap[l._id.toString()];
        const since = waitingSince({ createdAt: l.createdAt, lastMessage: msg, lastInteraction: l.interactions?.[0] });
        const repliedAt = replied[l._id.toString()];
        if (repliedAt && since && new Date(repliedAt) >= since) return null;
        return since && now - since >= limitMs ? {
          leadId: l._id.toString(),
          name: l.name || 'Lead sem nome',
          phone: l.contact?.phone || '',
          therapyArea: l.therapyArea || null,
          origin: l.origin || null,
          status: l.status,
          waitingSince: since,
          waitingMinutes: Math.floor((now - since) / 60_000),
          lastMessage: msg?.content ? String(msg.content).slice(0, 140) : null,
        } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.waitingMinutes - a.waitingMinutes);

    res.json({ success: true, data: { hours, items } });
  } catch (err) {
    console.error('[commercial.v2] /leads-waiting error:', err);
    sendApiError(res, err, req);
  }
});

// Vendas & Marketing (docs/SALES_MARKETING.md): KPIs do funil e ROI por período, calculados no back.
router.get('/leads-summary', ...staff, async (req, res) => {
  try {
    res.json({ success: true, data: await leadsSummary(req.query.start, req.query.end) });
  } catch (err) {
    console.error('[commercial.v2] /leads-summary error:', err);
    sendApiError(res, err, req);
  }
});

router.get('/roi-summary', ...staff, async (req, res) => {
  try {
    res.json({ success: true, data: await roiSummary(req.query.start, req.query.end) });
  } catch (err) {
    console.error('[commercial.v2] /roi-summary error:', err);
    sendApiError(res, err, req);
  }
});

// Social Media: especialidades com vaga ociosa (base das "Sugestões da semana")
router.get('/idle-slots', ...staff, async (req, res) => {
  try {
    res.json({ success: true, data: { items: await idleSlotsBySpecialty() } });
  } catch (err) {
    console.error('[commercial.v2] /idle-slots error:', err);
    sendApiError(res, err, req);
  }
});

router.post('/contacts', ...staff, async (req, res) => {
  try {
    const { targetType, targetId, kind, channel = 'whatsapp', note = '' } = req.body || {};
    if (!['patient', 'lead'].includes(targetType) || !mongoose.isValidObjectId(targetId)
      || !['reactivation', 'renewal', 'fit', 'lead_reply'].includes(kind)) {
      return sendApiError(res, new AppError('BAD_REQUEST', 'Contato inválido.', { status: 400 }), req);
    }
    const userId = req.user?._id || req.user?.id || null;

    // Duplo clique não duplica: mesmo alvo/tipo/usuário em 5 min devolve o registro existente
    const recent = await CommercialContact.findOne({
      target: oid(targetId), kind, user: userId,
      createdAt: { $gte: new Date(Date.now() - 5 * 60_000) },
    }).lean();
    if (recent) return res.json({ success: true, data: recent, deduped: true });

    const created = await CommercialContact.create({
      targetType, target: oid(targetId), kind, channel, note: String(note).slice(0, 500), user: userId,
    });
    console.log(`[commercial.v2] contato ${kind} registrado para ${targetType} ${targetId}`);
    res.status(201).json({ success: true, data: created });
  } catch (err) {
    console.error('[commercial.v2] /contacts error:', err);
    sendApiError(res, err, req);
  }
});

export default router;
