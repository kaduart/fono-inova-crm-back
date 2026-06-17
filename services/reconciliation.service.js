/**
 * 🔍 Reconciliation Service
 *
 * Fonte única de auditoria financeira por profissional.
 * Cruza Session (produção) e Payment (caixa) sem recalcular valores.
 *
 * Regras:
 *   - Produção = Session.status === 'completed'
 *   - Caixa    = Payment.status === 'paid' (kind !== 'package_consumed')
 *   - Comissão não é calculada aqui — veja commissionService.js
 */

import moment from 'moment-timezone';
import mongoose from 'mongoose';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';
import Doctor from '../models/Doctor.js';
import Patient from '../models/Patient.js';
import { resolveSessionFinancialValue } from '../utils/resolveSessionFinancialValue.js';
import { classifyPendingSession } from '../utils/classifyPendingSession.js';
import '../models/InsuranceGuide.js';
import { calculateDoctorCommission } from './commissionService.js';
import { calculateSessionCommission } from './commissionRule.service.js';
import { logMetric } from '../utils/logMetric.js';

const TIMEZONE = 'America/Sao_Paulo';

// Cache curto para top issues — reduz recálculo pesado em intervalos de polling
const _issuesCache = new Map();
const ISSUES_CACHE_TTL = 30_000; // 30s

