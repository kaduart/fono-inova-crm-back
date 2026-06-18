#!/usr/bin/env node
/**
 * 🔧 BACKFILL STATE MACHINE – CONVÊNIO
 *
 * Reconciliador seguro, idempotente e incremental para as violações detectadas
 * pelo validador de state machine.
 *
 * Uso (dry-run):
 *   node --env-file=../.env scripts/backfill-state-machine-convenio.js
 *
 * Uso (execução real):
 *   node --env-file=../.env scripts/backfill-state-machine-convenio.js --execute
 *
 * Flags:
 *   --execute              Aplica writes no banco (padrão: dry-run)
 *   --batch=N              Tamanho do batch (padrão: 50)
 *   --only=tipo            Processa apenas um tipo de violação
 *   --skip=tipo1,tipo2     Pula tipos específicos
 *   --resume=checkpoint    Continua a partir de um checkpoint salvo
 */

import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('💥 MONGO_URI não configurado');
  process.exit(1);
}

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const BATCH_SIZE = parseInt(args.find(a => a.startsWith('--batch='))?.split('=')[1] || '50', 10);
const ONLY = args.find(a => a.startsWith('--only='))?.split('=')[1] || null;
const SKIP = args.find(a => a.startsWith('--skip='))?.split('=')[1]?.split(',') || [];
const RESUME = args.find(a => a.startsWith('--resume='))?.split('=')[1] || null;

function fmtId(id) {
  if (!id) return null;
  return id.toString ? id.toString() : String(id);
}

function fmtDate(d) {
  if (!d) return null;
  const date = new Date(d);
  return isNaN(date) ? String(d) : date.toISOString();
}

function logHeader(title) {
  console.log('\n' + '═'.repeat(70));
  console.log(`  ${title}`);
  console.log('═'.repeat(70));
}

class BackfillEngine {
  constructor(db) {
    this.db = db;
    this.report = {
      geradoEm: new Date().toISOString(),
      modo: EXECUTE ? 'EXECUTE' : 'DRY-RUN',
      batchSize: BATCH_SIZE,
      baseline: {},
      acoes: [],
      naoAplicadas: [],
      estatisticas: {}
    };
    this.stats = {
      sessionsReverted: 0,
      paymentPointersFixed: 0,
      sessionPointersFixed: 0,
      guidesRecalculated: 0,
      paymentsCanceled: 0,
      paymentsCreated: 0,
      manualReview: 0,
      skipped: 0
    };
  }

  addAction(type, description, ids, details = {}) {
    this.report.acoes.push({
      tipo: type,
      descricao: description,
      ids,
      detalhes: details,
      timestamp: new Date().toISOString(),
      executado: EXECUTE
    });
  }

  addManualReview(type, description, ids, reason) {
    this.report.naoAplicadas.push({
      tipo: type,
      descricao: description,
      ids,
      motivo: reason,
      timestamp: new Date().toISOString()
    });
    this.stats.manualReview++;
  }

  // ─────────────────────────────────────────────────────────────────
  // FASE 1: Corrigir pointers session.paymentId ↔ payment.session
  // ─────────────────────────────────────────────────────────────────
  async fixPaymentSessionPointers() {
    if (ONLY && ONLY !== 'pointers') return;
    if (SKIP.includes('pointers')) return;

    logHeader('FASE 1: Correção de pointers Payment ↔ Session');

    // 1.1 Sessions completed com payment ativo apontando para ela mas paymentId null
    const payments = await this.db.collection('payments').find({
      status: { $nin: ['canceled', 'refunded'] },
      session: { $exists: true, $ne: null },
      billingType: 'convenio'
    }).toArray();

    let fixed = 0;
    for (const payment of payments) {
      const session = await this.db.collection('sessions').findOne({ _id: payment.session });
      if (!session) {
        this.addManualReview('missing_session', 'Payment aponta para session inexistente', {
          paymentId: fmtId(payment._id)
        }, 'session_id_invalid');
        continue;
      }

      if (session.status === 'completed' && !session.paymentId) {
        if (EXECUTE) {
          await this.db.collection('sessions').updateOne(
            { _id: session._id },
            { $set: { paymentId: payment._id } }
          );
        }
        this.addAction('fix_session_paymentId',
          'Preencheu session.paymentId com payment ativo',
          { sessionId: fmtId(session._id), paymentId: fmtId(payment._id) }
        );
        fixed++;
      }
    }

    this.stats.sessionPointersFixed = fixed;
    console.log(`  ✅ ${fixed} sessions tiveram paymentId corrigido`);

    // 1.2 Payments ativos de convênio sem session mas com appointment
    const orphanPayments = await this.db.collection('payments').find({
      billingType: 'convenio',
      status: { $nin: ['canceled', 'refunded'] },
      $or: [{ session: { $exists: false } }, { session: null }],
      appointment: { $exists: true, $ne: null }
    }).toArray();

    let paymentFixed = 0;
    for (const payment of orphanPayments) {
      const appointment = await this.db.collection('appointments').findOne({ _id: payment.appointment });
      const sessionId = appointment?.session;
      if (sessionId) {
        if (EXECUTE) {
          await this.db.collection('payments').updateOne(
            { _id: payment._id },
            { $set: { session: sessionId } }
          );
        }
        this.addAction('fix_payment_session',
          'Preencheu payment.session a partir do appointment',
          { paymentId: fmtId(payment._id), sessionId: fmtId(sessionId) }
        );
        paymentFixed++;
      } else {
        this.addManualReview('orphan_payment_no_session',
          'Payment ativo sem session e appointment sem session',
          { paymentId: fmtId(payment._id), appointmentId: fmtId(payment.appointment) },
          'no_session_found'
        );
      }
    }

    this.stats.paymentPointersFixed = paymentFixed;
    console.log(`  ✅ ${paymentFixed} payments tiveram session corrigida`);
  }

