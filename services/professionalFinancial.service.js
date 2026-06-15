/**
 * 👨‍⚕️ Professional Financial Service
 *
 * Centro de Resultado do Profissional — fonte única oficial.
 *
 * Hierarquia:
 *   Profissional
 *     ↓
 *   Paciente
 *     ↓
 *   Sessão
 *     ↓
 *   Pagamento
 *
 * Regras:
 *   - Produção = Session.status === 'completed'
 *   - Caixa    = Payment.status === 'paid' (kind !== 'package_consumed')
 *   - Comissão = commissionRule.service.calculateCommissionBatch() (regra do negócio)
 *   - Não depende de reconciliation.service (auditoria separada)
 *   - Não usa Appointment como base financeira
 */

import moment from 'moment-timezone';
import mongoose from 'mongoose';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';
import Doctor from '../models/Doctor.js';
import Patient from '../models/Patient.js';
import Package from '../models/Package.js';
import ProfessionalAdvance from '../models/ProfessionalAdvance.js';
import InsuranceGuide from '../models/InsuranceGuide.js';
import { resolveSessionFinancialValue } from '../utils/resolveSessionFinancialValue.js';
import { classifyPendingSession } from '../utils/classifyPendingSession.js';
import { logMetric } from '../utils/logMetric.js';
import { calculateCommissionBatch, calculateSessionCommission } from './commissionRule.service.js';

const TIMEZONE = 'America/Sao_Paulo';

// Cache simples em memória para reduzir latência em consultas frequentes
const memoryCache = new Map();

function cacheGet(key, ttlMs) {
  const entry = memoryCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.createdAt > ttlMs) {
    memoryCache.delete(key);
    return undefined;
  }
  return entry.value;
}

function cacheSet(key, value) {
  memoryCache.set(key, { value, createdAt: Date.now() });
}

function parseRange(startDate, endDate) {
  const start = startDate
    ? moment.tz(startDate, TIMEZONE).startOf('day').toDate()
    : moment.tz(TIMEZONE).startOf('month').toDate();
  const end = endDate
    ? moment.tz(endDate, TIMEZONE).endOf('day').toDate()
    : moment.tz(TIMEZONE).endOf('month').toDate();
  return { start, end };
}

function toDateString(d) {
  return moment(d).tz(TIMEZONE).format('YYYY-MM-DD');
}

function toObjectId(value) {
  if (!value) return null;
  return value._id?.toString?.() || value.toString?.();
}

function round(value) {
  return Math.round((value || 0) * 100) / 100;
}

function extractDoctorId(item) {
  if (!item) return null;
  if (item.doctor?._id) return item.doctor._id.toString();
  if (item.doctor) return item.doctor.toString?.();
  return null;
}

function extractPatientId(item) {
  if (!item) return null;
  // 1) patient populado na própria sessão
  if (item.patient?._id) return item.patient._id.toString();
  if (item.patient) return item.patient.toString?.();
  // 2) fallback para appointment vinculado
  if (item.appointmentId?.patient?._id) return item.appointmentId.patient._id.toString();
  if (item.appointmentId?.patient) return item.appointmentId.patient.toString?.();
  // 3) fallback para paciente do pacote
  if (item.package?.patient?._id) return item.package.patient._id.toString();
  if (item.package?.patient) return item.package.patient.toString?.();
  return null;
}

/**
 * Classifica uma sessão completed em particular / pacote / convenio / liminar.
 * Replica a regra de unifiedFinancialService.v2.js para garantir consistência.
 */
function classifyProductionType(session) {
  const method = (session.paymentMethod || '').toLowerCase();
  const origin = (session.paymentOrigin || '').toLowerCase();

  if (method === 'liminar_credit' || origin === 'liminar' || origin === 'liminar_credit') return 'liminar';
  if (method === 'convenio' || origin === 'convenio' || session.insuranceGuide) return 'convenio';
  if (session.package) return 'pacote';
  return 'particular';
}

/**
 * Classifica um payment por origem.
 */
function classifyCashType(payment) {
  const billingType = (payment.billingType || '').toLowerCase();
  const method = (payment.paymentMethod || '').toLowerCase();

  if (billingType === 'liminar' || method === 'liminar_credit') return 'liminar';
  if (billingType === 'convenio' || method === 'convenio') return 'convenio';
  return 'particular';
}

