#!/usr/bin/env node

/**
 * Corrige o consumo da sessão real de 12/08/2026 18:20 do Ícaro.
 *
 * O complete canônico rejeitou a guia histórica #16173377 por ela estar
 * cancelada e usou o fallback #16173376. Este reparo transfere somente o
 * consumo dessa Session para a guia comprovada pelo protocolo físico.
 * Dry-run por padrão; --apply executa uma transação idempotente.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(scriptDir, '../../.env') });

const APPLY = process.argv.includes('--apply');
const APPOINTMENT_ID = new mongoose.Types.ObjectId('6aa443863f4b9436770b748d');
const SESSION_ID = new mongoose.Types.ObjectId('6aa443863f4b9436770b7491');
const PAYMENT_ID = new mongoose.Types.ObjectId('6aa443863f4b9436770b7497');
const CORRECT_GUIDE_ID = new mongoose.Types.ObjectId('6a455d86494b0ecabb70dac7'); // #16173377
const WRONG_GUIDE_ID = new mongoose.Types.ObjectId('6a7e12c32f206c445bc95c52');   // #16173376
const REASON = 'Correção auditada em 2026-09-11: consumo da sessão real de 12/08 18:20 transferido da guia fallback #16173376 para a guia comprovada #16173377.';

function sameId(left, right) {
  return String(left || '') === String(right || '');
}

async function inspect(db, mongoSession = null) {
  const options = mongoSession ? { session: mongoSession } : {};
  const [appointment, session, payment, correctGuide, wrongGuide] = await Promise.all([
    db.collection('appointments').findOne({ _id: APPOINTMENT_ID }, options),
    db.collection('sessions').findOne({ _id: SESSION_ID }, options),
    db.collection('payments').findOne({ _id: PAYMENT_ID }, options),
    db.collection('insuranceguides').findOne({ _id: CORRECT_GUIDE_ID }, options),
    db.collection('insuranceguides').findOne({ _id: WRONG_GUIDE_ID }, options),
  ]);
  if (![appointment, session, payment, correctGuide, wrongGuide].every(Boolean)) {
    throw new Error('Appointment, Session, Payment ou uma das guias não foi encontrada');
  }

  const correctEntries = (correctGuide.consumptionHistory || []).filter(entry => sameId(entry.sessionId, SESSION_ID));
  const wrongEntries = (wrongGuide.consumptionHistory || []).filter(entry => sameId(entry.sessionId, SESSION_ID));
  const alreadyFixed = sameId(appointment.insuranceGuide, CORRECT_GUIDE_ID)
    && sameId(session.insuranceGuide, CORRECT_GUIDE_ID)
    && sameId(payment.insuranceGuide, CORRECT_GUIDE_ID)
    && correctEntries.length === 1
    && wrongEntries.length === 0
    && correctGuide.usedSessions === 3
    && wrongGuide.usedSessions === 9;

  return { appointment, session, payment, correctGuide, wrongGuide, correctEntries, wrongEntries, alreadyFixed };
}

function validate(state) {
  if (state.alreadyFixed) return;
  const problems = [];
  if (state.appointment.operationalStatus !== 'completed') problems.push(`Appointment=${state.appointment.operationalStatus}`);
  if (state.session.status !== 'completed') problems.push(`Session=${state.session.status}`);
  if (!['pending', 'pending_billing'].includes(state.payment.status)) problems.push(`Payment=${state.payment.status}`);
  if (Number(state.payment.amount) !== 80) problems.push(`Payment.amount=${state.payment.amount}`);
  if (!sameId(state.appointment.insuranceGuide, WRONG_GUIDE_ID)) problems.push('Appointment não aponta para a guia fallback esperada');
  if (!sameId(state.session.insuranceGuide, WRONG_GUIDE_ID) || state.session.guideConsumed !== true) problems.push('Session não comprova consumo na guia fallback');
  if (!sameId(state.payment.insuranceGuide, CORRECT_GUIDE_ID)) problems.push('Payment não preservou a guia correta');
  if (state.wrongEntries.length !== 1) problems.push(`guia fallback tem ${state.wrongEntries.length} consumos da Session`);
  if (state.correctEntries.length !== 0) problems.push(`guia correta já tem ${state.correctEntries.length} consumos da Session`);
  if (state.wrongGuide.usedSessions !== 10) problems.push(`guia fallback usada=${state.wrongGuide.usedSessions}, esperado 10`);
  if (state.correctGuide.usedSessions !== 2) problems.push(`guia correta usada=${state.correctGuide.usedSessions}, esperado 2`);
  if (String(state.correctGuide.number) !== '16173377' || String(state.wrongGuide.number) !== '16173376') problems.push('números das guias divergiram');
  if (problems.length) throw new Error(`Pré-condição falhou: ${problems.join('; ')}`);
}

async function verify(db) {
  const state = await inspect(db);
  if (!state.alreadyFixed) throw new Error('Verificação final falhou: a transferência não ficou consistente');
  if (state.correctGuide.status !== 'cancelled') throw new Error(`status da guia correta foi alterado: ${state.correctGuide.status}`);
  if (state.wrongGuide.status !== 'expired') throw new Error(`status da guia fallback deveria ser expired, obtido ${state.wrongGuide.status}`);
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  const state = await inspect(db);
  validate(state);

  if (state.alreadyFixed) {
    console.log('✅ NO-OP: consumo de 12/08 já está na guia #16173377 e os vínculos estão corretos.');
    return;
  }

  console.log('Transferência validada: #16173376 10→9; #16173377 2→3; Appointment/Session/Payment → #16173377.');
  if (!APPLY) {
    console.log('DRY-RUN: nada foi gravado. Use --apply para executar.');
    return;
  }

  const mongoSession = await mongoose.startSession();
  try {
    await mongoSession.withTransaction(async () => {
      const fresh = await inspect(db, mongoSession);
      validate(fresh);
      if (fresh.alreadyFixed) return;

      const originalEntry = fresh.wrongEntries[0];
      const now = new Date();
      const removed = await db.collection('insuranceguides').updateOne(
        {
          _id: WRONG_GUIDE_ID,
          usedSessions: 10,
          'consumptionHistory.sessionId': SESSION_ID,
        },
        {
          $inc: { usedSessions: -1 },
          $pull: { consumptionHistory: { sessionId: SESSION_ID } },
          $set: { status: 'expired', updatedAt: now },
        },
        { session: mongoSession },
      );
      if (removed.modifiedCount !== 1) throw new Error('Não foi possível remover exatamente um consumo da guia fallback');

      const inserted = await db.collection('insuranceguides').updateOne(
        {
          _id: CORRECT_GUIDE_ID,
          usedSessions: 2,
          'consumptionHistory.sessionId': { $ne: SESSION_ID },
        },
        {
          $inc: { usedSessions: 1 },
          $push: {
            consumptionHistory: {
              ...originalEntry,
              _id: new mongoose.Types.ObjectId(),
              sessionNumber: 3,
              notes: REASON,
            },
          },
          $set: { updatedAt: now },
        },
        { session: mongoSession },
      );
      if (inserted.modifiedCount !== 1) throw new Error('Não foi possível registrar exatamente um consumo na guia correta');

      await db.collection('appointments').updateOne(
        { _id: APPOINTMENT_ID, operationalStatus: 'completed' },
        {
          $set: { insuranceGuide: CORRECT_GUIDE_ID, updatedAt: now },
          $push: {
            history: {
              action: 'correcao_guia_consumida',
              timestamp: now,
              context: 'reparo_dados',
              details: { from: WRONG_GUIDE_ID, to: CORRECT_GUIDE_ID, reason: REASON },
            },
          },
        },
        { session: mongoSession },
      );
      await db.collection('sessions').updateOne(
        { _id: SESSION_ID, status: 'completed' },
        {
          $set: {
            insuranceGuide: CORRECT_GUIDE_ID,
            guideConsumed: true,
            guideConsumedAt: originalEntry.consumedAt || now,
            paymentId: PAYMENT_ID,
            paymentStatus: 'pending_receipt',
            updatedAt: now,
          },
        },
        { session: mongoSession },
      );
      await db.collection('payments').updateOne(
        { _id: PAYMENT_ID, status: { $in: ['pending', 'pending_billing'] } },
        {
          $set: {
            insuranceGuide: CORRECT_GUIDE_ID,
            'insurance.authorizationCode': '16173377',
            'insurance.guideNumber': '16173377',
            'insurance.guideId': CORRECT_GUIDE_ID,
            updatedAt: now,
          },
        },
        { session: mongoSession },
      );
    });
  } finally {
    await mongoSession.endSession();
  }

  await verify(db);
  console.log('✅ APLICADO: consumo e três vínculos transferidos para a guia #16173377; guia #16173376 restaurada para 9/10 e expirada.');
}

main()
  .catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });

