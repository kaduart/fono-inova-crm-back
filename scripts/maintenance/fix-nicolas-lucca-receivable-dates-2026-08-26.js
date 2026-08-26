#!/usr/bin/env node
/**
 * 🔧 CORREÇÃO: data de recebimento das NFs 115 e 124 (Nicolas Lucca)
 *
 * Contexto (2026-08-26): ambas as NFs foram recebidas hoje via
 * POST /v2/insurance-batches/:id/receive com receivedDate=2026-08-26 (data
 * em que a secretária clicou "receber"), mas a Unimed Anápolis paga em D+30
 * corridos a partir da ÚLTIMA sessão do lote, não na data em que o sistema
 * registrou o clique. Usuário confirmou a regra e os valores calculados:
 *   - NF 115: última sessão do lote 25/02/2026 -> data correta 27/03/2026
 *   - NF 124: última sessão do lote 25/03/2026 -> data correta 24/04/2026
 *
 * Escopo: 28 Payments (billingType=convenio, patient=Nicolas Lucca,
 * financialDate=2026-08-26) + os 2 InsuranceBatch.receivedAt correspondentes.
 * Corrige APENAS as datas (financialDate, paidAt, insurance.receivedAt,
 * InsuranceBatch.receivedAt) — nunca amount, status, kind ou qualquer vínculo.
 *
 * Modo padrão: DRY-RUN (só relatório, zero escrita).
 * Uso:
 *   node scripts/maintenance/fix-nicolas-lucca-receivable-dates-2026-08-26.js
 *   node scripts/maintenance/fix-nicolas-lucca-receivable-dates-2026-08-26.js --apply --expected-count=28
 *
 * Garantias:
 *   - Recomputa o universo do zero a cada execução (Payments com
 *     financialDate ainda em 2026-08-26) — idempotente: depois de corrigido,
 *     nenhum registro bate mais o filtro, segunda execução encontra 0.
 *   - Transação atômica única cobrindo todos os Payments + os 2 batches.
 *   - Snapshot completo antes/depois em JSON.
 */

import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Payment from '../../models/Payment.js';
import InsuranceBatch from '../../models/InsuranceBatch.js';
import { buildPatientView } from '../../domains/clinical/services/patientProjectionService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

const ARGS = process.argv.slice(2);
const APPLY = ARGS.includes('--apply');
const expectedCountArg = ARGS.find(a => a.startsWith('--expected-count='));
const EXPECTED_COUNT = expectedCountArg ? parseInt(expectedCountArg.split('=')[1], 10) : null;

const SNAPSHOT_DIR = path.join(__dirname, 'snapshots');
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const NICOLAS_LUCCA_ID = '69655746dcdf49e2c282800b';
const TODAY_START = new Date('2026-08-26T00:00:00');
const TODAY_END = new Date('2026-08-27T00:00:00');

// Confirmado pelo usuário: NF -> data correta (última sessão do lote + 30 dias corridos).
const CORRECT_DATE_BY_INVOICE = {
  '115': new Date('2026-03-27T00:00:00'),
  '124': new Date('2026-04-24T00:00:00'),
};

class RepairAbortedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RepairAbortedError';
  }
}

async function findActiveBatchForPayment(paymentId, mongoSession) {
  const q = InsuranceBatch.find({ 'sessions.payment': paymentId }).select('invoiceNumber status receivedAt batchNumber');
  if (mongoSession) q.session(mongoSession);
  const all = await q.lean();
  if (all.length === 0) return null;
  return all.find(b => b.status !== 'superseded') || all[0];
}