async function fetchCompletedSessions(start, end, doctorId = null) {
  const match = { date: { $gte: start, $lte: end }, status: 'completed' };
  if (doctorId) match.doctor = new mongoose.Types.ObjectId(doctorId);

  return Session.find(match)
    .populate('package', 'sessionValue totalValue totalSessions sessionType insuranceProvider')
    .populate('insuranceGuide', 'insurance')
    .populate('patient', 'fullName')
    .populate('doctor', 'fullName specialty')
    .lean();
}

async function fetchPaidPayments(start, end, doctorId = null) {
  const match = {
    status: 'paid',
    amount: { $gt: 0 },
    kind: { $ne: 'package_consumed' },
    $or: [
      { financialDate: { $gte: start, $lte: end } },
      { financialDate: { $exists: false }, paymentDate: { $gte: start, $lte: end } },
      { financialDate: null, paymentDate: { $gte: start, $lte: end } },
      { financialDate: { $exists: false }, paymentDate: { $exists: false }, createdAt: { $gte: start, $lte: end } },
      { financialDate: null, paymentDate: null, createdAt: { $gte: start, $lte: end } }
    ]
  };
  if (doctorId) match.doctor = new mongoose.Types.ObjectId(doctorId);

  return Payment.find(match)
    .populate('patient', 'fullName')
    .populate('doctor', 'fullName specialty')
    .lean();
}

async function getDoctorAdvanceBalanceInternal(doctorId, asOfDate) {
  const query = {
    doctor: new mongoose.Types.ObjectId(doctorId),
    status: 'active'
  };

  if (asOfDate) {
    query.date = { $lte: asOfDate };
  }

  const advances = await ProfessionalAdvance.find(query).lean();

  const total = advances.reduce((sum, a) => sum + (a.amount || 0), 0);
  const byType = advances.reduce((acc, a) => {
    acc[a.type] = (acc[a.type] || 0) + (a.amount || 0);
    return acc;
  }, {});

  return {
    total,
    count: advances.length,
    byType
  };
}

async function fetchPatientCounts(doctorId, start, end) {
  const baseQuery = doctorId ? { doctor: new mongoose.Types.ObjectId(doctorId) } : {};

  const [active, inactive, total, newPatients] = await Promise.all([
    Patient.countDocuments({ ...baseQuery, status: 'active' }),
    Patient.countDocuments({ ...baseQuery, status: 'inactive' }),
    Patient.countDocuments(baseQuery),
    Patient.countDocuments({
      ...baseQuery,
      createdAt: { $gte: start, $lte: end }
    })
  ]);

  return { active, inactive, total, new: newPatients };
}

/**
 * ─────────────────────────────────────────────────────────────────
 * Centro de Resultado do Profissional — Summary
 * ─────────────────────────────────────────────────────────────────
 */
