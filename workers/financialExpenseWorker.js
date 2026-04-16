/**
 * 💸 Financial Expense Worker — V2
 *
 * Princípio: ZERO runtime calculation no dashboard.
 * Todo evento de despesa incrementa a projeção diária de despesas.
 *
 * Eventos suportados:
 * - EXPENSE_CREATED          → despesa real (fixa, variável, comissão)
 * - SESSION_COMPLETED        → provisão de comissão por sessão
 */

import FinancialDailyExpenseSnapshot from '../models/FinancialDailyExpenseSnapshot.js';
import Expense from '../models/Expense.js';
import Session from '../models/Session.js';
import Doctor from '../models/Doctor.js';
import { createContextLogger } from '../utils/logger.js';

const log = createContextLogger(null, 'FinancialExpenseWorker');

const toDateStr = (d) => {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return date.toISOString().split('T')[0];
};

function normalizeExpenseType(type) {
  if (!type) return 'other';
  const t = type.toString().toLowerCase();
  if (t.includes('comiss') || t.includes('commission')) return 'commission';
  if (t.includes('fix')) return 'fixed';
  if (t.includes('vari')) return 'variable';
  return 'other';
}

async function updateSnapshot({ date, clinicId = 'default', eventId = null }, ops) {
  const dateStr = toDateStr(date);
  if (!dateStr) return;

  // 🛡️ Idempotência
  if (eventId) {
    const exists = await FinancialDailyExpenseSnapshot.findOne(
      { date: dateStr, clinicId, processedEvents: eventId },
      { _id: 1 }
    ).lean();
    if (exists) {
      log.info('expense_snapshot_event_already_processed', 'Evento já aplicado', { dateStr, clinicId, eventId });
      return;
    }
  }

  const update = {
    $set: { updatedAt: new Date(), lastEventAt: new Date() },
  };

  if (ops.$inc && Object.keys(ops.$inc).length) {
    update.$inc = ops.$inc;
  }
  if (ops.$set && Object.keys(ops.$set).length) {
    Object.assign(update.$set, ops.$set);
  }
  if (eventId) {
    update.$addToSet = { processedEvents: eventId };
  }

  try {
    await FinancialDailyExpenseSnapshot.findOneAndUpdate(
      { date: dateStr, clinicId },
      update,
      { upsert: true, new: true }
    );
  } catch (err) {
    log.error('expense_snapshot_update_failed', err.message, { dateStr, clinicId, eventId, ops });
  }
}

// ─── EXPENSE EVENTS ─────────────────────────────────────────────────────────

export async function onExpenseCreated(payload) {
  const expense = await Expense.findById(payload.expenseId || payload._id)
    .select('date amount type category doctor status')
    .lean();

  if (!expense || expense.status === 'canceled' || expense.status === 'cancelado') return;

  const dateStr = expense.date || toDateStr(new Date());
  const amount = Number(expense.amount) || 0;
  const expenseType = normalizeExpenseType(expense.type || expense.category);

  const inc = {
    'expenses.total': amount,
    [`expenses.byType.${expenseType}`]: amount,
  };

  await updateSnapshot(
    { date: dateStr, clinicId: payload.clinicId || 'default', eventId: payload.eventId || payload._id || `exp_${Date.now()}` },
    { $inc: inc }
  );

  // Se tiver doctor, atualiza no array de profissionais
  if (expense.doctor) {
    const profId = expense.doctor.toString();
    const isCommission = expenseType === 'commission';

    await FinancialDailyExpenseSnapshot.findOneAndUpdate(
      { date: dateStr, clinicId: payload.clinicId || 'default', 'professionals.professionalId': profId },
      {
        $set: { updatedAt: new Date(), lastEventAt: new Date() },
        $inc: {
          ...(isCommission ? { 'professionals.$.commission': amount } : {}),
        }
      },
      { upsert: false }
    );

    await FinancialDailyExpenseSnapshot.findOneAndUpdate(
      { date: dateStr, clinicId: payload.clinicId || 'default', 'professionals.professionalId': { $ne: profId } },
      {
        $set: { updatedAt: new Date(), lastEventAt: new Date() },
        $push: {
          professionals: {
            professionalId: profId,
            commission: isCommission ? amount : 0,
            commissionProvisao: 0,
            countSessions: 0,
          }
        }
      },
      { upsert: false }
    );
  }
}