async function buildManifest(mongoSession) {
  const q = Payment.find({
    patient: NICOLAS_LUCCA_ID,
    billingType: 'convenio',
    financialDate: { $gte: TODAY_START, $lt: TODAY_END },
  });
  if (mongoSession) q.session(mongoSession);
  const universe = await q.lean();

  const manifest = [];
  const nonActionable = [];
  const batchIdsSeen = new Map(); // batchId -> {invoiceNumber, correctDate}

  for (const p of universe) {
    const batch = await findActiveBatchForPayment(p._id, mongoSession);
    if (!batch) {
      nonActionable.push({ paymentId: p._id.toString(), motivo: 'sem InsuranceBatch ativo encontrado' });
      continue;
    }
    const correctDate = CORRECT_DATE_BY_INVOICE[batch.invoiceNumber];
    if (!correctDate) {
      nonActionable.push({ paymentId: p._id.toString(), motivo: `NF '${batch.invoiceNumber}' fora do escopo confirmado (só 115 e 124)` });
      continue;
    }

    manifest.push({
      paymentId: p._id.toString(),
      batchId: batch._id.toString(),
      invoiceNumber: batch.invoiceNumber,
      expectedFinancialDate: p.financialDate,
      correctDate,
    });
    if (!batchIdsSeen.has(batch._id.toString())) {
      batchIdsSeen.set(batch._id.toString(), { invoiceNumber: batch.invoiceNumber, correctDate, expectedReceivedAt: batch.receivedAt });
    }
  }

  return { manifest, nonActionable, universeSize: universe.length, batchIdsSeen };
}

