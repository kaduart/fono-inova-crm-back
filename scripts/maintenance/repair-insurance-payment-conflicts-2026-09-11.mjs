#!/usr/bin/env node

/**
 * Repara os oito conflitos de Payment de convênio que não pertencem à guia
 * 16173377 do Ícaro (essa guia tem reparo próprio e mais amplo).
 *
 * - sete sessões reais recebem um NOVO Payment ativo; registros cancelados ou
 *   void permanecem intocados como histórico financeiro;
 * - a sessão fantasma do Benjamim é revertida operacionalmente e continua sem
 *   recebível ativo;
 * - nenhuma guia é consumida ou estornada por este script;
 * - dry-run é o padrão. Use --apply somente após revisar a pré-checagem.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(scriptDir, '../../.env') });

const APPLY = process.argv.includes('--apply');
const SOURCE = 'repair_insurance_payment_conflicts_2026_09_11';
const ACTIVE_PAYMENT_STATUSES = new Set(['pending', 'pending_billing', 'billed', 'received', 'paid', 'partial']);
const ACTIVE_INSURANCE_STATUSES = new Set(['pending_billing', 'billed', 'received']);
const TERMINAL_PAYMENT_STATUSES = new Set([
  'canceled', 'cancelled', 'cancelado', 'void', 'refunded',
  'converted_to_package', 'recognized', 'consumed'
]);

const RECEIVABLE_TARGETS = [
  { sessionId: '6a1dc25d4bafb710ab160f45', date: '2026-06-01', time: '17:20', guideId: '6a1dc2224bafb710ab160eb8', guide: '3050', amount: 140, patient: 'Davi Felipe Araújo' },
  { sessionId: '6a1dc25d4bafb710ab160f43', date: '2026-06-08', time: '17:20', guideId: '6a1dc2224bafb710ab160eb8', guide: '3050', amount: 140, patient: 'Davi Felipe Araújo' },
  { sessionId: '6a1dc25d4bafb710ab160f42', date: '2026-06-15', time: '16:00', guideId: '6a1dc2224bafb710ab160eb8', guide: '3050', amount: 140, patient: 'Davi Felipe Araújo' },
  { sessionId: '6a1dc25d4bafb710ab160f40', date: '2026-06-22', time: '16:00', guideId: '6a1dc2224bafb710ab160eb8', guide: '3050', amount: 140, patient: 'Davi Felipe Araújo' },
  { sessionId: '6a1dc2eb4bafb710ab1610ad', date: '2026-06-22', time: '16:40', guideId: '6a1dc2d44bafb710ab161051', guide: '3052', amount: 140, patient: 'Davi Felipe Araújo' },
  { sessionId: '69d67dfe19c6571d8c76dbc5', date: '2026-05-15', time: '10:00', guideId: '69d67c4919c6571d8c76dae9', guide: '16007195', amount: 80, patient: 'Isabela Ferreira De Mendonca' },
  { sessionId: '69d646e885f1fc2849c5b662', date: '2026-05-04', time: '16:00', guideId: '69d53541d24df1c9ef974d80', guide: '15650231', amount: 80, patient: 'Nicolas Lucca' },
];

const PHANTOM_TARGET = {
  sessionId: '6a0c540580cc438aa0b67d3c',
  appointmentId: '6a0c540466aec15712d6d5cb',
  paymentId: '6a0c540480cc438aa0b67d36',
  date: '2026-06-02',
  time: '18:20',
  guideId: '69c2eb9f5c4ad17fefccc5b8',
  guide: '15924845',
  amount: 80,
  patient: 'Benjamim Rocha Simão',
};

const REPAIR_REASON = 'Reparo auditado em 2026-09-11: sessão real de convênio sem Payment ativo; recebível recriado sem ressuscitar o registro financeiro encerrado.';
const PHANTOM_REASON = 'Reversão administrativa em 2026-09-11: sessão sem lastro em protocolo físico assinado (guia 15924845); não faturar.';

function oid(value) {
  return new mongoose.Types.ObjectId(value);
}

function sameId(left, right) {
  return String(left || '') === String(right || '');
}

function dateKey(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);
}

function money(value) {
  return Number(value || 0).toFixed(2);
}

function isEligible(payment) {
  return payment?.billingType === 'convenio'
    && ACTIVE_PAYMENT_STATUSES.has(payment.status)
    && ACTIVE_INSURANCE_STATUSES.has(payment.insurance?.status)
    && Number(payment.amount || 0) > 0;
}

function hasBillingEvidence(payment) {
  return Boolean(
    payment?.billingBatchId
    || payment?.insuranceBillingBatch
    || payment?.invoiceId
    || payment?.fiscalInvoice
    || payment?.insurance?.billedAt
    || payment?.insurance?.receivedAt
    || ['billed', 'received', 'paid', 'partial'].includes(payment?.status)
    || ['billed', 'received'].includes(payment?.insurance?.status)
  );
}

function appendNote(current, text) {
  const value = String(current || '').trim();
  return value ? `${value}\n${text}` : text;
}

async function loadTarget(db, target, mongoSession = null) {
  const options = mongoSession ? { session: mongoSession } : {};
  const sessions = db.collection('sessions');
  const appointments = db.collection('appointments');
  const payments = db.collection('payments');
  const guides = db.collection('insuranceguides');

  const session = await sessions.findOne({ _id: oid(target.sessionId) }, options);
  if (!session) throw new Error(`${target.patient}: Session ${target.sessionId} não encontrada`);

  const appointment = await appointments.findOne({
    $or: [
      { _id: session.appointmentId },
      { session: session._id },
    ],
  }, options);
  if (!appointment) throw new Error(`${target.patient}: Appointment da Session ${target.sessionId} não encontrado`);

  const guide = await guides.findOne({ _id: oid(target.guideId) }, options);
  if (!guide) throw new Error(`${target.patient}: guia ${target.guide} não encontrada`);

  const relatedPayments = await payments.find({
    $or: [
      { session: session._id },
      { appointment: appointment._id },
    ],
    billingType: 'convenio',
  }, options).sort({ createdAt: 1 }).toArray();

  return { target, session, appointment, guide, relatedPayments };
}

function validateTarget(state, { phantom = false } = {}) {
  const { target, session, appointment, guide, relatedPayments } = state;
  const problems = [];

  if (dateKey(session.date) !== target.date) problems.push(`data ${dateKey(session.date)} ≠ ${target.date}`);
  if (session.time !== target.time) problems.push(`hora ${session.time} ≠ ${target.time}`);
  if (!sameId(session.insuranceGuide, target.guideId)) problems.push(`guia da Session é ${session.insuranceGuide}`);
  if (!sameId(guide._id, target.guideId) || String(guide.number) !== target.guide) problems.push(`guia esperada #${target.guide} não confere`);
  if (Number(session.sessionValue) !== target.amount) problems.push(`valor da Session R$ ${money(session.sessionValue)} ≠ R$ ${money(target.amount)}`);
  if (!sameId(appointment._id, target.appointmentId || session.appointmentId)) problems.push(`Appointment ${appointment._id} não confere`);
  if (appointment.billingType !== 'convenio' || appointment.paymentMethod !== 'convenio') problems.push('Appointment não está classificado como convênio');

  if (!phantom) {
    if (session.status !== 'completed') problems.push(`Session está ${session.status}, esperado completed`);
    if (appointment.operationalStatus !== 'completed') problems.push(`Appointment está ${appointment.operationalStatus}, esperado completed`);
  }

  const eligible = relatedPayments.filter(isEligible);
  if (eligible.length > 1) problems.push(`${eligible.length} Payments elegíveis já existem`);
  if (relatedPayments.some(hasBillingEvidence) && eligible.length === 0) problems.push('há evidência de lote, faturamento ou recebimento em Payment encerrado');

  const unexpected = relatedPayments.filter(payment => !isEligible(payment) && !TERMINAL_PAYMENT_STATUSES.has(payment.status));
  if (unexpected.length) problems.push(`Payment(s) em estado inesperado: ${unexpected.map(item => `${item._id}:${item.status}`).join(', ')}`);

  if (phantom && target.paymentId && !relatedPayments.some(payment => sameId(payment._id, target.paymentId))) {
    problems.push(`Payment fantasma esperado ${target.paymentId} não encontrado`);
  }

  if (problems.length) throw new Error(`${target.patient} ${target.date} ${target.time}: ${problems.join('; ')}`);
  return eligible;
}

function buildPayment(state, now) {
  const { target, session, appointment, guide, relatedPayments } = state;
  const template = [...relatedPayments].reverse().find(payment => TERMINAL_PAYMENT_STATUSES.has(payment.status));
  const patient = session.patient || appointment.patient || template?.patient;
  const doctor = session.doctor || appointment.doctor || template?.doctor;
  if (!patient) throw new Error(`${target.patient}: paciente ausente; criação bloqueada`);
  if (!doctor) throw new Error(`${target.patient}: profissional ausente; criação bloqueada`);

  const provider = appointment.insuranceProvider
    || template?.insurance?.provider
    || guide.insuranceProvider
    || guide.provider
    || null;
  const planId = appointment.insurancePlan || session.insurancePlan || template?.insurancePlan || guide.insurancePlan || null;
  const serviceDate = session.date;

  return {
    patient,
    patientId: String(patient),
    doctor,
    appointment: appointment._id,
    appointmentId: String(appointment._id),
    session: session._id,
    amount: target.amount,
    paymentDate: now,
    serviceDate,
    paymentMethod: 'convenio',
    status: 'pending',
    serviceType: template?.serviceType || appointment.serviceType || 'session',
    sessionType: template?.sessionType || session.sessionType || appointment.sessionType || appointment.specialty || null,
    kind: 'session_payment',
    paymentRole: 'standard',
    billingType: 'convenio',
    notes: REPAIR_REASON,
    clinicId: template?.clinicId || appointment.clinicId || session.clinicId || 'default',
    isFromPackage: false,
    insurance: {
      provider,
      authorizationCode: appointment.authorizationCode || String(guide.number || ''),
      guideNumber: String(guide.number || ''),
      month: dateKey(serviceDate).slice(0, 7),
      status: 'pending_billing',
      grossAmount: target.amount,
      netAmount: 0,
      receivedAmount: 0,
      issRate: Number(template?.insurance?.issRate || 0),
      issAmount: 0,
      billedAt: null,
      receivedAt: null,
      guideId: guide._id,
    },
    insuranceGuide: guide._id,
    insurancePlan: planId,
    source: SOURCE,
    createdAt: now,
    updatedAt: now,
  };
}

async function ensureReceivable(db, state, mongoSession) {
  const now = new Date();
  const eligible = state.relatedPayments.filter(isEligible);
  let paymentId = eligible[0]?._id || null;

  if (!paymentId) {
    const payment = buildPayment(state, now);
    const result = await db.collection('payments').insertOne(payment, { session: mongoSession });
    paymentId = result.insertedId;

    const terminalIds = state.relatedPayments
      .filter(item => TERMINAL_PAYMENT_STATUSES.has(item.status))
      .map(item => item._id);
    if (terminalIds.length) {
      await db.collection('payments').updateMany(
        { _id: { $in: terminalIds } },
        {
          $set: {
            'insurance.status': null,
            'insurance.voidedAt': now,
            'insurance.voidReason': REPAIR_REASON,
            updatedAt: now,
          },
        },
        { session: mongoSession },
      );
    }
  }

  await db.collection('sessions').updateOne(
    { _id: state.session._id, status: 'completed' },
    {
      $set: {
        paymentId,
        paymentMethod: 'convenio',
        paymentStatus: 'pending_receipt',
        isPaid: false,
        visualFlag: 'pending',
        updatedAt: now,
      },
    },
    { session: mongoSession },
  );

  await db.collection('appointments').updateOne(
    { _id: state.appointment._id, operationalStatus: 'completed' },
    {
      $set: {
        payment: paymentId,
        paymentMethod: 'convenio',
        billingType: 'convenio',
        paymentStatus: 'pending_receipt',
        isPaid: false,
        visualFlag: 'pending',
        updatedAt: now,
      },
    },
    { session: mongoSession },
  );

  return { paymentId, created: eligible.length === 0 };
}

async function cancelPhantom(db, state, mongoSession) {
  const now = new Date();
  const alreadyCanceled = state.session.status === 'canceled'
    && ['canceled', 'force_cancelled'].includes(state.appointment.operationalStatus);

  await db.collection('payments').updateMany(
    {
      $or: [
        { session: state.session._id },
        { appointment: state.appointment._id },
      ],
      billingType: 'convenio',
    },
    {
      $set: {
        status: 'canceled',
        canceledAt: now,
        canceledReason: PHANTOM_REASON,
        'insurance.status': null,
        'insurance.voidedAt': now,
        'insurance.voidReason': PHANTOM_REASON,
        updatedAt: now,
      },
    },
    { session: mongoSession },
  );

  await db.collection('sessions').updateOne(
    { _id: state.session._id },
    {
      $set: {
        status: 'canceled',
        canceledAt: state.session.canceledAt || now,
        paymentStatus: 'canceled',
        isPaid: false,
        visualFlag: 'blocked',
        guideConsumed: false,
        paymentId: null,
        notes: appendNote(state.session.notes, PHANTOM_REASON),
        updatedAt: now,
      },
    },
    { session: mongoSession },
  );

  const historyEntry = {
    action: 'force_cancelled_financial_repair',
    previousStatus: state.appointment.operationalStatus,
    newStatus: 'force_cancelled',
    timestamp: now,
    context: PHANTOM_REASON,
  };
  const appointmentUpdate = {
    $set: {
      operationalStatus: 'force_cancelled',
      clinicalStatus: 'canceled',
      paymentStatus: 'canceled',
      isPaid: false,
      visualFlag: 'blocked',
      canceledAt: state.appointment.canceledAt || now,
      cancelReason: PHANTOM_REASON,
      updatedAt: now,
    },
  };
  if (!alreadyCanceled) appointmentUpdate.$push = { history: historyEntry };
  await db.collection('appointments').updateOne(
    { _id: state.appointment._id },
    appointmentUpdate,
    { session: mongoSession },
  );
}

async function verifyFinal(db) {
  const states = [];
  for (const target of RECEIVABLE_TARGETS) states.push(await loadTarget(db, target));
  const phantom = await loadTarget(db, PHANTOM_TARGET);

  for (const state of states) {
    const eligible = state.relatedPayments.filter(isEligible);
    if (state.session.status !== 'completed' || state.appointment.operationalStatus !== 'completed' || eligible.length !== 1) {
      throw new Error(`Verificação final falhou para ${state.target.patient} ${state.target.date}: completed/completed/1 esperado`);
    }
    if (!sameId(state.session.paymentId, eligible[0]._id) || !sameId(state.appointment.payment, eligible[0]._id)) {
      throw new Error(`Verificação final falhou: vínculos do Payment de ${state.target.patient} ${state.target.date}`);
    }
  }

  if (phantom.session.status !== 'canceled'
      || phantom.appointment.operationalStatus !== 'force_cancelled'
      || phantom.relatedPayments.some(isEligible)) {
    throw new Error('Verificação final falhou para a sessão fantasma de Benjamim');
  }
}

async function main() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) throw new Error('MONGO_URI não configurado');

  await mongoose.connect(mongoUri, { maxPoolSize: 5, serverSelectionTimeoutMS: 30_000 });
  const db = mongoose.connection.db;
  const states = [];
  for (const target of RECEIVABLE_TARGETS) states.push(await loadTarget(db, target));
  const phantomState = await loadTarget(db, PHANTOM_TARGET);

  let alreadyActive = 0;
  for (const state of states) {
    const eligible = validateTarget(state);
    alreadyActive += eligible.length;
    console.log(`${eligible.length ? '✅' : '➕'} ${state.target.patient} · ${state.target.date} ${state.target.time} · guia #${state.target.guide} · R$ ${money(state.target.amount)} · ${eligible.length ? 'recebível já ativo' : 'criar recebível'}`);
  }
  validateTarget(phantomState, { phantom: true });
  const phantomAlreadyCanceled = phantomState.session.status === 'canceled'
    && phantomState.appointment.operationalStatus === 'force_cancelled';
  console.log(`${phantomAlreadyCanceled ? '✅' : '⛔'} ${PHANTOM_TARGET.patient} · ${PHANTOM_TARGET.date} ${PHANTOM_TARGET.time} · guia #${PHANTOM_TARGET.guide} · ${phantomAlreadyCanceled ? 'sessão fantasma já cancelada' : 'cancelar sessão fantasma'}`);

  console.log(`\nPré-checagem concluída: ${RECEIVABLE_TARGETS.length - alreadyActive} recebível(is) a criar, ${alreadyActive} já ativo(s), 1 sessão fantasma a cancelar.`);
  if (!APPLY) {
    console.log('DRY-RUN: nada foi gravado. Use --apply para executar.');
    return;
  }

  const mongoSession = await mongoose.startSession();
  const results = [];
  try {
    await mongoSession.withTransaction(async () => {
      for (const target of RECEIVABLE_TARGETS) {
        const fresh = await loadTarget(db, target, mongoSession);
        validateTarget(fresh);
        results.push({ target, ...(await ensureReceivable(db, fresh, mongoSession)) });
      }

      const freshPhantom = await loadTarget(db, PHANTOM_TARGET, mongoSession);
      validateTarget(freshPhantom, { phantom: true });
      await cancelPhantom(db, freshPhantom, mongoSession);
    });
  } finally {
    await mongoSession.endSession();
  }

  await verifyFinal(db);
  console.log(`\nAPLICADO: ${results.filter(item => item.created).length} Payments criados e vinculados; ${results.filter(item => !item.created).length} reutilizados; sessão fantasma de Benjamim cancelada.`);
  console.log('Verificação pós-transação concluída com sucesso.');
}

main()
  .catch(error => {
    console.error(`\nERRO: ${error.stack || error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
