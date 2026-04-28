/**
 * ==============================================================================
 * FINANCIAL ENGINE - Source of Truth for Financial Calculations
 * ==============================================================================
 * 
 * 🏛️ REGRA DE DOMÍNIO DEFINITIVA (V2 PURA):
 * 
 *   💰 Payment  = dinheiro real  →  SOURCE OF TRUTH FINANCEIRA
 *   📅 Session  = execução clínica →  NUNCA fonte de cálculo financeiro
 *   📊 Ledger   = histórico interno →  APENAS referência, não verdade
 * 
 * ⚠️  PROIBIDO usar Session.sessionValue para qualquer cálculo financeiro.
 * ⚠️  PROIBIDO usar Session.status como proxy de status financeiro.
 * 
 * Este engine é o CORE FINANCEIRO da aplicação. TODAS as rotas V2 devem
 * usá-lo. A V1 é legado e será progressivamente desativada.
 * ==============================================================================
 */

// 🔒 GUARD CLAUSE ANTI-REGRESSÃO: rejeita explicitamente uso de Session
const SESSION_AS_SOURCE_ERROR = '[FINANCIAL_GUARD] 🚨 PROIBIDO usar Session como fonte financeira. Use financialEngine.js com Payment model.';

import Payment from '../models/Payment.js';
import mongoose from 'mongoose';

/**
 * Calcula snapshot financeiro baseado em Payment (source of truth).
 * 
 * @param {Object} params
 * @param {string|Date} params.startDate - Data inicial (inclusive)
 * @param {string|Date} params.endDate - Data final (inclusive)
 * @param {string} params.clinicId - ID da clínica (default: 'default')
 * @param {string[]} params.status - Status dos payments (default: ['pending', 'partial'])
 * @param {string} params.patientId - Filtrar por paciente específico (opcional)
 * @param {boolean} params.groupByPatient - Agrupar resultado por paciente
 * @param {boolean} params.groupByDoctor - Agrupar resultado por profissional
 * @param {boolean} params.populate - Fazer populate de doctor, patient, appointment
 */
export async function calculateFinancialSnapshot({
  startDate,
  endDate,
  clinicId = 'default',
  status = ['pending', 'partial'],
  patientId = null,
  groupByPatient = true,
  groupByDoctor = true,
  populate = true
} = {}) {
  const start = Date.now();

  // ── Build query ──
  const query = {
    status: { $in: status },
    clinicId,
    kind: { $ne: 'package_consumed' } // 🛡️ package_consumed NÃO é caixa
  };

  // Date filter: usa paymentDate (data do pagamento/agendamento) ou serviceDate
  // paymentDate e serviceDate são strings 'YYYY-MM-DD' no DB
  const dateConditions = [];
  if (startDate || endDate) {
    const dateFilter = {};
    if (startDate) dateFilter.$gte = startDate;
    if (endDate) dateFilter.$lte = endDate;
    
    dateConditions.push({ paymentDate: dateFilter });
    dateConditions.push({ serviceDate: dateFilter });
  }

  const patientConditions = [];
  if (patientId) {
    const pid = patientId.toString();
    patientConditions.push({ patient: new mongoose.Types.ObjectId(pid) });
    patientConditions.push({ patientId: pid });
  }

  // Monta $and para não sobrescrever condições
  const andConditions = [];
  if (dateConditions.length > 0) {
    andConditions.push({ $or: dateConditions });
  }
  if (patientConditions.length > 0) {
    andConditions.push({ $or: patientConditions });
  }
  if (andConditions.length > 0) {
    query.$and = andConditions;
    delete query.$or;
  }

  // ── Fetch payments ──
  let paymentsQuery = Payment.find(query);

  if (populate) {
    paymentsQuery = paymentsQuery
      .populate('patient', 'fullName phone email')
      .populate('doctor', 'fullName specialty')
      .populate('appointment', 'date time operationalStatus sessionType')
      .populate('session', 'date time status sessionType serviceType sessionValue');
  }

  const payments = await paymentsQuery.lean();

  // ── Calculate totals ──
  let total = 0;
  const byPatient = {};
  const byDoctor = {};
  const bySpecialty = {};
  const byBillingType = { particular: { total: 0, count: 0, items: [] }, convenio: { total: 0, count: 0, items: [] } };

  for (const p of payments) {
    const value = p.amount || 0;
    total += value;

    // ── Agrupamento por paciente ──
    if (groupByPatient && p.patient) {
      const pid = p.patient._id?.toString() || p.patientId;
      if (!byPatient[pid]) {
        byPatient[pid] = {
          patient: p.patient,
          patientId: pid,
          total: 0,
          count: 0,
          items: []
        };
      }
      byPatient[pid].total += value;
      byPatient[pid].count += 1;
      byPatient[pid].items.push(normalizePaymentItem(p));
    }

    // ── Agrupamento por profissional ──
    if (groupByDoctor && p.doctor) {
      const did = p.doctor._id?.toString();
      if (!byDoctor[did]) {
        byDoctor[did] = {
          doctor: p.doctor,
          doctorId: did,
          total: 0,
          count: 0,
          items: []
        };
      }
      byDoctor[did].total += value;
      byDoctor[did].count += 1;
      byDoctor[did].items.push(normalizePaymentItem(p));
    }

    // ── Agrupamento por especialidade ──
    const specialty = resolveSpecialty(p);
    if (specialty) {
      if (!bySpecialty[specialty]) {
        bySpecialty[specialty] = { total: 0, count: 0, items: [] };
      }
      bySpecialty[specialty].total += value;
      bySpecialty[specialty].count += 1;
      bySpecialty[specialty].items.push(normalizePaymentItem(p));
    }

    // ── Agrupamento por billingType ──
    const btype = p.billingType === 'convenio' || p.billingType === 'insurance' ? 'convenio' : 'particular';
    byBillingType[btype].total += value;
    byBillingType[btype].count += 1;
    byBillingType[btype].items.push(normalizePaymentItem(p));
  }

  const duration = Date.now() - start;
  console.log(`[FinancialEngine] Snapshot calculado em ${duration}ms | Payments: ${payments.length} | Total: ${total}`);

  return {
    meta: {
      calculatedAt: new Date().toISOString(),
      durationMs: duration,
      source: 'Payment',
      criteria: { startDate, endDate, status, clinicId, patientId }
    },
    total,
    count: payments.length,
    byPatient,
    byDoctor,
    bySpecialty,
    byBillingType,
    payments: populate ? null : payments // só retorna raw se não fez populate
  };
}

