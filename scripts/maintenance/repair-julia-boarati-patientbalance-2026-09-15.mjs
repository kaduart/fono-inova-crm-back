#!/usr/bin/env node
/**
 * Reparo do PatientBalance da paciente Julia Boarati (6a5a9269ce43485b2af4edbc).
 *
 * Contexto: 5 lançamentos legados sem `description` bloqueavam qualquer
 * criação de pacote pra essa paciente (Mongoose revalidando o array
 * `transactions` inteiro num `.save()`). O bug de código já foi corrigido
 * (ver back/docs/DOMAIN_INVARIANTS.md, ADR-019) — este script só repara o
 * DADO histórico que já estava quebrado antes da correção, separado dela.
 *
 * Duas fases, cada uma com evidência cruzada contra Payment real:
 *   Fase A — soft-delete de 4 duplicatas comprovadas (mesmo appointmentId+
 *            sessionId+amount+type de um débito já existente, criadas
 *            segundos/minutos depois do paidAt do Payment correspondente,
 *            sem description — assinatura de escrita sem validação).
 *   Fase B — quitação real de 3 débitos cujo Payment está confirmado `paid`
 *            (isPaid=true, paidAmount, + transação de credit vinculada por
 *            linkedDebitId — mesmo mecanismo canônico de
 *            reconcilePatientBalanceDebit()). totalDebited NUNCA é
 *            decrementado (histórico bruto).
 *
 * Fora de escopo, DE PROPÓSITO — não resolvidos aqui:
 *   #7 (órfão, sem appointmentId/sessionId, sem Payment atribuível)
 *   #8 (débito de hoje, R$200 original vs R$160 do Payment usado no pacote
 *       novo — diferença não confirmada como desconto)
 *
 * Uso:
 *   node scripts/maintenance/repair-julia-boarati-patientbalance-2026-09-15.mjs           (dry-run, não grava nada)
 *   node scripts/maintenance/repair-julia-boarati-patientbalance-2026-09-15.mjs --apply   (grava de verdade, em transação)
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const PATIENT_ID = '6a5a9269ce43485b2af4edbc';
const APPLY = process.argv.includes('--apply');

const roundCurrency = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;

// Cada item já validado manualmente contra Payment/Appointment/Session reais
// (ver conversa/dry-run anterior) — o script não decide nada, só executa o
// que já foi conferido.
const DUPLICATES = [
  { id: '6a8da9a4825afa3adc8875fd', duplicatesOf: '6a846dc0441b7f2f7cf01311', originalLabel: '18/08' },
  { id: '6a8da9b6825afa3adc887630', duplicatesOf: '6a8da29f3f3e96ae214a5d6b', originalLabel: '25/08' },
  { id: '6a9814123f3640f4b5d8dd23', duplicatesOf: '6a9737f9b82dac16d0bcf463', originalLabel: '01/09 (1ª duplicata)' },
  { id: '6a981e14b79919d272488fa9', duplicatesOf: '6a9737f9b82dac16d0bcf463', originalLabel: '01/09 (2ª duplicata)' },
];

const REAL_SETTLEMENTS = [
  { debitId: '6a846dc0441b7f2f7cf01311', paymentId: '6a846dbf441b7f2f7cf01303', label: '18/08' },
  { debitId: '6a8da29f3f3e96ae214a5d6b', paymentId: '6a8da29e3f3e96ae214a5d5d', label: '25/08' },
  { debitId: '6a9737f9b82dac16d0bcf463', paymentId: '6a9737f8b82dac16d0bcf455', label: '01/09' },
];

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`[REPAIR] Conectado. Modo: ${APPLY ? 'APLICANDO (grava em produção)' : 'DRY-RUN (nada será gravado)'}`);

  const db = mongoose.connection.db;
  const patientId = new mongoose.Types.ObjectId(PATIENT_ID);

  const before = await db.collection('patientbalances').findOne({ patient: patientId });
  if (!before) throw new Error('PatientBalance não encontrado — abortando.');

  console.log(`\n[REPAIR] Estado ANTES: currentBalance=${before.currentBalance} totalDebited=${before.totalDebited} totalCredited=${before.totalCredited}`);

  // Verifica que os IDs esperados ainda existem e com os valores esperados —
  // se algo mudou desde a última conferência, aborta em vez de adivinhar.
  const byId = new Map(before.transactions.map(t => [String(t._id), t]));
  for (const d of DUPLICATES) {
    const t = byId.get(d.id);
    if (!t) throw new Error(`Duplicata esperada não encontrada: ${d.id}`);
    if (t.description) throw new Error(`${d.id} já tem description — estado mudou desde a conferência, abortando.`);
    if (t.isDeleted) { console.log(`[REPAIR] ${d.id} já está isDeleted — pulando (idempotente).`); }
  }
  for (const s of REAL_SETTLEMENTS) {
    const t = byId.get(s.debitId);
    if (!t) throw new Error(`Débito esperado não encontrado: ${s.debitId}`);
    if (t.isPaid) { console.log(`[REPAIR] ${s.debitId} já está isPaid — pulando (idempotente).`); continue; }
    const payment = await db.collection('payments').findOne({ _id: new mongoose.Types.ObjectId(s.paymentId) });
    if (!payment) throw new Error(`Payment esperado não encontrado: ${s.paymentId}`);
    if (payment.status !== 'paid') throw new Error(`Payment ${s.paymentId} não está mais 'paid' (status=${payment.status}) — abortando, reconferir.`);
    if (payment.amount !== t.amount) throw new Error(`Payment ${s.paymentId} amount=${payment.amount} != débito ${t.amount} — abortando, reconferir.`);
  }

  console.log('\n[REPAIR] === FASE A: soft-delete das 4 duplicatas ===');
  let simBalance = before.currentBalance;
  const now = new Date();
  const dupUpdates = [];
  for (const d of DUPLICATES) {
    const t = byId.get(d.id);
    if (t.isDeleted) continue;
    const reason = `Duplicata de escrita sem validação (ver ADR-019) — mesmo appointmentId/sessionId/valor do débito ${d.duplicatesOf} (${d.originalLabel}), já quitado/registrado separadamente. Reparo 2026-09-15.`;
    console.log(`  - ${d.id} (R$${t.amount}, duplica ${d.duplicatesOf} / ${d.originalLabel}) -> isDeleted=true`);
    simBalance = roundCurrency(simBalance - t.amount);
    dupUpdates.push({ id: d.id, reason });
  }

  console.log('\n[REPAIR] === FASE B: quitação real (Payment confirmado paid) ===');
  let simCredited = before.totalCredited || 0;
  const settleUpdates = [];
  for (const s of REAL_SETTLEMENTS) {
    const t = byId.get(s.debitId);
    if (t.isPaid) continue;
    console.log(`  - ${s.debitId} (R$${t.amount}, ${s.label}) -> isPaid=true, credit R$${t.amount} linkedDebitId=${s.debitId} (Payment ${s.paymentId})`);
    simBalance = roundCurrency(simBalance - t.amount);
    simCredited = roundCurrency(simCredited + t.amount);
    settleUpdates.push({ id: s.debitId, amount: t.amount, paymentId: s.paymentId });
  }

  console.log(`\n[REPAIR] Estado DEPOIS (simulado): currentBalance=${simBalance} totalCredited=${simCredited} totalDebited=${before.totalDebited} (inalterado — histórico bruto)`);
  console.log('[REPAIR] Fora de escopo, intocados: #7 (órfão) e #8 (débito de hoje, R$200 vs Payment R$160)');

  if (!APPLY) {
    console.log('\n[REPAIR] DRY-RUN — nada foi gravado. Rode de novo com --apply pra aplicar de verdade.');
    await mongoose.disconnect();
    return;
  }

  console.log('\n[REPAIR] Aplicando em transação...');
  const session = await mongoose.startSession();
  await session.startTransaction();
  try {
    const coll = db.collection('patientbalances');

    for (const u of dupUpdates) {
      const res = await coll.updateOne(
        { patient: patientId, transactions: { $elemMatch: { _id: new mongoose.Types.ObjectId(u.id), isDeleted: { $ne: true } } } },
        { $set: { 'transactions.$.isDeleted': true, 'transactions.$.deletedAt': now, 'transactions.$.deleteReason': u.reason } },
        { session }
      );
      if (res.matchedCount === 0) throw new Error(`Fase A: updateOne não bateu pra ${u.id} — abortando.`);
    }

    for (const u of settleUpdates) {
      const flip = await coll.updateOne(
        { patient: patientId, transactions: { $elemMatch: { _id: new mongoose.Types.ObjectId(u.id), isPaid: { $ne: true } } } },
        { $set: { 'transactions.$.isPaid': true, 'transactions.$.paidAmount': u.amount } },
        { session }
      );
      if (flip.matchedCount === 0) throw new Error(`Fase B: flip não bateu pra ${u.id} — abortando.`);

      await coll.updateOne(
        { patient: patientId },
        {
          $push: {
            transactions: {
              _id: new mongoose.Types.ObjectId(),
              type: 'credit',
              amount: u.amount,
              description: `Quitação retroativa — Payment ${u.paymentId} confirmado paid. Reparo de dados 2026-09-15 (ver ADR-019, back/docs/DOMAIN_INVARIANTS.md).`,
              linkedDebitId: new mongoose.Types.ObjectId(u.id),
              registeredBy: null,
              transactionDate: now
            }
          },
          $inc: { currentBalance: -u.amount, totalCredited: u.amount },
          $set: { lastTransactionAt: now }
        },
        { session }
      );
    }

    await session.commitTransaction();
    console.log('[REPAIR] ✅ Transação commitada.');
  } catch (err) {
    await session.abortTransaction();
    console.error('[REPAIR] ❌ Abortado:', err.message);
    throw err;
  } finally {
    await session.endSession();
  }

  const after = await db.collection('patientbalances').findOne({ patient: patientId });
  console.log(`\n[REPAIR] Estado REAL depois: currentBalance=${after.currentBalance} totalDebited=${after.totalDebited} totalCredited=${after.totalCredited}`);
  if (after.currentBalance !== simBalance) {
    console.warn(`[REPAIR] ⚠️ currentBalance real (${after.currentBalance}) difere do simulado (${simBalance}) — investigar antes de considerar concluído.`);
  }

  await mongoose.disconnect();
}

run().catch(err => { console.error(err); process.exit(1); });