export async function getProfessionalSummary({ doctorId, startDate, endDate }) {
  const startedAt = Date.now();
  const { start, end } = parseRange(startDate, endDate);

  const [sessions, payments, patientCounts, doctor, advanceBalance] = await Promise.all([
    fetchCompletedSessions(start, end, doctorId),
    fetchPaidPayments(start, end, doctorId),
    fetchPatientCounts(doctorId, start, end),
    Doctor.findById(doctorId).select('fullName specialty commissionRules commissionRuleVersion').lean(),
    getDoctorAdvanceBalanceInternal(doctorId, end)
  ]);

  // Produção por tipo
  const production = { total: 0, particular: 0, pacote: 0, convenio: 0, liminar: 0 };
  let completedSessions = 0;
  let orphanSessions = 0;

  // A receber por categoria
  const receivables = { total: 0, particular: 0, insurance: 0, liminar: 0, packageConsumed: 0 };

  const paidSessionIds = new Set();

  for (const payment of payments) {
    if (payment.session) paidSessionIds.add(toObjectId(payment.session));
  }

  const activePatientIds = new Set();
  let packageCount = 0, insuranceCount = 0, liminarCount = 0, privatePendingCount = 0;

  for (const session of sessions) {
    const value = resolveSessionFinancialValue(session);
    const type = classifyProductionType(session);

    production.total += value;
    production[type] += value;
    completedSessions += 1;

    const patId = extractPatientId(session);
    if (patId) activePatientIds.add(patId);

    const isPaid = paidSessionIds.has(session._id.toString());
    if (!isPaid) {
      receivables.total += value;
      const pendingType = classifyPendingSession(session);
      if (pendingType === 'package') {
        receivables.packageConsumed += value;
        packageCount += 1;
      } else if (pendingType === 'insurance') {
        receivables.insurance += value;
        insuranceCount += 1;
      } else if (pendingType === 'liminar') {
        receivables.liminar += value;
        liminarCount += 1;
      } else if (pendingType === 'privatePending') {
        receivables.particular += value;
        privatePendingCount += 1;
      } else {
        receivables.particular += value;
        orphanSessions += 1;
      }
    }

  }

  // Caixa por origem
  const received = { total: 0, particular: 0, convenio: 0, liminar: 0, packageSales: 0 };
  let orphanPayments = 0;

  for (const payment of payments) {
    const type = classifyCashType(payment);
    received.total += payment.amount || 0;
    received[type] += payment.amount || 0;

    // Payments sem session vinculada = vendas de pacote ou adiantamentos
    if (!payment.session) {
      received.packageSales += payment.amount || 0;
    }

    if (!payment.session && !payment.appointment && !payment.patient) {
      orphanPayments += 1;
    }
  }

  // Comissão real via motor oficial (evita segunda query de sessions)
  const { totalCommission: commission } = calculateCommissionBatch(doctor, sessions);

  // Adiantamentos
  const advances = advanceBalance.total;

  const result = {
    doctorId,
    doctorName: doctor?.fullName || 'Desconhecido',
    specialty: doctor?.specialty || null,
    period: { start: toDateString(start), end: toDateString(end) },
    patients: {
      active: activePatientIds.size,
      new: patientCounts.new,
      inactive: patientCounts.inactive,
      total: patientCounts.total
    },
    sessions: {
      completed: completedSessions,
      withoutImmediatePayment: completedSessions - paidSessionIds.size,
      breakdown: {
        package: Math.round(receivables.packageConsumed),
        packageCount,
        insurance: Math.round(receivables.insurance),
        insuranceCount,
        liminar: Math.round(receivables.liminar),
        liminarCount,
        privatePending: Math.round(receivables.particular),
        privatePendingCount,
        realIssues: orphanSessions
      }
    },
    production: {
      total: round(production.total),
      particular: round(production.particular),
      pacote: round(production.pacote),
      convenio: round(production.convenio),
      liminar: round(production.liminar)
    },
    received: {
      total: round(received.total),
      particular: round(received.particular),
      convenio: round(received.convenio),
      liminar: round(received.liminar),
      packageSales: round(received.packageSales),
      sessionCash: round(received.total - received.packageSales)
    },
    pending: round(production.total - received.total),
    receivables: {
      total: round(receivables.total),
      particular: round(receivables.particular),
      insurance: round(receivables.insurance),
      liminar: round(receivables.liminar),
      packageConsumed: round(receivables.packageConsumed)
    },
    commission: round(commission),
    advances: round(advances),
    balance: round(commission - advances),
    advancesBreakdown: {
      count: advanceBalance.count,
      total: round(advanceBalance.total),
      byType: advanceBalance.byType
    },
    health: {
      orphanSessions,
      orphanPayments,
      hasCommissionData: commission > 0
    },
    metadata: {
      generatedAt: new Date().toISOString(),
      executionTimeMs: Date.now() - startedAt,
      timezone: TIMEZONE
    }
  };

  logMetric('ProfessionalFinancialService', 'getProfessionalSummary', {
    doctorId,
    executionTimeMs: result.metadata.executionTimeMs,
    cacheHit: false,
    sessionCount: sessions.length,
    paymentCount: payments.length,
    patientCount: result.patients.total,
    production: result.production.total,
    commission: result.commission
  });

  return result;
}

/**
 * ─────────────────────────────────────────────────────────────────
 * Drill-down por paciente
 * ─────────────────────────────────────────────────────────────────
 */