/**
 * Calcula "pendentes" (a receber) para o dashboard.
 * Wrapper semântico em cima de calculateFinancialSnapshot.
 */
export async function calculatePendentesEngine({ startDate, endDate, clinicId = 'default' } = {}) {
  return calculateFinancialSnapshot({
    startDate,
    endDate,
    clinicId,
    status: ['pending', 'partial'],
    groupByPatient: true,
    groupByDoctor: true
  });
}

/**
 * Calcula "a receber" (receitas futuras/previsão).
 * Usa payments com status 'pending' e data futura, ou 'paid' no período.
 */
export async function calculateAReceberEngine({ startDate, endDate, clinicId = 'default' } = {}) {
  // Para receitas já realizadas (paid no período)
  const paid = await calculateFinancialSnapshot({
    startDate,
    endDate,
    clinicId,
    status: ['paid', 'recognized'],
    groupByPatient: false,
    groupByDoctor: false
  });

  // Para receitas pendentes (pending no período)
  const pending = await calculateFinancialSnapshot({
    startDate,
    endDate,
    clinicId,
    status: ['pending', 'partial'],
    groupByPatient: false,
    groupByDoctor: false
  });

  return {
    paid: { total: paid.total, count: paid.count },
    pending: { total: pending.total, count: pending.count },
    projected: paid.total + pending.total
  };
}

/**
 * Retorna payments pendentes de um paciente específico.
 * Usado no modal de débitos por paciente.
 */
export async function getPatientPendingPayments(patientId, { populate = true } = {}) {
  if (!patientId) return { total: 0, count: 0, items: [] };

  const query = {
    status: { $in: ['pending', 'partial'] },
    $or: [
      { patient: new mongoose.Types.ObjectId(patientId.toString()) },
      { patientId: patientId.toString() }
    ]
  };

  let q = Payment.find(query).sort({ paymentDate: -1 });
  if (populate) {
    q = q
      .populate('patient', 'fullName phone email')
      .populate('doctor', 'fullName specialty')
      .populate({ path: 'appointment', select: 'date time operationalStatus sessionType doctor', populate: { path: 'doctor', select: 'fullName specialty' } })
      .populate('session', 'date time status sessionType serviceType sessionValue');
  }

  const items = await q.lean();
  const total = items.reduce((s, p) => s + (p.amount || 0), 0);

  return {
    patientId: patientId.toString(),
    total,
    count: items.length,
    items: items.map(normalizePaymentItem)
  };
}

// ==============================================================================
// HELPERS
// ==============================================================================

/**
 * Resolve especialidade com fallback chain robusto.
 * Ignora valores genéricos (evaluation, individual_session, session, package_session, etc).
 * Prioridade: session.sessionType > doctor.specialty > payment.sessionType > payment.serviceType > 'N/A'
 */
function resolveSpecialty(payment) {
  if (!payment) return 'N/A';

  const genericValues = new Set([
    'evaluation', 'individual_session', 'session', 'package_session',
    'avaliacao', 'sessao', 'sessao_avulsa', 'pacote', 'package',
    'current', 'undefined', 'null', ''
  ]);

  function isValidSpec(val) {
    if (!val) return false;
    const normalized = String(val).toLowerCase().trim();
    return normalized.length > 0 && !genericValues.has(normalized);
  }

  // 1. Session.sessionType / serviceType
  if (isValidSpec(payment.session?.sessionType)) return normalizeSpecialty(payment.session.sessionType);
  if (isValidSpec(payment.session?.serviceType)) return normalizeSpecialty(payment.session.serviceType);

  // 2. Doctor.specialty
  if (isValidSpec(payment.doctor?.specialty)) return normalizeSpecialty(payment.doctor.specialty);

  // 3. Payment.sessionType
  if (isValidSpec(payment.sessionType)) return normalizeSpecialty(payment.sessionType);

  // 4. Payment.serviceType
  if (isValidSpec(payment.serviceType)) return normalizeSpecialty(payment.serviceType);

  // 5. Appointment.sessionType
  if (isValidSpec(payment.appointment?.sessionType)) return normalizeSpecialty(payment.appointment.sessionType);

  return 'N/A';
}