async function snapshotFullDocs(manifest, batchIdsSeen) {
  const paymentIds = manifest.map(m => m.paymentId);
  const payments = await Payment.find({ _id: { $in: paymentIds } }).lean();
  const batches = await InsuranceBatch.find({ _id: { $in: [...batchIdsSeen.keys()] } }).lean();
  return { payments, batches };
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  console.log(`\n=== CORREÇÃO: data de recebimento NFs 115/124 (Nicolas Lucca) ===`);
  console.log(`Modo: ${APPLY ? '⚠️  APPLY (vai escrever, transação atômica)' : 'DRY-RUN (só leitura)'}`);
  if (EXPECTED_COUNT !== null) console.log(`Contagem esperada: ${EXPECTED_COUNT}`);

  if (!APPLY) {
    const { manifest, nonActionable, universeSize, batchIdsSeen } = await buildManifest(null);
    console.log(`\nUniverso (financialDate=2026-08-26, convenio, Nicolas Lucca): ${universeSize}`);
    console.log(`Acionáveis: ${manifest.length}`);
    console.log(`Não-acionáveis: ${nonActionable.length}`);
    if (nonActionable.length > 0) console.error('\n❌', JSON.stringify(nonActionable, null, 2));

    console.log(`\n=== NFs afetadas ===`);
    for (const [batchId, info] of batchIdsSeen.entries()) {
      const count = manifest.filter(m => m.batchId === batchId).length;
      console.log(`  NF ${info.invoiceNumber} (batch ${batchId}): ${count} payments, receivedAt ${info.expectedReceivedAt?.toISOString().slice(0,10)} -> ${info.correctDate.toISOString().slice(0,10)}`);
    }

    console.log(`\n=== AMOSTRA (5 de ${manifest.length}) ===`);
    manifest.slice(0, 5).forEach(m => console.log(JSON.stringify({ ...m, expectedFinancialDate: m.expectedFinancialDate?.toISOString(), correctDate: m.correctDate.toISOString() }, null, 2)));
    console.log(`\nℹ️  DRY-RUN — nada foi escrito. Rode com --apply --expected-count=${manifest.length} para aplicar.`);
    await mongoose.disconnect();
    return;
  }

  if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

  const mongoSession = await mongoose.startSession();
  let manifest, batchIdsSeen, repairedPayments, repairedBatches;
  try {
    await mongoSession.withTransaction(async () => {
      const built = await buildManifest(mongoSession);
      manifest = built.manifest;
      batchIdsSeen = built.batchIdsSeen;

      console.log(`\nUniverso recomputado (dentro da transação): ${built.universeSize}`);
      console.log(`Acionáveis: ${manifest.length}, não-acionáveis: ${built.nonActionable.length}`);

      if (built.nonActionable.length > 0) {
        throw new RepairAbortedError(`${built.nonActionable.length} registro(s) não-acionáveis — abortando:\n${JSON.stringify(built.nonActionable, null, 2)}`);
      }
      if (EXPECTED_COUNT !== null && manifest.length !== EXPECTED_COUNT) {
        throw new RepairAbortedError(`Esperado ${EXPECTED_COUNT}, encontrado ${manifest.length} — estado mudou desde o dry-run.`);
      }
      if (manifest.length === 0) {
        console.log('\n✅ Nada a fazer.');
        repairedPayments = [];
        repairedBatches = [];
        return;
      }

      const beforeSnapshot = await snapshotFullDocs(manifest, batchIdsSeen);
      const beforePath = path.join(SNAPSHOT_DIR, `${RUN_ID}-nicolas-dates-before.json`);
      fs.writeFileSync(beforePath, JSON.stringify({ manifest, snapshot: beforeSnapshot }, null, 2));
      console.log(`📸 Snapshot "antes" salvo em: ${beforePath}`);

      repairedPayments = [];
      for (const item of manifest) {
        const result = await Payment.updateOne(
          { _id: item.paymentId, financialDate: item.expectedFinancialDate },
          { $set: {
              financialDate: item.correctDate,
              paidAt: item.correctDate,
              'insurance.receivedAt': item.correctDate,
            }
          },
          { session: mongoSession }
        );
        if (result.modifiedCount !== 1) {
          throw new RepairAbortedError(`CAS não modificou exatamente 1 documento pra Payment ${item.paymentId} — abortando TUDO.`);
        }
        repairedPayments.push(item.paymentId);
      }
      console.log(`  ✅ ${repairedPayments.length} Payments corrigidos`);

      repairedBatches = [];
      for (const [batchId, info] of batchIdsSeen.entries()) {
        const result = await InsuranceBatch.updateOne(
          { _id: batchId, receivedAt: info.expectedReceivedAt },
          { $set: { receivedAt: info.correctDate } },
          { session: mongoSession }
        );
        if (result.modifiedCount !== 1) {
          throw new RepairAbortedError(`CAS não modificou InsuranceBatch ${batchId} — abortando TUDO.`);
        }
        repairedBatches.push(batchId);
        console.log(`  ✅ NF ${info.invoiceNumber} (batch ${batchId}): receivedAt -> ${info.correctDate.toISOString().slice(0,10)}`);
      }
    });
  } catch (err) {
    await mongoSession.endSession();
    console.error(`\n❌ TRANSAÇÃO ABORTADA — nada foi escrito: ${err.message}`);
    await mongoose.disconnect();
    process.exit(1);
  }
  await mongoSession.endSession();

  console.log(`\n=== TRANSAÇÃO COMMITADA ===`);
  console.log(`Payments corrigidos: ${repairedPayments.length}`);
  console.log(`Batches corrigidos: ${repairedBatches.length}`);

  if (repairedPayments.length > 0) {
    try {
      await buildPatientView(NICOLAS_LUCCA_ID, { correlationId: `fix_nicolas_dates_${RUN_ID}`, force: true });
      console.log(`  🔄 PatientsView reconstruída: ${NICOLAS_LUCCA_ID}`);
    } catch (err) {
      console.error(`  ❌ Falha ao reconstruir PatientsView: ${err.message}`);
    }

    const afterSnapshot = await snapshotFullDocs(manifest, batchIdsSeen);
    const afterPath = path.join(SNAPSHOT_DIR, `${RUN_ID}-nicolas-dates-after.json`);
    fs.writeFileSync(afterPath, JSON.stringify({ repairedPayments, repairedBatches, snapshot: afterSnapshot }, null, 2));
    console.log(`\n📸 Snapshot "depois" salvo em: ${afterPath}`);
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('❌ ERRO FATAL:', err);
  process.exit(1);
});