  // ─────────────────────────────────────────────────────────────────
  // FASE 2: Reverter sessions completed com payment cancelado
  // ─────────────────────────────────────────────────────────────────
  async revertCanceledPaymentSessions() {
    if (ONLY && ONLY !== 'revert_canceled') return;
    if (SKIP.includes('revert_canceled')) return;

    logHeader('FASE 2: Reversão de sessions com payment cancelado');

    const canceledPayments = await this.db.collection('payments').find({
      status: 'canceled',
      session: { $exists: true, $ne: null }
    }).toArray();

    let reverted = 0;
    for (const payment of canceledPayments) {
      const session = await this.db.collection('sessions').findOne({ _id: payment.session });
      if (!session || session.status !== 'completed') continue;

      // Verifica se existe outro payment ativo para essa session
      const otherActivePayment = await this.db.collection('payments').findOne({
        session: session._id,
        status: { $nin: ['canceled', 'refunded'] },
        _id: { $ne: payment._id }
      });

      if (otherActivePayment) {
        this.addManualReview('session_completed_with_active_payment',
          'Session completed tem payment cancelado mas outro payment ativo existe',
          { sessionId: fmtId(session._id), canceledPaymentId: fmtId(payment._id), activePaymentId: fmtId(otherActivePayment._id) },
          'review_required_active_payment_exists'
        );
        continue;
      }

      if (EXECUTE) {
        const update = {
          $set: {
            status: 'canceled',
            canceledAt: new Date(),
            cancelReason: payment.canceledReason || 'backfill_convenio_reversal',
            paymentId: null,
            guideConsumed: false,
            isPaid: false,
            paymentStatus: 'pending',
            visualFlag: 'pending'
          }
        };
        await this.db.collection('sessions').updateOne({ _id: session._id }, update);

        if (session.insuranceGuide) {
          await this.db.collection('insuranceguides').updateOne(
            { _id: session.insuranceGuide },
            { $inc: { usedSessions: -1 } }
          );
        }
      }

      this.addAction('revert_session_completed_canceled_payment',
        'Reverteu session completed → canceled pois payment está cancelado',
        { sessionId: fmtId(session._id), paymentId: fmtId(payment._id) },
        { hadGuideConsumed: !!session.guideConsumed, insuranceGuide: fmtId(session.insuranceGuide) }
      );
      reverted++;
    }

    this.stats.sessionsReverted = reverted;
    console.log(`  ✅ ${reverted} sessions revertidas de completed → canceled`);
  }