export async function getProfessionalPatientsBreakdown({ doctorId, startDate, endDate }) {
  const startedAt = Date.now();
  const { start, end } = parseRange(startDate, endDate);

  const doctor = await Doctor.findById(doctorId).select('commissionRules commissionRuleVersion').lean();

  const [sessions, payments] = await Promise.all([
    Session.find({
      doctor: new mongoose.Types.ObjectId(doctorId),
      date: { $gte: start, $lte: end },
      status: { $in: ['completed', 'canceled', 'missed', 'scheduled', 'pending'] }
    })
      .populate('package', 'sessionValue totalValue totalSessions patient')
      .populate('patient', 'fullName phone')
      .populate('appointmentId', 'patient')
      .lean(),
    fetchPaidPayments(start, end, doctorId)
  ]);

  const sessionMapById = {};
  const sessionMapByAppointment = {};
  for (const session of sessions) {
    sessionMapById[session._id.toString()] = session;
    if (session.appointmentId) {
      sessionMapByAppointment[session.appointmentId.toString()] = session;
    }
  }

  const paymentBySession = {};
  for (const payment of payments) {
    if (payment.session) {
      const sid = toObjectId(payment.session);
      if (!paymentBySession[sid]) paymentBySession[sid] = [];
      paymentBySession[sid].push(payment);
    }
    if (payment.appointment) {
      const session = sessionMapByAppointment[toObjectId(payment.appointment)];
      if (session) {
        const sid = session._id.toString();
        if (!paymentBySession[sid]) paymentBySession[sid] = [];
        paymentBySession[sid].push(payment);
      }
    }
  }

  const patientMap = {};

  for (const session of sessions) {
    const pid = extractPatientId(session);
    if (!pid) continue;

    // Resolve o objeto paciente populado (sessão, appointment ou pacote)
    const patientObj =
      session.patient?._id ? session.patient :
      session.appointmentId?.patient?._id ? session.appointmentId.patient :
      session.package?.patient?._id ? session.package.patient :
      null;

    if (!patientMap[pid]) {
      patientMap[pid] = {
        patientId: pid,
        patientName: patientObj?.fullName || 'Sem nome',
        phone: patientObj?.phone || null,
        completedSessions: 0,
        cancelledSessions: 0,
        missedSessions: 0,
        scheduledSessions: 0,
        production: 0,
        received: 0,
        pending: 0,
        commission: 0,
        lastSession: null,
        nextSession: null
      };
    }

    const patient = patientMap[pid];
    const effectiveValue = resolveSessionFinancialValue(session);
    const sessionDate = session.date ? new Date(session.date) : null;

    if (session.status === 'completed') {
      patient.completedSessions += 1;
      patient.production += effectiveValue;
      // Sempre recalcula pela regra atual — snapshot pode estar desatualizado
      const commission = doctor ? calculateSessionCommission(doctor, session, session.date) : 0;
      patient.commission += commission || 0;

      const sid = session._id.toString();
      const paidPayments = paymentBySession[sid] || [];
      const paidAmount = paidPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
      patient.received += paidAmount;
      patient.pending += Math.max(0, effectiveValue - paidAmount);

      if (sessionDate) {
        const dateStr = toDateString(sessionDate);
        if (!patient.lastSession || dateStr > patient.lastSession) patient.lastSession = dateStr;
      }
    } else if (session.status === 'canceled') {
      patient.cancelledSessions += 1;
    } else if (session.status === 'missed') {
      patient.missedSessions += 1;
    } else if (session.status === 'scheduled' || session.status === 'pending') {
      patient.scheduledSessions += 1;
      if (sessionDate) {
        const dateStr = toDateString(sessionDate);
        if (!patient.nextSession || dateStr < patient.nextSession) patient.nextSession = dateStr;
      }
    }
  }

  const result = Object.values(patientMap)
    .map(p => ({
      ...p,
      production: round(p.production),
      received: round(p.received),
      pending: round(p.pending),
      commission: round(p.commission)
    }))
    .sort((a, b) => b.pending - a.pending);

  logMetric('ProfessionalFinancialService', 'getProfessionalPatientsBreakdown', {
    doctorId,
    executionTimeMs: Date.now() - startedAt,
    cacheHit: false,
    sessionCount: sessions.length,
    paymentCount: payments.length,
    patientCount: result.length
  });

  return result;
}

/**
 * ─────────────────────────────────────────────────────────────────
 * Cálculo de comissão em batch (sem queries adicionais)
 * ─────────────────────────────────────────────────────────────────
 */
function calculateCommissionForDoctor(doctor, sessions) {
  const { totalCommission } = calculateCommissionBatch(doctor, sessions);
  return totalCommission;
}

