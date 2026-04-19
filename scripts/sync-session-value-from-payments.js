#!/usr/bin/env node
/**
 * ==============================================================================
 * SINCRONIZAÇÃO GLOBAL: sessionValue ← Payment.amount
 * ==============================================================================
 *
 * REGRA DE DOMÍNIO:
 *   - Payment = dinheiro real (source of truth financeira)
 *   - Session = execução clínica (NUNCA fonte financeira)
 *
 * Este script sincroniza TODAS as sessions que têm payment vinculado,
 * garantindo que sessionValue reflita o valor real do payment.
 *
 * Modo: DRY-RUN por padrão. Use --apply para executar.
 * ==============================================================================
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const DRY_RUN = !process.argv.includes('--apply');

async function connect() {
  const uri = process.env.MONGO_URI;
  await mongoose.connect(uri);
  console.log(`[SyncSessionValue] Conectado: ${uri.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')}`);
}

async function main() {
  await connect();

  const { default: Payment } = await import('../models/Payment.js');
  const { default: Session } = await import('../models/Session.js');

  console.log(`\n========================================`);
  console.log(` MODO: ${DRY_RUN ? '🔍 DRY-RUN (simulação)' : '🔥 APLICAR MUDANÇAS'}`);
  console.log(`========================================\n`);

  // Busca todos os payments que têm session vinculada
  const payments = await Payment.find({
    session: { $exists: true, $ne: null },
    amount: { $gt: 0 }
  }).select('_id session amount').lean();

  console.log(`Payments com session vinculada: ${payments.length}`);

  let updated = 0;
  let skipped = 0;
  let mismatches = 0;

  for (const p of payments) {
    const session = await Session.findById(p.session).select('_id sessionValue date patient').lean();
    if (!session) {
      console.log(`  [SKIP] Session não encontrada: ${p.session} (Payment ${p._id})`);
      skipped++;
      continue;
    }

    const currentValue = session.sessionValue || 0;
    const targetValue = p.amount;

    if (currentValue === targetValue) {
      skipped++;
      continue;
    }

    mismatches++;
    console.log(`  [SYNC] Session ${session._id} (date=${session.date}): ${currentValue} → ${targetValue}`);

    if (!DRY_RUN) {
      await Session.updateOne(
        { _id: session._id },
        { $set: { sessionValue: targetValue } }
      );
      updated++;
    }
  }

  // Também sincroniza sessions com sessionValue=0 que têm payment
  const zeroSessions = await Session.find({
    sessionValue: 0,
    $or: [
      { paymentId: { $exists: true, $ne: null } },
      { 'payments.0': { $exists: true } }
    ]
  }).select('_id sessionValue').lean();

  console.log(`\nSessions com valor 0 e payment vinculado: ${zeroSessions.length}`);

  for (const s of zeroSessions) {
    const payment = await Payment.findOne({ session: s._id }).select('amount').lean();
    if (payment && payment.amount > 0) {
      console.log(`  [SYNC-0] Session ${s._id}: 0 → ${payment.amount}`);
      mismatches++;
      if (!DRY_RUN) {
        await Session.updateOne({ _id: s._id }, { $set: { sessionValue: payment.amount } });
        updated++;
      }
    }
  }

  console.log(`\n── RELATÓRIO ──`);
  console.log(`  Total payments analisados: ${payments.length}`);
  console.log(`  Divergências encontradas:  ${mismatches}`);
  console.log(`  Sessions atualizadas:      ${updated}`);
  console.log(`  Sessions já consistentes:  ${skipped}`);
  console.log(`  Modo: ${DRY_RUN ? 'DRY-RUN (nada alterado)' : 'APLICADO'}`);

  if (DRY_RUN && mismatches > 0) {
    console.log(`\n  Para aplicar, execute com: --apply`);
  }

  await mongoose.disconnect();
  console.log('\n[SyncSessionValue] Desconectado. ✅');
}

main().catch(err => {
  console.error('[SyncSessionValue] Erro fatal:', err);
  process.exit(1);
});
