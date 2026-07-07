// services/stateMachineConvenioReconciliation.service.js
// 🔄 Reconciliação de state machine para convênio — core compartilhado
//
// 📜 CHANGELOG (drift measurement)
// 2026-07-07 — sessionCompletedNoPaymentId + sessionCompletedWithActivePaymentButNoPaymentId
//   Renomeado/unificado em `sessionCompletedWithoutResolvablePayment`.
//   Causa: `sessionCompletedNoPaymentId` tinha DUAS chaves `$or` no mesmo objeto de
//   query — a segunda sobrescrevia a primeira (colisão de chave em JS), então o
//   filtro de billingType nunca era aplicado. A métrica contava TODAS as sessions
//   completed do sistema (particular/liminar incluídos), não só convênio — inflava
//   2176 no lugar de ~126 inconsistências reais. `sessionCompletedWithActivePaymentButNoPaymentId`
//   fazia a mesma checagem sem filtro de billingType nenhum — mesmo problema.
//   Ambas foram substituídas por uma única métrica correta, escopada a convênio,
//   que resolve o pagamento por `Payment.session` quando `Session.paymentId` (legado)
//   está ausente. Ver nota de coexistência de modelos abaixo.
//
// 🔀 Coexistência Session.paymentId × Payment.session
//   `Session.paymentId` é um ponteiro legado, escrito hoje só pelo fluxo antigo de
//   convênio baseado em Package (`controllers/convenioPackageController.js`, rota
//   `/api/convenio-packages`, ainda ativa). O fluxo novo baseado em InsuranceGuide
//   (`services/completeSession/handlers/convenioHandler.js` → `completeSessionV2`)
//   NUNCA escreve `Session.paymentId` — usa `Payment.session` como ponteiro canônico
//   (SSOT financeiro, ver back/docs/FINANCIAL_SOURCE_OF_TRUTH.md). Os dois fluxos
//   coexistem em produção, então qualquer verificação de "session sem payment" deve
//   checar `paymentId` E fazer fallback via `Payment.session` antes de considerar
//   drift — nunca assumir que um dos dois é universal.

import fs from 'fs';
import path from 'path';

function fmtId(id) {
  if (!id) return null;
  return id.toString ? id.toString() : String(id);
}

export class StateMachineConvenioReconciler {
  constructor(db, { execute = false, onlyLog = false } = {}) {
    this.db = db;
    this.execute = execute;
    this.onlyLog = onlyLog;
    this.report = {
      geradoEm: new Date().toISOString(),
      modo: execute ? 'AUTO' : 'DRY-RUN',
      correcoes: [],
      estatisticas: {
        sessionsReverted: 0,
        paymentPointersFixed: 0,
        sessionPointersFixed: 0,
        guidesRecalculated: 0,
        appointmentLinksCleaned: 0,
        manualReview: 0
      }
    };
  }

  addCorrection(type, description, ids, details = {}) {
    this.report.correcoes.push({
      tipo: type,
      descricao: description,
      ids,
      detalhes: details,
      timestamp: new Date().toISOString()
    });
  }

  addAlert(type, description, ids, reason) {
    this.report.correcoes.push({
      tipo: `ALERT:${type}`,
      descricao: description,
      ids,
      motivo: reason,
      timestamp: new Date().toISOString(),
      alerta: true
    });
    this.report.estatisticas.manualReview++;
  }

  async runSafeCorrections() {
    await this.fixSessionPaymentIds();
    await this.fixPaymentSessions();
    await this.fixPaymentAppointments();
    await this.revertCanceledPaymentSessions();
    await this.recalculateGuides();
    await this.cleanAppointmentCanceledPaymentLinks();
    return this.report;
  }

  async fixSessionPaymentIds() {
    const payments = await this.db.collection('payments').find({
      status: { $nin: ['canceled', 'refunded'] },
      session: { $exists: true, $ne: null },
      billingType: 'convenio'
    }).toArray();

    let fixed = 0;
    for (const payment of payments) {
      const session = await this.db.collection('sessions').findOne({ _id: payment.session });
      if (!session) continue;
      if (session.status === 'completed' && !session.paymentId) {
        if (this.execute) {
          const update = { $set: { paymentId: payment._id } };
          if (payment.insurance?.guideId && !session.insuranceGuide) {
            update.$set.insuranceGuide = payment.insurance.guideId;
            update.$set.guideConsumed = true;
          }
          await this.db.collection('sessions').updateOne(
            { _id: session._id },
            update
          );
        }
        this.addCorrection('fix_session_paymentId',
          'Preencheu session.paymentId com payment ativo',
          { sessionId: fmtId(session._id), paymentId: fmtId(payment._id) },
          { guideVinculado: !!payment.insurance?.guideId }
        );
        fixed++;
      }
    }
    this.report.estatisticas.sessionPointersFixed = fixed;
    return fixed;
  }