function buildCommissionRates(doctor) {
  const isNeuroped = ['neuroped', 'neuropediatria'].includes((doctor.specialty || '').toLowerCase().trim());
  const rules = (doctor.commissionRules?.rules || []).filter(r => r.active !== false);

  if (rules.length === 0) {
    if (isNeuroped) return [{ billingType: 'all', commissionType: 'percentage', value: 80 }];
    return [];
  }

  // Por billingType, mantém a regra de maior prioridade
  const byBillingType = {};
  for (const rule of rules) {
    const bt = rule.billingType || 'particular';
    if (!byBillingType[bt] || (rule.priority || 0) > (byBillingType[bt].priority || 0)) {
      byBillingType[bt] = rule;
    }
  }

  return Object.entries(byBillingType).map(([bt, rule]) => ({
    billingType: bt,
    commissionType: rule.commissionType,
    value: rule.value
  }));
}

/**
 * ─────────────────────────────────────────────────────────────────
 * Ranking de profissionais (otimizado — query única por entidade)
 * ─────────────────────────────────────────────────────────────────
 */
export async function getProfessionalRanking({ startDate, endDate }) {
  const startedAt = Date.now();
  const { start, end } = parseRange(startDate, endDate);
  const cacheKey = `ranking:${toDateString(start)}:${toDateString(end)}`;

  const cached = cacheGet(cacheKey, 300_000);
  if (cached) {
    const result = cached.map(item => ({
      ...item,
      metadata: { ...item.metadata, cacheHit: true }
    }));

    logMetric('ProfessionalFinancialService', 'getProfessionalRanking', {
      period: { start: toDateString(start), end: toDateString(end) },
      executionTimeMs: Date.now() - startedAt,
      cacheHit: true,
      doctorCount: result.length
    });

    return result;
  }

  const doctorsCacheKey = 'doctors:active';
  let doctors = cacheGet(doctorsCacheKey, 600_000);
  if (!doctors) {
    doctors = await Doctor.find({ active: true }).select('fullName specialty commissionRules').lean();
    cacheSet(doctorsCacheKey, doctors);
  }
  const doctorIds = doctors.map(d => d._id.toString());

  const [sessions, payments, advances, patientCountsMap] = await Promise.all([
    Session.find({ date: { $gte: start, $lte: end }, status: 'completed', doctor: { $in: doctorIds } })
      .select('doctor patient sessionValue paymentMethod paymentOrigin paymentStatus package insuranceGuide sessionType serviceType')
      .lean(),
    Payment.find({
      status: 'paid',
      amount: { $gt: 0 },
      kind: { $ne: 'package_consumed' },
      doctor: { $in: doctorIds },
      $or: [
        { financialDate: { $gte: start, $lte: end } },
        { financialDate: { $exists: false }, paymentDate: { $gte: start, $lte: end } },
        { financialDate: null, paymentDate: { $gte: start, $lte: end } },
        { financialDate: { $exists: false }, paymentDate: { $exists: false }, createdAt: { $gte: start, $lte: end } },
        { financialDate: null, paymentDate: null, createdAt: { $gte: start, $lte: end } }
      ]
    }).select('doctor amount session appointment patient billingType paymentMethod').lean(),
    ProfessionalAdvance.find({ doctor: { $in: doctorIds }, status: 'active', date: { $lte: end } }).select('doctor amount type').lean(),
    (async () => {
      const counts = await Patient.aggregate([
        { $match: { doctor: { $in: doctorIds.map(id => new mongoose.Types.ObjectId(id)) } } },
        {
          $group: {
            _id: '$doctor',
            active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
            inactive: { $sum: { $cond: [{ $eq: ['$status', 'inactive'] }, 1, 0] } },
            total: { $sum: 1 },
            new: { $sum: { $cond: [{ $and: [{ $gte: ['$createdAt', start] }, { $lte: ['$createdAt', end] }] }, 1, 0] } }
          }
        }
      ]);
      const map = {};
      for (const c of counts) {
        map[c._id.toString()] = { active: c.active || 0, inactive: c.inactive || 0, total: c.total || 0, new: c.new || 0 };
      }
      return map;
    })()
  ]);

  const [packagesMap, insuranceGuidesMap] = await Promise.all([
    (async () => {
      const packageIds = [...new Set(sessions.map(s => s.package).filter(Boolean))];
      if (packageIds.length === 0) return {};
      const pkgs = await Package.find({ _id: { $in: packageIds } }).select('sessionType totalSessions insuranceProvider').lean();
      const map = {};
      for (const p of pkgs) map[p._id.toString()] = p;
      return map;
    })(),
    (async () => {
      const guideIds = [...new Set(sessions.map(s => s.insuranceGuide).filter(Boolean))];
      if (guideIds.length === 0) return {};
      const guides = await InsuranceGuide.find({ _id: { $in: guideIds } }).select('insurance').lean();
      const map = {};
      for (const g of guides) map[g._id.toString()] = g;
      return map;
    })()
  ]);

  // Enriquecer sessões com package e insuranceGuide sem populate
  for (const session of sessions) {
    if (session.package) {
      const pkg = packagesMap[session.package.toString?.() || session.package];
      if (pkg) session.package = pkg;
    }
    if (session.insuranceGuide) {
      const guide = insuranceGuidesMap[session.insuranceGuide.toString?.() || session.insuranceGuide];
      if (guide) session.insuranceGuide = guide;
    }
  }

  const sessionsByDoctor = {};
  for (const s of sessions) {
    const did = extractDoctorId(s);
    if (!did) continue;
    if (!sessionsByDoctor[did]) sessionsByDoctor[did] = [];
    sessionsByDoctor[did].push(s);
  }

  const paymentsByDoctor = {};
  for (const p of payments) {
    const did = extractDoctorId(p);
    if (!did) continue;
    if (!paymentsByDoctor[did]) paymentsByDoctor[did] = [];
    paymentsByDoctor[did].push(p);
  }

  const advancesByDoctor = {};
  for (const a of advances) {
    const did = extractDoctorId(a);
    if (!did) continue;
    if (!advancesByDoctor[did]) advancesByDoctor[did] = [];
    advancesByDoctor[did].push(a);
  }

  const summaries = [];

  for (const doctor of doctors) {
    const doctorId = doctor._id.toString();
    const doctorSessions = sessionsByDoctor[doctorId] || [];
    const doctorPayments = paymentsByDoctor[doctorId] || [];
    const doctorAdvances = advancesByDoctor[doctorId] || [];
    const patientCounts = patientCountsMap[doctorId] || { active: 0, inactive: 0, total: 0, new: 0 };

    const production = { total: 0, particular: 0, pacote: 0, convenio: 0, liminar: 0 };
    const receivables = { total: 0, particular: 0, insurance: 0, liminar: 0, packageConsumed: 0 };
    const received = { total: 0, particular: 0, convenio: 0, liminar: 0 };
    let orphanSessions = 0;
    let orphanPayments = 0;

    const paidSessionIds = new Set();
    for (const payment of doctorPayments) {
      if (payment.session) paidSessionIds.add(toObjectId(payment.session));
    }

    for (const session of doctorSessions) {
      const value = resolveSessionFinancialValue(session);
      const type = classifyProductionType(session);
      production.total += value;
      production[type] += value;

      if (!paidSessionIds.has(session._id.toString())) {
        receivables.total += value;
        const pendingType = classifyPendingSession(session);
        if (pendingType === 'package') receivables.packageConsumed += value;
        else if (pendingType === 'insurance') receivables.insurance += value;
        else if (pendingType === 'liminar') receivables.liminar += value;
        else if (pendingType === 'privatePending') receivables.particular += value;
        else { receivables.particular += value; orphanSessions += 1; }
      }
    }

    for (const payment of doctorPayments) {
      const type = classifyCashType(payment);
      received.total += payment.amount || 0;
      received[type] += payment.amount || 0;
      if (!payment.session && !payment.appointment && !payment.patient) orphanPayments += 1;
    }

    const commission = calculateCommissionForDoctor(doctor, doctorSessions);
    const advancesTotal = doctorAdvances.reduce((sum, a) => sum + (a.amount || 0), 0);
    const uniquePatientsThisPeriod = new Set(doctorSessions.map(s => s.patient?.toString()).filter(Boolean)).size;

    summaries.push({
      doctorId,
      doctorName: doctor.fullName || 'Desconhecido',
      specialty: doctor.specialty || null,
      period: { start: toDateString(start), end: toDateString(end) },
      patients: { ...patientCounts, activePeriod: uniquePatientsThisPeriod },
      sessions: {
        completed: doctorSessions.length,
        withoutImmediatePayment: doctorSessions.length - paidSessionIds.size,
        breakdown: {
          package: Math.round(receivables.packageConsumed),
          insurance: Math.round(receivables.insurance),
          liminar: Math.round(receivables.liminar),
          privatePending: Math.round(receivables.particular),
          realIssues: orphanSessions
        }
      },
      production: { total: round(production.total), particular: round(production.particular), pacote: round(production.pacote), convenio: round(production.convenio), liminar: round(production.liminar) },
      received: { total: round(received.total), particular: round(received.particular), convenio: round(received.convenio), liminar: round(received.liminar) },
      pending: round(production.total - received.total),
      receivables: {
        total: round(receivables.total),
        particular: round(receivables.particular),
        insurance: round(receivables.insurance),
        liminar: round(receivables.liminar),
        packageConsumed: round(receivables.packageConsumed)
      },
      commission: round(commission),
      commissionRates: buildCommissionRates(doctor),
      advances: round(advancesTotal),
      balance: round(commission - advancesTotal),
      advancesBreakdown: {
        count: doctorAdvances.length,
        total: round(advancesTotal),
        byType: doctorAdvances.reduce((acc, a) => {
          acc[a.type] = (acc[a.type] || 0) + (a.amount || 0);
          return acc;
        }, {})
      },
      health: { orphanSessions, orphanPayments, hasCommissionData: commission > 0 },
      metadata: { generatedAt: new Date().toISOString(), executionTimeMs: Date.now() - startedAt }
    });
  }

  const clinicUniquePatientsThisPeriod = new Set(sessions.map(s => s.patient?.toString()).filter(Boolean)).size;
  const clinicSessionsThisPeriod = sessions.length;

  const result = summaries
    .sort((a, b) => b.production.total - a.production.total)
    .map((s, index) => ({ ...s, rank: index + 1, clinicPatientsThisPeriod: clinicUniquePatientsThisPeriod, clinicSessionsThisPeriod }));

  const totalSessions = sessions.length;
  const totalPayments = payments.length;

  logMetric('ProfessionalFinancialService', 'getProfessionalRanking', {
    period: { start: toDateString(start), end: toDateString(end) },
    executionTimeMs: Date.now() - startedAt,
    cacheHit: false,
    doctorCount: result.length,
    sessionCount: totalSessions,
    paymentCount: totalPayments
  });

  cacheSet(cacheKey, result);
  return result;
}