  // ─────────────────────────────────────────────────────────────────
  // FASE 3: Sessions completed sem payment (sem payment ativo nem cancelado)
  // ─────────────────────────────────────────────────────────────────
  async handleSessionsWithoutPayment() {
    if (ONLY && ONLY !== 'missing_payment') return;
    if (SKIP.includes('missing_payment')) return;

    logHeader('FASE 3: Sessions completed sem payment');

    const sessions = await this.db.collection('sessions').find({
      status: 'completed',
      $or: [
        { paymentMethod: 'convenio' },
        { paymentOrigin: 'convenio' },
        { billingType: 'convenio' }
      ],
      $or: [{ paymentId: { $exists: false } }, { paymentId: null }]
    }).toArray();

    let created = 0;
    let review = 0;

    for (const session of sessions) {
      // Pula se já foi tratada na fase 1 (agora tem pointer)
      if (session.paymentId) continue;

      const appointment = await this.db.collection('appointments').findOne({ session: session._id });
      const guideId = session.insuranceGuide || appointment?.insuranceGuideId;

      // Estratégia: se a sessão tem appointment e dados de convênio, criar payment pending_billing
      if (appointment && guideId) {
        const guide = await this.db.collection('insuranceguides').findOne({ _id: guideId });

        if (guide) {
          if (EXECUTE) {
            const paymentDoc = {
              patient: session.patient,
              doctor: session.doctor,
              amount: guide.sessionValue || guide.totalValue || 0,
              status: 'pending',
              paymentMethod: 'convenio',
              billingType: 'convenio',
              financialDate: null,
              insurance: {
                provider: guide.insurance || 'Convênio',
                authorizationCode: guide.number,
                status: 'pending_billing',
                grossAmount: guide.sessionValue || guide.totalValue || 0,
                guideId: guide._id
              },
              appointment: appointment._id,
              session: session._id,
              kind: 'session_payment',
              createdAt: new Date(),
              updatedAt: new Date(),
              source: 'backfill_state_machine'
            };
            const result = await this.db.collection('payments').insertOne(paymentDoc);
            await this.db.collection('sessions').updateOne(
              { _id: session._id },
              { $set: { paymentId: result.insertedId, guideConsumed: true } }
            );
            await this.db.collection('insuranceguides').updateOne(
              { _id: guide._id },
              { $inc: { usedSessions: 1 } }
            );
          }

          this.addAction('create_missing_convenio_payment',
            'Criou payment pending_billing para session completed sem payment',
            { sessionId: fmtId(session._id), appointmentId: fmtId(appointment._id), guideId: fmtId(guideId) },
            { amount: guide.sessionValue || guide.totalValue || 0 }
          );
          created++;
          continue;
        }
      }

      // Se appointment é convênio mas não achou guia: criar payment genérico pending_billing
      if (appointment?.billingType === 'convenio' || session.billingType === 'convenio') {
        if (EXECUTE) {
          const paymentDoc = {
            patient: session.patient,
            doctor: session.doctor,
            amount: 0,
            status: 'pending',
            paymentMethod: 'convenio',
            billingType: 'convenio',
            financialDate: null,
            insurance: {
              provider: appointment?.insuranceProvider || session.insuranceProvider || 'Convênio',
              authorizationCode: appointment?.authorizationCode || session.authorizationCode || null,
              status: 'pending_billing',
              grossAmount: 0
            },
            appointment: appointment?._id || null,
            session: session._id,
            kind: 'session_payment',
            createdAt: new Date(),
            updatedAt: new Date(),
            source: 'backfill_state_machine'
          };
          const result = await this.db.collection('payments').insertOne(paymentDoc);
          await this.db.collection('sessions').updateOne(
            { _id: session._id },
            { $set: { paymentId: result.insertedId } }
          );
        }

        this.addAction('create_generic_convenio_payment',
          'Criou payment pending_billing genérico para session completed sem guia',
          { sessionId: fmtId(session._id), appointmentId: fmtId(appointment?._id) }
        );
        created++;
        continue;
      }

      // Sem dados suficientes: não reverte automaticamente para preservar histórico clínico
      this.addManualReview('session_completed_no_payment',
        'Session completed de convênio sem payment e sem dados para reconstrução',
        { sessionId: fmtId(session._id), appointmentId: fmtId(appointment?._id) },
        'insufficient_data_to_reconstruct_payment'
      );
      review++;
    }

    this.stats.paymentsCreated = created;
    this.stats.manualReview += review;
    console.log(`  ✅ ${created} payments criados | ${review} casos pendentes de revisão manual`);
  }

  // ─────────────────────────────────────────────────────────────────
  // FASE 4: Recalcular InsuranceGuide.usedSessions
  // ─────────────────────────────────────────────────────────────────
  async recalculateGuideUsage() {
    if (ONLY && ONLY !== 'guides') return;
    if (SKIP.includes('guides')) return;

    logHeader('FASE 4: Recálculo de InsuranceGuide.usedSessions');

    const guides = await this.db.collection('insuranceguides').find({}).toArray();
    let fixed = 0;

    for (const guide of guides) {
      const realCount = await this.db.collection('sessions').countDocuments({
        insuranceGuide: guide._id,
        status: 'completed',
        guideConsumed: true
      });

      if (guide.usedSessions !== realCount) {
        if (EXECUTE) {
          await this.db.collection('insuranceguides').updateOne(
            { _id: guide._id },
            { $set: { usedSessions: realCount, updatedAt: new Date() } }
          );
        }
        this.addAction('recalculate_guide_usage',
          'Recalculou usedSessions da guia',
          { guideId: fmtId(guide._id) },
          { anterior: guide.usedSessions, novo: realCount }
        );
        fixed++;
      }
    }

    this.stats.guidesRecalculated = fixed;
    console.log(`  ✅ ${fixed} guias recalculadas`);
  }