  async fixPaymentSessions() {
    const payments = await this.db.collection('payments').find({
      billingType: 'convenio',
      status: { $nin: ['canceled', 'refunded'] },
      $or: [{ session: { $exists: false } }, { session: null }],
      appointment: { $exists: true, $ne: null }
    }).toArray();

    let fixed = 0;
    for (const payment of payments) {
      const appointment = await this.db.collection('appointments').findOne({ _id: payment.appointment });
      const sessionId = appointment?.session;
      if (sessionId) {
        if (this.execute) {
          await this.db.collection('payments').updateOne(
            { _id: payment._id },
            { $set: { session: sessionId } }
          );
        }
        this.addCorrection('fix_payment_session',
          'Preencheu payment.session a partir do appointment',
          { paymentId: fmtId(payment._id), sessionId: fmtId(sessionId) }
        );
        fixed++;
      }
    }
    this.report.estatisticas.paymentPointersFixed = fixed;
    return fixed;
  }

  async fixPaymentAppointments() {
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
          if (this.execute) {
            await this.db.collection('payments').updateOne(
              { _id: payment._id },
              { $set: { appointment: session.appointmentId } }
            );
          }
          this.addCorrection('fix_payment_appointment',
            'Preencheu payment.appointment a partir da session',
            { paymentId: fmtId(payment._id), appointmentId: fmtId(session.appointmentId) }
          );
          fixed++;
        }
      }
    }
    this.report.estatisticas.paymentPointersFixed += fixed;
    return fixed;
  }

  async revertCanceledPaymentSessions() {
    const canceledPayments = await this.db.collection('payments').find({
      status: 'canceled',
      session: { $exists: true, $ne: null }
    }).toArray();

    let reverted = 0;
    for (const payment of canceledPayments) {
      const session = await this.db.collection('sessions').findOne({ _id: payment.session });
      if (!session || session.status !== 'completed') continue;

      const otherActive = await this.db.collection('payments').findOne({
        session: session._id,
        status: { $nin: ['canceled', 'refunded'] },
        _id: { $ne: payment._id }
      });

      if (otherActive) {
        this.addAlert('session_completed_with_active_payment',
          'Session completed tem payment cancelado mas outro payment ativo existe',
          { sessionId: fmtId(session._id), paymentId: fmtId(payment._id) },
          'review_required_active_payment_exists'
        );
        continue;
      }

      if (this.execute) {
        await this.db.collection('sessions').updateOne(
          { _id: session._id },
          {
            $set: {
              status: 'canceled',
              canceledAt: new Date(),
              cancelReason: payment.canceledReason || 'daily_reconciliation_reversal',
              paymentId: null,
              guideConsumed: false,
              isPaid: false,
              paymentStatus: 'pending',
              visualFlag: 'pending'
            }
          }
        );
        if (session.insuranceGuide) {
          await this.db.collection('insuranceguides').updateOne(
            { _id: session.insuranceGuide },
            { $inc: { usedSessions: -1 } }
          );
        }
      }

      this.addCorrection('revert_session_canceled_payment',
        'Reverteu session completed → canceled pois payment está cancelado',
        { sessionId: fmtId(session._id), paymentId: fmtId(payment._id) }
      );
      reverted++;
    }
    this.report.estatisticas.sessionsReverted = reverted;
    return reverted;
  }

  async recalculateGuides() {
    const guides = await this.db.collection('insuranceguides').find({}).toArray();
    let fixed = 0;
    for (const guide of guides) {
      const realCount = await this.db.collection('sessions').countDocuments({
        insuranceGuide: guide._id,
        status: 'completed',
        guideConsumed: true
      });
      if (guide.usedSessions !== realCount) {
        if (this.execute) {
          await this.db.collection('insuranceguides').updateOne(
            { _id: guide._id },
            { $set: { usedSessions: realCount, updatedAt: new Date() } }
          );
        }
        this.addCorrection('recalculate_guide_usage',
          'Recalculou usedSessions da guia',
          { guideId: fmtId(guide._id) },
          { anterior: guide.usedSessions, novo: realCount }
        );
        fixed++;
      }
    }
    this.report.estatisticas.guidesRecalculated = fixed;
    return fixed;
  }

  async cleanAppointmentCanceledPaymentLinks() {
    const appointments = await this.db.collection('appointments').find({
      payment: { $exists: true, $ne: null }
    }).toArray();

    let cleaned = 0;
    for (const appointment of appointments) {
      const payment = await this.db.collection('payments').findOne({ _id: appointment.payment });
      if (payment && payment.status === 'canceled') {
        if (this.execute) {
          await this.db.collection('appointments').updateOne(
            { _id: appointment._id },
            { $set: { payment: null } }
          );
        }
        this.addCorrection('clean_appointment_canceled_payment',
          'Removeu vínculo appointment.payment para payment cancelado',
          { appointmentId: fmtId(appointment._id), paymentId: fmtId(payment._id) }
        );
        cleaned++;
      }
    }
    this.report.estatisticas.appointmentLinksCleaned = cleaned;
    return cleaned;
  }
}

