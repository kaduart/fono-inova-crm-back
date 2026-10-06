#!/usr/bin/env node
/**
 * Reparo: Payment de convênio marcado como `paid` sem o convênio ter pago (Antonella Souza Eneas,
 * Unimed Anápolis, sessão de 29/06/2026, R$ 80,00).
 *
 * Contexto (investigação 2026-10-06): o Payment estava `status=paid`, `paymentMethod=other`,
 * `paidAt/financialDate = 29/06` e `insurance.status=pending_billing` SEM `receivedAt` — o convênio
 * nunca pagou. Isso travava o faturamento da NF (PAYMENT_STATUS_NOT_BILLABLE) e deixava R$ 80,00 no
 * caixa de junho sem ter entrado. É o único Payment do banco nesse estado contraditório.
 *
 * O que o script faz (em UMA transação):
 *   1. Payment: paid → pending via transitionPaymentStatus (caminho oficial; a saída de `paid`
 *      lança AUTOMATICAMENTE o débito de reversão no FinancialLedger — o crédito original é preservado,
 *      o ledger é imutável). paymentMethod volta a 'convenio'; paidAt/financialDate são zerados,
 *      que é o estado canônico do convênio recém-concluído (convenioHandler: financialDate null).
 *   2. Session: isPaid=false, paymentStatus='pending_receipt', paymentMethod/paymentOrigin='convenio'
 *      (mesmos valores que o convenioHandler grava ao concluir sessão de convênio).
 *   3. Appointment: NÃO é alterado por este script (só reportado) — ver a saída da simulação.
 *
 * Pré-checagens: se qualquer coisa não bater com o que foi investigado, ABORTA sem gravar.
 * Idempotente: se o Payment já não está `paid`, não faz nada.
 *
 * Uso:
 *   node scripts/maintenance/repair-convenio-manual-paid-antonella-2026-10-06.mjs           (simulação, não grava)
 *   node scripts/maintenance/repair-convenio-manual-paid-antonella-2026-10-06.mjs --apply   (grava, em transação)
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const PAYMENT_ID = '6a3c0b63c3dd2574dca64e91';
const SESSION_ID = '6a3c0b63c3dd2574dca64ea3';
const APPOINTMENT_ID = '6a3c0b62bbd6959696d27687';
const EXPECTED_AMOUNT = 80;
const APPLY = process.argv.includes('--apply');
const REASON = 'repair_convenio_manual_paid_2026-10-06';

const oid = (v) => new mongoose.Types.ObjectId(v);
const pickPayment = (p) => p && ({
  status: p.status, paymentMethod: p.paymentMethod, paidAt: p.paidAt ?? null, financialDate: p.financialDate ?? null,
  amount: p.amount, insuranceStatus: p.insurance?.status, receivedAt: p.insurance?.receivedAt ?? null,
});

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`[REPAIR] Modo: ${APPLY ? 'APLICANDO (grava em produção)' : 'SIMULAÇÃO (nada será gravado)'}`);
  const db = mongoose.connection.db;

  const payment = await db.collection('payments').findOne({ _id: oid(PAYMENT_ID) });
  const session = await db.collection('sessions').findOne({ _id: oid(SESSION_ID) });
  const appointment = await db.collection('appointments').findOne({ _id: oid(APPOINTMENT_ID) });
  if (!payment || !session) throw new Error('Payment ou Session não encontrados — abortando.');

  console.log('\n[ANTES] Payment    ', JSON.stringify(pickPayment(payment)));
  console.log('[ANTES] Session    ', JSON.stringify({ isPaid: session.isPaid, paymentStatus: session.paymentStatus, paymentMethod: session.paymentMethod, status: session.status }));
  console.log('[ANTES] Appointment', JSON.stringify(appointment && {
    paymentStatus: appointment.paymentStatus, operationalStatus: appointment.operationalStatus,
    billingType: appointment.billingType, payment: appointment.payment,
  }));

  // Idempotência
  if (payment.status !== 'paid') {
    console.log(`\n[REPAIR] Payment já não está 'paid' (status=${payment.status}) — nada a fazer.`);
    return;
  }

  // Pré-checagens: aborta se o estado diverge do investigado.
  const problems = [];
  if (payment.billingType !== 'convenio') problems.push(`billingType=${payment.billingType}`);
  if (payment.insurance?.status !== 'pending_billing') problems.push(`insurance.status=${payment.insurance?.status}`);
  if (payment.insurance?.receivedAt) problems.push('insurance.receivedAt preenchido — o convênio PAGOU, não reverter');
  if (Number(payment.amount) !== EXPECTED_AMOUNT) problems.push(`amount=${payment.amount}`);
  if (String(payment.session) !== SESSION_ID) problems.push('payment.session diferente do esperado');
  if (session.billingBatchId) problems.push('sessão já pertence a um lote');
  if (problems.length) throw new Error(`Estado diverge do investigado — abortando: ${problems.join('; ')}`);

  // Efeito no ledger (somente leitura)
  const { default: FinancialLedger } = await import('../../models/FinancialLedger.js');
  const credits = await FinancialLedger.find({ payment: payment._id, type: 'payment_received' }).lean();
  const reversals = credits.length
    ? await FinancialLedger.find({ reversalOfEntryId: { $in: credits.map((c) => c._id) } }).lean()
    : [];
  console.log(`\n[LEDGER] créditos payment_received: ${credits.length} (${credits.map((c) => c.amount).join(', ') || '—'}) | reversões já existentes: ${reversals.length}`);
  console.log(credits.length > reversals.length
    ? '[LEDGER] A saída de `paid` vai lançar 1 débito de reversão ligado ao crédito (o original é preservado).'
    : '[LEDGER] Nenhum crédito ativo a reverter.');

  console.log('\n[PLANO]');
  console.log('  Payment    : paid → pending | paymentMethod → convenio | paidAt/financialDate → null | insurance.status mantém pending_billing');
  console.log('  Session    : isPaid → false | paymentStatus → pending_receipt | paymentMethod → convenio (hoje: ' + session.paymentMethod + ') | paymentOrigin → convenio');
  console.log(`  Appointment: ${appointment?.paymentStatus === 'paid' ? "paymentStatus='paid' — NÃO alterado aqui (decidir à parte)" : 'sem mudança'}`);

  if (!APPLY) {
    console.log('\n[REPAIR] Simulação concluída. Nada foi gravado. Rode com --apply para aplicar.');
    return;
  }

  const { transitionPaymentStatus } = await import('../../services/paymentStatusService.js');
  const mongoSession = await mongoose.startSession();
  try {
    await mongoSession.withTransaction(async () => {
      await transitionPaymentStatus(PAYMENT_ID, 'pending', {
        session: mongoSession,
        paymentMethod: 'convenio',
        reason: REASON,
      });
      await db.collection('payments').updateOne(
        { _id: oid(PAYMENT_ID) },
        { $set: { financialDate: null, paidAt: null, updatedAt: new Date() } },
        { session: mongoSession }
      );
      await db.collection('sessions').updateOne(
        { _id: oid(SESSION_ID) },
        { $set: { isPaid: false, paymentStatus: 'pending_receipt', paymentOrigin: 'convenio', paymentMethod: 'convenio', updatedAt: new Date() } },
        { session: mongoSession }
      );
    });
  } finally {
    await mongoSession.endSession();
  }

  const after = await db.collection('payments').findOne({ _id: oid(PAYMENT_ID) });
  const sessionAfter = await db.collection('sessions').findOne({ _id: oid(SESSION_ID) });
  console.log('\n[DEPOIS] Payment', JSON.stringify(pickPayment(after)));
  console.log('[DEPOIS] Session', JSON.stringify({ isPaid: sessionAfter.isPaid, paymentStatus: sessionAfter.paymentStatus }));
  console.log('[REPAIR] Aplicado.');
}

run()
  .catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(async () => { await mongoose.disconnect().catch(() => {}); });