function _issuesCacheKey(startDate, endDate, limit) {
    return `${startDate}_${endDate}_${limit}`;
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

function toDateTimeString(d) {
  return moment(d).tz(TIMEZONE).format('YYYY-MM-DD HH:mm');
}

function toObjectId(value) {
  if (!value) return null;
  return value._id?.toString?.() || value.toString?.();
}

function extractDoctorId(item) {
  if (!item) return null;
  if (item.doctor?._id) return item.doctor._id.toString();
  if (item.doctor) return item.doctor.toString?.();
  return null;
}

function extractDoctorName(item) {
  return item?.doctor?.fullName || 'Sem profissional';
}

function extractPatientId(item) {
  if (!item) return null;
  if (item.patient?._id) return item.patient._id.toString();
  if (item.patient) return item.patient.toString?.();
  return null;
}

function extractPatientName(item) {
  return item?.patient?.fullName || 'Sem paciente';
}

function isCommissionMismatch(session, doctor = null) {
  const snapshotValue = session.commissionSnapshot?.calculatedCommission ?? session.commissionValue;
  if (snapshotValue == null) return true;
  if (!doctor) return false;

  const expected = calculateSessionCommission(doctor, session, session.date);
  return Math.abs(expected - snapshotValue) > 0.015;
}



function linkPaymentToSession(payment, sessionMapById, sessionMapByAppointment) {
  if (payment.session) {
    return sessionMapById[toObjectId(payment.session)] || null;
  }
  if (payment.appointment) {
    return sessionMapByAppointment[toObjectId(payment.appointment)] || null;
  }
  return null;
}

async function fetchSessions(start, end, statuses = ['completed']) {
  return Session.find({
    date: { $gte: start, $lte: end },
    status: { $in: statuses }
  })
    .populate('package', 'sessionValue totalValue totalSessions')
    .populate('patient', 'fullName phone')
    .populate('doctor', 'fullName specialty')
    .lean();
}

async function fetchCompletedSessions(start, end) {
  return fetchSessions(start, end, ['completed']);
}

async function fetchPaidPayments(start, end) {
  return Payment.find({
    status: 'paid',
    amount: { $gt: 0 },
    kind: { $nin: ['package_consumed', 'package_receipt'] },
    isFromPackage: { $ne: true },
    $or: [
      { financialDate: { $gte: start, $lte: end } },
      { financialDate: { $exists: false }, paymentDate: { $gte: start, $lte: end } },
      { financialDate: null, paymentDate: { $gte: start, $lte: end } },
      { financialDate: { $exists: false }, paymentDate: { $exists: false }, createdAt: { $gte: start, $lte: end } },
      { financialDate: null, paymentDate: null, createdAt: { $gte: start, $lte: end } }
    ]
  })
    .populate('doctor', 'fullName specialty')
    .populate('patient', 'fullName')
    .populate('session', 'date status')
    .populate('appointment', 'date')
    .lean();
}

function round(value) {
  return Math.round((value || 0) * 100) / 100;
}

async function buildReconciliation(startDate, endDate) {
  const { start, end } = parseRange(startDate, endDate);

  const [sessions, payments] = await Promise.all([
    fetchCompletedSessions(start, end),
    fetchPaidPayments(start, end)
  ]);

  // Carrega doctors com regras de comissão para auditoria correta
  const relevantDoctorIds = [...new Set(sessions.map(extractDoctorId).filter(Boolean))];
  const doctors = relevantDoctorIds.length
    ? await Doctor.find({ _id: { $in: relevantDoctorIds } }).select('specialty commissionRules commissionRuleVersion').lean()
    : [];
  const doctorById = Object.fromEntries(doctors.map(d => [d._id.toString(), d]));

  const sessionMapById = {};
  const sessionMapByAppointment = {};

  for (const session of sessions) {
    sessionMapById[session._id.toString()] = session;
    if (session.appointmentId) {
      sessionMapByAppointment[session.appointmentId.toString()] = session;
    }
  }

  const doctorMap = {};
  const paidSessionIds = new Set();

  function ensureDoctor(key, name, specialty) {
    if (!doctorMap[key]) {
      doctorMap[key] = {
        doctorId: key,
        doctorName: name,
        specialty: specialty || null,
        completedSessions: 0,
        sessionsWithPayment: 0,
        sessionsWithoutPayment: 0,
        sessionsWithoutPaymentBreakdown: { package: 0, insurance: 0, privatePending: 0, liminar: 0, realIssue: 0 },
        receivables: { total: 0, particular: 0, insurance: 0, liminar: 0, packageConsumed: 0 },
        production: 0,
        received: 0,
        commission: 0,
        advances: 0,
        difference: 0,
        orphanSessions: 0,
        orphanPayments: 0,
        commissionMismatch: 0,
        missingDoctor: 0
      };
    }
    return doctorMap[key];
  }

  let globalProduction = 0;
  let globalReceived = 0;
  let globalCommission = 0;
  let globalOrphanSessions = 0;
  let globalOrphanPayments = 0;
  let globalCommissionMismatch = 0;
  let globalMissingDoctor = 0;
  const globalSessionsWithoutPaymentBreakdown = { package: 0, insurance: 0, privatePending: 0, liminar: 0, realIssue: 0 };
  const globalReceivables = { total: 0, particular: 0, insurance: 0, liminar: 0, packageConsumed: 0 };

  // ── Sessões ──
  for (const session of sessions) {
    const effectiveValue = resolveSessionFinancialValue(session);
    const doctorId = extractDoctorId(session);

    globalProduction += effectiveValue;

    if (!doctorId) {
      globalMissingDoctor += 1;
      ensureDoctor('__missing__', 'Sem profissional', null).missingDoctor += 1;
      continue;
    }

    const doctor = doctorById[doctorId] || null;
    const doc = ensureDoctor(doctorId, extractDoctorName(session), session.doctor?.specialty || doctor?.specialty);
    doc.completedSessions += 1;
    doc.production += effectiveValue;
    if (isCommissionMismatch(session, doctor)) doc.commissionMismatch += 1;
  }

  globalCommissionMismatch = sessions.filter(s => isCommissionMismatch(s, doctorById[extractDoctorId(s)])).length;

  // ── Pagamentos ──
  for (const payment of payments) {
    const session = linkPaymentToSession(payment, sessionMapById, sessionMapByAppointment);
    const amount = payment.amount || 0;
    const doctorId = extractDoctorId(session) || extractDoctorId(payment);

    globalReceived += amount;

    if (!doctorId) {
      globalMissingDoctor += 1;
      ensureDoctor('__missing__', 'Sem profissional', null).missingDoctor += 1;
    } else {
      const doc = ensureDoctor(
        doctorId,
        session ? extractDoctorName(session) : extractDoctorName(payment),
        session?.doctor?.specialty || payment.doctor?.specialty
      );
      doc.received += amount;
      if (session) {
        paidSessionIds.add(session._id.toString());
      } else {
        doc.orphanPayments += 1;
        globalOrphanPayments += 1;
      }
    }
  }

  // ── Sessões sem pagamento ──
  for (const session of sessions) {
    const doctorId = extractDoctorId(session);
    if (!doctorId) continue;

    const paid = paidSessionIds.has(session._id.toString());
    const doc = doctorMap[doctorId];
    if (paid) {
      doc.sessionsWithPayment += 1;
    } else {
      doc.sessionsWithoutPayment += 1;
      const pendingType = classifyPendingSession(session);
      doc.sessionsWithoutPaymentBreakdown[pendingType] += 1;
      globalSessionsWithoutPaymentBreakdown[pendingType] += 1;

      const effectiveValue = resolveSessionFinancialValue(session);
      if (pendingType === 'package') {
        doc.receivables.packageConsumed += effectiveValue;
        globalReceivables.packageConsumed += effectiveValue;
      } else if (pendingType === 'insurance') {
        doc.receivables.insurance += effectiveValue;
        globalReceivables.insurance += effectiveValue;
      } else if (pendingType === 'liminar') {
        doc.receivables.liminar += effectiveValue;
        globalReceivables.liminar += effectiveValue;
      } else if (pendingType === 'privatePending') {
        doc.receivables.particular += effectiveValue;
        globalReceivables.particular += effectiveValue;
      } else if (pendingType === 'realIssue') {
        doc.orphanSessions += 1;
        globalOrphanSessions += 1;
      }
      doc.receivables.total += effectiveValue;
      globalReceivables.total += effectiveValue;
    }
  }

  // ── Arredondamento e diferenças ──
  for (const doc of Object.values(doctorMap)) {
    doc.production = round(doc.production);
    doc.received = round(doc.received);
    doc.commission = round(doc.commission);
    doc.difference = round(doc.production - doc.received);
    doc.receivables = {
      total: round(doc.receivables.total),
      particular: round(doc.receivables.particular),
      insurance: round(doc.receivables.insurance),
      liminar: round(doc.receivables.liminar),
      packageConsumed: round(doc.receivables.packageConsumed)
    };
    doc.sessionsWithoutPaymentBreakdown = {
      package: doc.sessionsWithoutPaymentBreakdown.package,
      insurance: doc.sessionsWithoutPaymentBreakdown.insurance,
      privatePending: doc.sessionsWithoutPaymentBreakdown.privatePending,
      liminar: doc.sessionsWithoutPaymentBreakdown.liminar,
      realIssue: doc.sessionsWithoutPaymentBreakdown.realIssue
    };
  }

  // ── Comissão real por profissional ──
  const doctorIds = Object.values(doctorMap)
    .filter(d => d.doctorId !== '__missing__')
    .map(d => d.doctorId);

  const commissionResults = await Promise.all(
    doctorIds.map(async id => {
      try {
        const result = await calculateDoctorCommission(
          new mongoose.Types.ObjectId(id),
          start,
          end
        );
        return { doctorId: id, commission: result.totalCommission };
      } catch (err) {
        return { doctorId: id, commission: 0 };
      }
    })
  );

  for (const { doctorId, commission } of commissionResults) {
    doctorMap[doctorId].commission = round(commission);
    globalCommission += commission;
  }

  const byDoctor = Object.values(doctorMap)
    .filter(d => d.doctorId !== '__missing__')
    .sort((a, b) => b.difference - a.difference);

  const missingDoctorEntry = doctorMap['__missing__'] || null;

  return {
    period: { start: toDateString(start), end: toDateString(end) },
    global: {
      completedSessions: sessions.length,
      sessionsWithPayment: paidSessionIds.size,
      sessionsWithoutPayment: sessions.length - paidSessionIds.size,
      sessionsWithoutPaymentBreakdown: {
        package: globalSessionsWithoutPaymentBreakdown.package,
        insurance: globalSessionsWithoutPaymentBreakdown.insurance,
        privatePending: globalSessionsWithoutPaymentBreakdown.privatePending,
        liminar: globalSessionsWithoutPaymentBreakdown.liminar,
        realIssue: globalSessionsWithoutPaymentBreakdown.realIssue
      },
      production: round(globalProduction),
      received: round(globalReceived),
      commission: round(globalCommission),
      difference: round(globalProduction - globalReceived),
      receivables: {
        total: round(globalReceivables.total),
        particular: round(globalReceivables.particular),
        insurance: round(globalReceivables.insurance),
        liminar: round(globalReceivables.liminar),
        packageConsumed: round(globalReceivables.packageConsumed)
      },
      orphanSessions: globalOrphanSessions,
      orphanPayments: globalOrphanPayments,
      commissionMismatch: globalCommissionMismatch,
      missingDoctor: globalMissingDoctor,
      linkedPayments: paidSessionIds.size,
      unlinkedPayments: payments.length - paidSessionIds.size
    },
    byDoctor,
    missingDoctor: missingDoctorEntry
  };
}

/**
 * ─────────────────────────────────────────────────────────────────
 * Reconciliação global
 * ─────────────────────────────────────────────────────────────────
 */
export async function getGlobalReconciliation(startDate, endDate) {
  const startedAt = Date.now();
  const result = await buildReconciliation(startDate, endDate);
  result.metadata = {
    generatedAt: new Date().toISOString(),
    executionTimeMs: Date.now() - startedAt,
    timezone: TIMEZONE
  };

  logMetric('ReconciliationService', 'getGlobalReconciliation', {
    startDate,
    endDate,
    executionTimeMs: result.metadata.executionTimeMs,
    cacheHit: false,
    issueCount: (result.issues || []).length
  });

  return result;
}

/**
 * ─────────────────────────────────────────────────────────────────
 * Reconciliação por profissional com drill-down por paciente
 * ─────────────────────────────────────────────────────────────────
 */
export async function getDoctorReconciliation(doctorId, startDate, endDate) {
  const startedAt = Date.now();
  const { start, end } = parseRange(startDate, endDate);

  const [sessions, payments, doctor] = await Promise.all([
    fetchSessions(start, end, ['completed', 'canceled', 'missed', 'scheduled', 'pending']),
    fetchPaidPayments(start, end),
    Doctor.findById(doctorId).select('fullName specialty commissionRules commissionRuleVersion').lean()
  ]);

  const doctorSessions = sessions.filter(s => extractDoctorId(s) === doctorId);
  const doctorPayments = payments.filter(p => {
    if (p.doctor?._id?.toString?.() === doctorId || p.doctor?.toString?.() === doctorId) return true;
    return false;
  });

  // Mapear sessões do período por ID e por appointment
  const sessionMapById = {};
  const sessionMapByAppointment = {};
  for (const session of doctorSessions) {
    sessionMapById[session._id.toString()] = session;
    if (session.appointmentId) {
      sessionMapByAppointment[session.appointmentId.toString()] = session;
    }
  }

  // Vincular pagamentos às sessões do profissional
  const paidSessionIds = new Set();
  const paymentBySession = {};

  for (const payment of doctorPayments) {
    const session = linkPaymentToSession(payment, sessionMapById, sessionMapByAppointment);
    if (session) {
      const sid = session._id.toString();
      paidSessionIds.add(sid);
      if (!paymentBySession[sid]) paymentBySession[sid] = [];
      paymentBySession[sid].push(payment);
    }
  }

  // Agrupar por paciente
  const patientMap = {};

  function ensurePatient(pid, name) {
    if (!patientMap[pid]) {
      patientMap[pid] = {
        patientId: pid,
        patientName: name,
        sessionsCompleted: 0,
        sessionsCancelled: 0,
        sessionsMissed: 0,
        sessionsScheduled: 0,
        production: 0,
        received: 0,
        pending: 0,
        commission: 0,
        lastSession: null,
        nextSession: null,
        packageCredits: 0
      };
    }
    return patientMap[pid];
  }

  for (const session of doctorSessions) {
    const pid = extractPatientId(session);
    if (!pid) continue;

    const patient = ensurePatient(pid, extractPatientName(session));
    const effectiveValue = resolveSessionFinancialValue(session);

    if (session.status === 'completed') {
      patient.sessionsCompleted += 1;
      patient.production += effectiveValue;
      const commission = session.commissionSnapshot?.calculatedCommission
        ?? session.commissionValue
        ?? calculateSessionCommission(doctor, session, session.date);
      patient.commission += commission || 0;

      const sid = session._id.toString();
      if (paidSessionIds.has(sid)) {
        const paidAmount = (paymentBySession[sid] || []).reduce((sum, p) => sum + (p.amount || 0), 0);
        patient.received += paidAmount;
      } else {
        patient.pending += effectiveValue;
      }
    } else if (session.status === 'canceled') {
      patient.sessionsCancelled += 1;
    } else if (session.status === 'missed') {
      patient.sessionsMissed += 1;
    } else if (session.status === 'scheduled' || session.status === 'pending') {
      patient.sessionsScheduled += 1;
    }

    const sessionDate = session.date ? new Date(session.date) : null;
    if (sessionDate) {
      if (!patient.lastSession || sessionDate > new Date(patient.lastSession)) {
        patient.lastSession = toDateString(sessionDate);
      }
      if (session.status === 'scheduled' || session.status === 'pending') {
        if (!patient.nextSession || sessionDate < new Date(patient.nextSession)) {
          patient.nextSession = toDateString(sessionDate);
        }
      }
    }
  }

  const patients = Object.values(patientMap).map(p => ({
    ...p,
    production: round(p.production),
    received: round(p.received),
    pending: round(p.pending),
    commission: round(p.commission)
  })).sort((a, b) => b.pending - a.pending);

  const completedSessions = doctorSessions.filter(s => s.status === 'completed');
  const production = completedSessions.reduce((sum, s) => sum + resolveSessionFinancialValue(s), 0);
  const commissionResult = await calculateDoctorCommission(
    new mongoose.Types.ObjectId(doctorId),
    start,
    end
  );
  const commission = commissionResult.totalCommission;
  const received = doctorPayments
    .filter(p => linkPaymentToSession(p, sessionMapById, sessionMapByAppointment) || p.doctor?._id?.toString?.() === doctorId)
    .reduce((sum, p) => sum + (p.amount || 0), 0);

  const orphanSessions = completedSessions.filter(s => !paidSessionIds.has(s._id.toString()) && classifyPendingSession(s) === 'realIssue').length;
  const commissionMismatch = completedSessions.filter(s => isCommissionMismatch(s, doctor)).length;

  const receivables = { total: 0, particular: 0, insurance: 0, liminar: 0, packageConsumed: 0 };
  for (const s of completedSessions) {
    if (paidSessionIds.has(s._id.toString())) continue;
    const value = resolveSessionFinancialValue(s);
    const type = classifyPendingSession(s);
    receivables.total += value;
    if (type === 'package') receivables.packageConsumed += value;
    else if (type === 'insurance') receivables.insurance += value;
    else if (type === 'liminar') receivables.liminar += value;
    else if (type === 'privatePending') receivables.particular += value;
  }

  const result = {
    period: { start: toDateString(start), end: toDateString(end) },
    doctor: doctor || { _id: doctorId, fullName: 'Desconhecido', specialty: null },
    reconciliation: {
      doctorId,
      doctorName: doctor?.fullName || 'Desconhecido',
      specialty: doctor?.specialty || null,
      activePatients: patients.length,
      completedSessions: completedSessions.length,
      production: round(production),
      received: round(received),
      pending: round(production - received),
      commission: round(commission),
      advances: 0,
      balance: round(commission),
      difference: round(production - received),
      orphanSessions,
      commissionMismatch,
      receivables: {
        total: round(receivables.total),
        particular: round(receivables.particular),
        insurance: round(receivables.insurance),
        liminar: round(receivables.liminar),
        packageConsumed: round(receivables.packageConsumed)
      },
      patients
    },
    metadata: {
      generatedAt: new Date().toISOString(),
      executionTimeMs: Date.now() - startedAt,
      timezone: TIMEZONE,
      sessionsAnalyzed: sessions.length,
      paymentsAnalyzed: payments.length
    }
  };

  logMetric('ReconciliationService', 'getDoctorReconciliation', {
    doctorId,
    startDate,
    endDate,
    executionTimeMs: result.metadata.executionTimeMs,
    cacheHit: false,
    sessionCount: sessions.length,
    paymentCount: payments.length,
    patientCount: patients.length
  });

  return result;
}

/**
 * ─────────────────────────────────────────────────────────────────
 * Detalhamento de sessões por paciente
 * ─────────────────────────────────────────────────────────────────
 */
export async function getPatientSessionDetails(doctorId, patientId, startDate, endDate) {
  const { start, end } = parseRange(startDate, endDate);

  const [sessions, payments] = await Promise.all([
    fetchSessions(start, end, ['completed', 'canceled', 'missed', 'scheduled', 'pending']),
    fetchPaidPayments(start, end)
  ]);

  const patientSessions = sessions.filter(s => {
    return extractDoctorId(s) === doctorId && extractPatientId(s) === patientId;
  });

  const sessionMapById = {};
  const sessionMapByAppointment = {};
  for (const session of patientSessions) {
    sessionMapById[session._id.toString()] = session;
    if (session.appointmentId) {
      sessionMapByAppointment[session.appointmentId.toString()] = session;
    }
  }

  const paymentBySession = {};
  for (const payment of payments) {
    const session = linkPaymentToSession(payment, sessionMapById, sessionMapByAppointment);
    if (session) {
      const sid = session._id.toString();
      if (!paymentBySession[sid]) paymentBySession[sid] = [];
      paymentBySession[sid].push(payment);
    }
  }

  return patientSessions
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map(s => {
      const sid = s._id.toString();
      const paidPayments = paymentBySession[sid] || [];
      const paidAmount = paidPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
      const effectiveValue = resolveSessionFinancialValue(s);

      return {
        sessionId: s._id,
        date: toDateString(s.date),
        time: s.time || null,
        status: s.status,
        sessionType: s.sessionType,
        sessionValue: s.sessionValue,
        effectiveValue,
        commissionValue: s.commissionSnapshot?.calculatedCommission ?? s.commissionValue ?? 0,
        paymentStatus: paidAmount >= effectiveValue ? 'paid' : paidAmount > 0 ? 'partial' : s.paymentStatus || 'pending',
        paidAmount: round(paidAmount),
        pendingAmount: round(Math.max(0, effectiveValue - paidAmount)),
        payments: paidPayments.map(p => ({
          paymentId: p._id,
          amount: p.amount,
          method: p.paymentMethod,
          billingType: p.billingType,
          date: toDateString(p.financialDate || p.paymentDate || p.createdAt)
        }))
      };
    });
}

/**
 * ─────────────────────────────────────────────────────────────────
 * Ranking de diferenças por profissional
 * ─────────────────────────────────────────────────────────────────
 */
export async function getDoctorRankingDifferences(startDate, endDate) {
  const result = await buildReconciliation(startDate, endDate);
  return result.byDoctor.slice().sort((a, b) => b.difference - a.difference);
}

/**
 * ─────────────────────────────────────────────────────────────────
 * Top problemas financeiros
 * ─────────────────────────────────────────────────────────────────
 */
export async function getTopFinancialIssues(startDate, endDate, limit = 20) {
  const startedAt = Date.now();
  const cacheKey = _issuesCacheKey(startDate, endDate, limit);
  const cached = _issuesCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < ISSUES_CACHE_TTL) {
    logMetric('ReconciliationService', 'getTopFinancialIssues', {
      startDate,
      endDate,
      limit,
      executionTimeMs: Date.now() - startedAt,
      cacheHit: true,
      issueCount: cached.data.length
    });
    return cached.data;
  }

  const { start, end } = parseRange(startDate, endDate);

  const [sessions, payments] = await Promise.all([
    fetchCompletedSessions(start, end),
    fetchPaidPayments(start, end)
  ]);

  const sessionMapById = {};
  const sessionMapByAppointment = {};
  for (const session of sessions) {
    sessionMapById[session._id.toString()] = session;
    if (session.appointmentId) {
      sessionMapByAppointment[session.appointmentId.toString()] = session;
    }
  }

  const paidSessionIds = new Set();
  const issues = [];

  // Sessões órfãs
  // ATENÇÃO — PADRÃO PER-SESSION:
  // Pacientes por sessão pagam NO DIA da sessão via tabela financeira.
  // Isso cria um `session_payment` (kind) sem `session` nem `appointment` no banco
  // porque o fluxo antigo de create-sync não salvava a referência.
  // Esses payments APARECEM AQUI como orphan_payment mas são legítimos.
  // Fix da fonte: create-sync agora envia appointmentId (a partir de 2026-06-15).
  // Fix histórico: script fix-orphan-paid-payments.js marca isFromPackage onde aplicável;
  // per-session histórico sem link ainda aparece como orphan_payment — não é erro financeiro.
  for (const payment of payments) {
    // debt_settlement e credit_balance são recebimentos autônomos — não se vinculam a sessão por design
    if (payment.kind === 'debt_settlement' || payment.kind === 'credit_balance') continue;

    const session = linkPaymentToSession(payment, sessionMapById, sessionMapByAppointment);
    if (session) {
      paidSessionIds.add(session._id.toString());
    } else {
      issues.push({
        type: 'orphan_payment',
        severity: 'medium',
        doctorId: extractDoctorId(payment),
        doctorName: extractDoctorName(payment),
        patientId: extractPatientId(payment),
        amount: payment.amount,
        description: 'Pagamento sem sessão vinculada',
        date: toDateString(payment.financialDate || payment.paymentDate || payment.createdAt),
        entityId: payment._id
      });
    }
  }

  for (const session of sessions) {
    if (paidSessionIds.has(session._id.toString())) continue;

    const pendingType = classifyPendingSession(session);
    if (pendingType === 'package' || pendingType === 'insurance' || pendingType === 'liminar') continue;

    const isPrivatePending = pendingType === 'privatePending';
    issues.push({
      type: isPrivatePending ? 'private_pending' : 'orphan_session',
      severity: isPrivatePending ? 'medium' : 'high',
      category: pendingType,
      doctorId: extractDoctorId(session),
      doctorName: extractDoctorName(session),
      patientId: extractPatientId(session),
      patientName: extractPatientName(session),
      amount: resolveSessionFinancialValue(session),
      description: isPrivatePending
        ? 'Sessão particular pendente de pagamento'
        : 'Sessão realizada sem pagamento vinculado',
      date: toDateString(session.date),
      entityId: session._id
    });
  }

  // Comissões sem valor calculado
  for (const session of sessions) {
    if (isCommissionMismatch(session)) {
      issues.push({
        type: 'commission_mismatch',
        severity: 'low',
        doctorId: extractDoctorId(session),
        doctorName: extractDoctorName(session),
        patientId: extractPatientId(session),
        patientName: extractPatientName(session),
        amount: resolveSessionFinancialValue(session),
        description: 'Sessão sem comissão calculada no fluxo de fechamento',
        date: toDateString(session.date),
        entityId: session._id
      });
    }
  }

  // Sessões sem profissional
  for (const session of sessions) {
    if (!extractDoctorId(session)) {
      issues.push({
        type: 'missing_doctor',
        severity: 'high',
        doctorId: null,
        doctorName: 'Sem profissional',
        patientId: extractPatientId(session),
        patientName: extractPatientName(session),
        amount: resolveSessionFinancialValue(session),
        description: 'Sessão sem profissional associado',
        date: toDateString(session.date),
        entityId: session._id
      });
    }
  }

  const result = issues
    .sort((a, b) => {
      const severityOrder = { high: 0, medium: 1, low: 2 };
      if (severityOrder[a.severity] !== severityOrder[b.severity]) {
        return severityOrder[a.severity] - severityOrder[b.severity];
      }
      return b.amount - a.amount;
    })
    .slice(0, limit);

  if (_issuesCache.size > 50) _issuesCache.clear();
  _issuesCache.set(cacheKey, { data: result, ts: Date.now() });

  logMetric('ReconciliationService', 'getTopFinancialIssues', {
    startDate,
    endDate,
    limit,
    executionTimeMs: Date.now() - startedAt,
    cacheHit: false,
    sessionCount: sessions.length,
    paymentCount: payments.length,
    issueCount: result.length
  });

  return result;
}