/**
 * ─────────────────────────────────────────────────────────────────
 * Auditoria de comissão
 * ─────────────────────────────────────────────────────────────────
 */
export async function getCommissionAudit({ doctorId, startDate, endDate }) {
  const startedAt = Date.now();
  const { start, end } = parseRange(startDate, endDate);

  const sessions = await Session.find({
    doctor: new mongoose.Types.ObjectId(doctorId),
    date: { $gte: start, $lte: end },
    status: 'completed'
  })
    .populate('patient', 'fullName')
    .populate('package', 'sessionType totalSessions insuranceProvider')
    .populate('insuranceGuide', 'insurance')
    .populate('doctor', 'fullName specialty commissionRules commissionRuleVersion')
    .lean();

  const mismatches = [];
  let totalCommission = 0;
  let totalExpected = 0;

  for (const session of sessions) {
    const effectiveValue = resolveSessionFinancialValue(session);
    const doctor = session.doctor;
    const expected = calculateSessionCommission(doctor, session, session.date);
    const commissionValue = session.commissionSnapshot?.calculatedCommission ?? session.commissionValue ?? 0;

    totalCommission += commissionValue;
    totalExpected += expected;

    if (Math.abs(commissionValue - expected) > 0.01) {
      mismatches.push({
        sessionId: session._id,
        date: toDateString(session.date),
        patientName: session.patient?.fullName || 'Sem nome',
        effectiveValue,
        commissionSnapshot: session.commissionSnapshot || null,
        commissionValue,
        expected,
        difference: round(commissionValue - expected)
      });
    }
  }

  const result = {
    doctorId,
    period: { start: toDateString(start), end: toDateString(end) },
    totalCommission: round(totalCommission),
    totalExpected: round(totalExpected),
    difference: round(totalCommission - totalExpected),
    mismatchCount: mismatches.length,
    mismatches: mismatches.sort((a, b) => b.difference - a.difference)
  };

  logMetric('ProfessionalFinancialService', 'getCommissionAudit', {
    doctorId,
    executionTimeMs: Date.now() - startedAt,
    cacheHit: false,
    sessionCount: sessions.length,
    mismatchCount: result.mismatchCount
  });

  return result;
}