/**
 * Normaliza nomes de especialidade (sinônimos, underscore, etc).
 */
function normalizeSpecialty(raw) {
  if (!raw) return 'N/A';
  const s = String(raw).toLowerCase().trim().replace(/[_-]/g, ' ');
  
  const map = {
    'fonoaudiologia': 'Fonoaudiologia',
    'fono': 'Fonoaudiologia',
    'fonoaudiologa': 'Fonoaudiologia',
    'psicologia': 'Psicologia',
    'psico': 'Psicologia',
    'psicologa': 'Psicologia',
    'terapia ocupacional': 'Terapia Ocupacional',
    'terapiaocupacional': 'Terapia Ocupacional',
    'to': 'Terapia Ocupacional',
    'terapeuta ocupacional': 'Terapia Ocupacional',
    'pedagogia': 'Pedagogia',
    'neuropsicopedagogia': 'Neuropsicopedagogia',
    'nutricao': 'Nutrição',
    'nutri': 'Nutrição'
  };

  return map[s] || raw.charAt(0).toUpperCase() + raw.slice(1);
}

/**
 * Normaliza um payment para o formato padronizado do engine.
 */
function normalizePaymentItem(p) {
  return {
    _id: p._id?.toString(),
    amount: p.amount || 0,
    status: p.status,
    paymentMethod: p.paymentMethod,
    billingType: p.billingType || 'particular',
    paymentDate: p.paymentDate,
    serviceDate: p.serviceDate,
    serviceType: p.serviceType,
    sessionType: p.sessionType,
    kind: p.kind,
    notes: p.notes,
    specialty: resolveSpecialty(p),
    patient: p.patient ? {
      _id: p.patient._id?.toString(),
      fullName: p.patient.fullName,
      phone: p.patient.phone,
      email: p.patient.email
    } : { _id: p.patientId, fullName: 'Desconhecido' },
    doctor: p.doctor ? {
      _id: p.doctor._id?.toString(),
      fullName: p.doctor.fullName,
      specialty: p.doctor.specialty
    } : null,
    appointment: p.appointment ? {
      _id: p.appointment._id?.toString(),
      date: p.appointment.date,
      time: p.appointment.time,
      operationalStatus: p.appointment.operationalStatus,
      sessionType: p.appointment.sessionType,
      doctor: p.appointment.doctor ? {
        _id: p.appointment.doctor._id?.toString(),
        fullName: p.appointment.doctor.fullName,
        specialty: p.appointment.doctor.specialty
      } : null
    } : null,
    session: p.session ? {
      _id: p.session._id?.toString(),
      date: p.session.date,
      time: p.session.time,
      status: p.session.status,
      sessionType: p.session.sessionType,
      serviceType: p.session.serviceType,
      sessionValue: p.session.sessionValue
    } : null,
    packageId: p.package?.toString?.() || p.package,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt
  };
}

/**
 * Validação/Auditoria: compara total de Payment vs total derivado de Session.
 * Retorna discrepâncias para análise.
 */
export async function auditPaymentVsSession({ startDate, endDate } = {}) {
  const { default: Session } = await import('../models/Session.js');

  const [paymentTotalAgg, sessionTotalAgg] = await Promise.all([
    Payment.aggregate([
      { $match: { status: { $in: ['pending', 'partial'] }, paymentDate: { $gte: new Date(startDate), $lte: new Date(endDate) } } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]),
    Session.aggregate([
      { $match: { status: 'completed', date: { $gte: startDate, $lte: endDate } } },
      { $group: { _id: null, total: { $sum: '$sessionValue' } } }
    ])
  ]);

  const paymentTotal = paymentTotalAgg[0]?.total || 0;
  const sessionTotal = sessionTotalAgg[0]?.total || 0;

  return {
    paymentTotal,
    sessionTotal,
    difference: paymentTotal - sessionTotal,
    discrepancyPercent: sessionTotal > 0 ? ((paymentTotal - sessionTotal) / sessionTotal * 100).toFixed(2) + '%' : 'N/A',
    sourceOfTruth: 'Payment',
    recommendation: paymentTotal !== sessionTotal
      ? 'DISCREPANCIA DETECTADA: Usar Payment como fonte da verdade.'
      : 'Totais consistentes.'
  };
}

export default {
  calculateFinancialSnapshot,
  calculatePendentesEngine,
  calculateAReceberEngine,
  getPatientPendingPayments,
  auditPaymentVsSession
};