/**
 * ─────────────────────────────────────────────────────────────────
 * Sessões órfãs (completed sem pagamento vinculado)
 * ─────────────────────────────────────────────────────────────────
 */
export async function getOrphanSessions(startDate, endDate) {
  const { start, end } = parseRange(startDate, endDate);

  const [sessions, payments] = await Promise.all([
    fetchCompletedSessions(start, end),
    fetchPaidPayments(start, end)
  ]);

  const sessionMapById = {};
  const sessionMapByAppointment = {};
  for (const session of sessions) {
    sessionMapById[session._id.toString()] = session;
    if (session.appointmentId) {
      sessionMapByAppointment[session.appointmentId.toString()] = session;
    }
  }

  const paidSessionIds = new Set();
  for (const payment of payments) {
    if (payment.session) {
      paidSessionIds.add(toObjectId(payment.session));
    }
    if (payment.appointment) {
      const session = sessionMapByAppointment[toObjectId(payment.appointment)];
      if (session) paidSessionIds.add(session._id.toString());
    }
  }

  return sessions
    .filter(s => !paidSessionIds.has(s._id.toString()) && !isSessionCovered(s))
    .map(s => ({
      sessionId: s._id,
      date: toDateString(s.date),
      patientName: s.patient?.fullName || null,
      doctorId: extractDoctorId(s),
      doctorName: extractDoctorName(s),
      sessionValue: s.sessionValue,
      effectiveValue: resolveSessionFinancialValue(s),
      commissionValue: s.commissionSnapshot?.calculatedCommission ?? s.commissionValue,
      paymentStatus: s.paymentStatus
    }));
}

/**
 * ─────────────────────────────────────────────────────────────────
 * Pagamentos órfãos (paid sem session vinculada)
 * ─────────────────────────────────────────────────────────────────
 */
export async function getOrphanPayments(startDate, endDate) {
  const { start, end } = parseRange(startDate, endDate);

  const [sessions, payments] = await Promise.all([
    fetchCompletedSessions(start, end),
    fetchPaidPayments(start, end)
  ]);

  const sessionMapById = {};
  const sessionMapByAppointment = {};
  for (const session of sessions) {
    sessionMapById[session._id.toString()] = session;
    if (session.appointmentId) {
      sessionMapByAppointment[session.appointmentId.toString()] = session;
    }
  }

  return payments
    .filter(p => !linkPaymentToSession(p, sessionMapById, sessionMapByAppointment))
    .map(p => ({
      paymentId: p._id,
      date: toDateString(p.financialDate || p.paymentDate || p.createdAt),
      amount: p.amount,
      paymentMethod: p.paymentMethod,
      billingType: p.billingType,
      doctorId: extractDoctorId(p),
      doctorName: extractDoctorName(p),
      patientId: p.patient?.toString?.() || p.patientId || null
    }));
}