export async function measureStateMachineDrift(db) {
  const drift = {
    sessionCompletedWithoutResolvablePayment: 0,
    canceledPaymentWithCompletedSession: 0,
    guideUsedSessionsInconsistent: 0,
    activePaymentNoSession: 0,
    activePaymentNoAppointment: 0
  };

  // Sessions de convênio completed que não resolvem pra nenhum Payment ativo,
  // nem pelo ponteiro legado (Session.paymentId) nem pelo canônico (Payment.session).
  // Substitui as antigas `sessionCompletedNoPaymentId` (bug de $or duplicado, ver
  // changelog no topo do arquivo) e `sessionCompletedWithActivePaymentButNoPaymentId`
  // (mesma checagem sem escopo de billingType).
  const convenioCompletedSessions = await db.collection('sessions').find({
    status: 'completed',
    $or: [
      { paymentMethod: 'convenio' },
      { paymentOrigin: 'convenio' },
      { billingType: 'convenio' }
    ]
  }).toArray();

  for (const session of convenioCompletedSessions) {
    if (session.paymentId) continue; // ponteiro legado presente — ok
    const activePayment = await db.collection('payments').findOne({
      session: session._id,
      status: { $nin: ['canceled', 'refunded'] }
    });
    if (!activePayment) drift.sessionCompletedWithoutResolvablePayment++; // drift real: nenhum Payment ativo aponta pra essa session
  }

  const canceledPayments = await db.collection('payments').find({
    status: 'canceled',
    session: { $exists: true, $ne: null }
  }).toArray();
  for (const payment of canceledPayments) {
    const session = await db.collection('sessions').findOne({ _id: payment.session });
    if (session?.status === 'completed') drift.canceledPaymentWithCompletedSession++;
  }

  const guides = await db.collection('insuranceguides').find({}).toArray();
  for (const guide of guides) {
    const realCount = await db.collection('sessions').countDocuments({
      insuranceGuide: guide._id,
      status: 'completed',
      guideConsumed: true
    });
    if (guide.usedSessions !== realCount) drift.guideUsedSessionsInconsistent++;
  }

  drift.activePaymentNoSession = await db.collection('payments').countDocuments({
    billingType: 'convenio',
    status: { $nin: ['canceled', 'refunded'] },
    $or: [{ session: { $exists: false } }, { session: null }],
    amount: { $gt: 0 }
  });

  drift.activePaymentNoAppointment = await db.collection('payments').countDocuments({
    billingType: 'convenio',
    status: { $nin: ['canceled', 'refunded'] },
    $or: [{ appointment: { $exists: false } }, { appointment: null }],
    amount: { $gt: 0 }
  });

  // 🩹 REMOVIDO: sessionCompletedWithActivePaymentButNoPaymentId fazia exatamente a
  // mesma verificação (session completed sem paymentId, mas com Payment ativo
  // vinculado), só que sem filtrar por billingType — contava particular/liminar
  // onde paymentId nunca é aplicável. Mesma checagem agora coberta acima.

  drift.total = Object.values(drift).reduce((a, b) => a + b, 0);
  return drift;
}

export async function loadBaseline() {
  const baselineFile = path.resolve(process.cwd(), 'auditoria-output', 'baseline-state-machine-convenio.json');
  if (!fs.existsSync(baselineFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  } catch {
    return null;
  }
}

export async function saveBaseline(drift) {
  const baselineFile = path.resolve(process.cwd(), 'auditoria-output', 'baseline-state-machine-convenio.json');
  const baseline = {
    criadoEm: new Date().toISOString(),
    drift,
    fonte: 'stateMachineConvenioReconciliation.service'
  };
  fs.writeFileSync(baselineFile, JSON.stringify(baseline, null, 2));
  return baselineFile;
}