// ─── SESSION COMMISSION PROVISION ───────────────────────────────────────────

async function calculateSessionCommission(session) {
  if (!session || !session.doctor) return 0;

  const doctor = await Doctor.findById(session.doctor).select('commissionRules').lean();
  if (!doctor || !doctor.commissionRules) return 0;

  const sessionType = session.sessionType || session.package?.sessionType;

  // Avaliação regular
  if (sessionType === 'evaluation' || session.serviceType === 'evaluation') {
    return doctor.commissionRules.evaluationSession || doctor.commissionRules.standardSession || 60;
  }

  // Neuropsicologia é paga em lote (pacote) — não provisionamos por sessão individual
  if (sessionType === 'neuropsych_evaluation') {
    return 0;
  }

  // Sessão padrão: verificar convênio específico
  const insuranceName = getInsuranceName(session);
  const byInsuranceRules = doctor.commissionRules.byInsurance || {};
  const insuranceValue = byInsuranceRules[insuranceName?.toLowerCase()];

  return insuranceValue || doctor.commissionRules.standardSession || 60;
}

function getInsuranceName(session) {
  if (session.insuranceGuide?.insurance) return session.insuranceGuide.insurance;
  if (session.package?.insuranceProvider) return session.package.insuranceProvider;
  if (session.paymentMethod === 'convenio') return 'convenio';
  return null;
}

export async function onSessionCompletedForExpense(payload) {
  let session;
  if (payload.doctor && payload.date && payload.package && typeof payload.package === 'object') {
    // Payload já vem completo (ex: backfill) — evita lookup DB e dependências de modelos
    session = payload;
  } else {
    session = await Session.findById(payload.sessionId || payload._id)
      .select('date doctor sessionValue paymentMethod package status sessionType serviceType insuranceGuide')
      .populate('package', 'sessionType insuranceProvider')
      .populate('insuranceGuide', 'insurance')
      .lean();
  }

  if (!session || session.status !== 'completed') return;

  const dateStr = toDateStr(session.date);
  if (!dateStr) return;

  const commissionValue = await calculateSessionCommission(session);
  if (commissionValue <= 0) return;

  const inc = {
    'expenses.total': commissionValue,
    'expenses.byType.commission': commissionValue,
  };

  await updateSnapshot(
    { date: dateStr, clinicId: payload.clinicId || 'default', eventId: payload.eventId || payload._id || `exp_sess_${Date.now()}` },
    { $inc: inc }
  );

  // Atualiza profissional
  if (session.doctor) {
    const profId = session.doctor.toString();

    await FinancialDailyExpenseSnapshot.findOneAndUpdate(
      { date: dateStr, clinicId: payload.clinicId || 'default', 'professionals.professionalId': profId },
      {
        $set: { updatedAt: new Date(), lastEventAt: new Date() },
        $inc: {
          'professionals.$.commissionProvisao': commissionValue,
          'professionals.$.countSessions': 1,
        }
      },
      { upsert: false }
    );

    await FinancialDailyExpenseSnapshot.findOneAndUpdate(
      { date: dateStr, clinicId: payload.clinicId || 'default', 'professionals.professionalId': { $ne: profId } },
      {
        $set: { updatedAt: new Date(), lastEventAt: new Date() },
        $push: {
          professionals: {
            professionalId: profId,
            commission: 0,
            commissionProvisao: commissionValue,
            countSessions: 1,
          }
        }
      },
      { upsert: false }
    );
  }
}

// ─── ROUTER / ENTRYPOINT ────────────────────────────────────────────────────

export async function processExpenseEvent(eventType, payload) {
  switch (eventType) {
    case 'EXPENSE_CREATED':
    case 'EXPENSE_CONFIRMED':
      return onExpenseCreated(payload);
    case 'SESSION_COMPLETED':
      return onSessionCompletedForExpense(payload);
    default:
      return;
  }
}

export default { processExpenseEvent };