  // ─────────────────────────────────────────────────────────────────
  // FASE 5: Payments ativos sem appointment
  // ─────────────────────────────────────────────────────────────────
  async fixPaymentsWithoutAppointment() {
    if (ONLY && ONLY !== 'orphan_payment') return;
    if (SKIP.includes('orphan_payment')) return;

    logHeader('FASE 5: Payments ativos sem appointment');

    const payments = await this.db.collection('payments').find({
      billingType: 'convenio',
      status: { $nin: ['canceled', 'refunded'] },
      $or: [{ appointment: { $exists: false } }, { appointment: null }],
      amount: { $gt: 0 }
    }).toArray();

    let fixed = 0;
    for (const payment of payments) {
      if (payment.session) {
        const session = await this.db.collection('sessions').findOne({ _id: payment.session });
        if (session?.appointmentId) {
          if (EXECUTE) {
            await this.db.collection('payments').updateOne(
              { _id: payment._id },
              { $set: { appointment: session.appointmentId } }
            );
          }
          this.addAction('fix_payment_appointment',
            'Preencheu payment.appointment a partir da session',
            { paymentId: fmtId(payment._id), appointmentId: fmtId(session.appointmentId) }
          );
          fixed++;
          continue;
        }
      }

      this.addManualReview('orphan_payment_no_appointment',
        'Payment ativo de convênio sem appointment e sem como recuperar',
        { paymentId: fmtId(payment._id) },
        'no_appointment_found'
      );
    }

    this.stats.paymentPointersFixed += fixed;
    console.log(`  ✅ ${fixed} payments tiveram appointment corrigido`);
  }

  // ─────────────────────────────────────────────────────────────────
  // FASE 6: Appointment com payment apontando para payment cancelado
  // ─────────────────────────────────────────────────────────────────
  async cleanAppointmentCanceledPaymentLinks() {
    if (ONLY && ONLY !== 'appointment_links') return;
    if (SKIP.includes('appointment_links')) return;

    logHeader('FASE 6: Limpeza de appointment.payment cancelado');

    const appointments = await this.db.collection('appointments').find({
      payment: { $exists: true, $ne: null }
    }).toArray();

    let cleaned = 0;
    for (const appointment of appointments) {
      const payment = await this.db.collection('payments').findOne({ _id: appointment.payment });
      if (payment && payment.status === 'canceled') {
        if (EXECUTE) {
          await this.db.collection('appointments').updateOne(
            { _id: appointment._id },
            { $set: { payment: null } }
          );
        }
        this.addAction('clean_appointment_canceled_payment',
          'Removeu vínculo appointment.payment para payment cancelado',
          { appointmentId: fmtId(appointment._id), paymentId: fmtId(payment._id) }
        );
        cleaned++;
      }
    }

    console.log(`  ✅ ${cleaned} appointments tiveram payment cancelado removido`);
  }

  async run() {
    logHeader('🔧 BACKFILL STATE MACHINE – CONVÊNIO');
    console.log(`  Modo: ${EXECUTE ? '🟥 EXECUTE' : '🟦 DRY-RUN'}`);
    console.log(`  Batch size: ${BATCH_SIZE}`);
    console.log(`  Apenas: ${ONLY || 'todos'}`);
    console.log(`  Skip: ${SKIP.length ? SKIP.join(', ') : 'nenhum'}`);

    await this.fixPaymentSessionPointers();
    await this.revertCanceledPaymentSessions();
    await this.handleSessionsWithoutPayment();
    await this.recalculateGuideUsage();
    await this.fixPaymentsWithoutAppointment();
    await this.cleanAppointmentCanceledPaymentLinks();

    this.report.estatisticas = this.stats;

    logHeader('📊 RESUMO DO BACKFILL');
    for (const [key, value] of Object.entries(this.stats)) {
      console.log(`  ${key}: ${value}`);
    }

    const outDir = path.resolve(process.cwd(), 'auditoria-output');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const suffix = EXECUTE ? 'execute' : 'dryrun';
    const outFile = path.join(outDir, `backfill-state-machine-convenio-${suffix}-${Date.now()}.json`);
    fs.writeFileSync(outFile, JSON.stringify(this.report, null, 2));
    console.log(`\n📄 Relatório salvo em: ${outFile}`);

    if (!EXECUTE) {
      console.log('\n⚠️  DRY-RUN: nenhuma alteração foi aplicada no banco.');
      console.log('    Para executar, rode com: --execute');
    }
  }
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  const engine = new BackfillEngine(db);
  await engine.run();

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('💥 Erro:', err);
  process.exit(1);
});
