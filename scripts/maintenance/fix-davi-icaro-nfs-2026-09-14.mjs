#!/usr/bin/env node
/**
 * Reconciliação de 3 NFs legadas confirmadas pelo usuário (papel/planilha, 2026-09-14):
 *
 *   NF 268 → guia 16173377 (Ícaro Lima de Souza Rezende, unimed-anapolis, cancelada)
 *            3 sessões pendingBilling (17/07, 24/07, 12/08/2026), R$80 cada = R$240
 *            Pago 26/08/2026
 *
 *   NF 223 → guia 2328 (Davi Felipe Araújo, unimed-campinas, active)
 *            3 sessões pendingBilling (06/07, 13/07, 27/07/2026), R$140 cada = R$420
 *            Pago 27/08/2026
 *
 *   NF 199 → guias 3050 (fonoaudiologia) + 3051 (fisioterapia) + 3052 (psicologia),
 *            todas Davi Felipe Araújo / unimed-campinas, todas com sessões em
 *            junho/2026 — uma única NF cobrindo as 3 guias do mesmo paciente na
 *            mesma competência (padrão documentado em reconcileLegacyInsuranceBatch).
 *            3050: 4 sessões R$140 = R$560 (cancelada)
 *            3051: 2 sessões R$140 = R$280 (cancelada)
 *            3052: 4 sessões R$140 = R$560 (expirada)
 *            Total: 10 sessões, R$1.400
 *            Pago 27/07/2026
 *
 * Guia 16173376 (Ícaro) e GUIA-NICOLAS-20260601-001 (Nicolas Lucca) ficaram de
 * fora de propósito: a primeira já está 100% billed sob outro lote, sem
 * pendingBilling; a segunda não veio na planilha do usuário — segue pendente.
 *
 * Sem data de emissão separada da data de pagamento na planilha — usa a mesma
 * data (a "Pago") pra invoiceDate e receivedDate, mesmo critério já usado e
 * validado na reconciliação da NF 200 (Daiane, 2026-09-11).
 *
 * dryRun sempre roda primeiro e imprime a prévia das 3 NFs antes de decidir
 * se aplica. Idempotente: sessão já em lote é pulada na criação e vai direto
 * pro recebimento.
 *
 * USO:
 *   node scripts/maintenance/fix-davi-icaro-nfs-2026-09-14.mjs            (dry-run)
 *   node scripts/maintenance/fix-davi-icaro-nfs-2026-09-14.mjs --apply
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../../.env') });
dotenv.config();

import '../../models/index.js';
import Session from '../../models/Session.js';
import { reconcileLegacyInsuranceBatch } from '../../services/insuranceGuide/reconcileLegacyInsuranceBatch.js';
import { receiveInsuranceBatch } from '../../services/insuranceBatch/InsuranceBatchReceiptService.js';

const APPLY = process.argv.includes('--apply');
const USER_ID = '6a2806fbd330bd5bec8e8d37'; // Ricardo Maia Santos (admin)

const NFS = [
  {
    label: 'NF 268 — Ícaro (guia 16173377, cancelada)',
    patientId: '6a061e1300ff2e03fb40480f',
    insuranceProvider: 'unimed-anapolis',
    invoiceNumber: '268',
    date: '2026-08-26',
    competenceMonth: '2026-08',
    documentedGross: 240,
    sessionIds: [
      '6a4576de02c3c83ca19de717',
      '6a4576de02c3c83ca19de718',
      '6aa443863f4b9436770b7491',
    ],
  },
  {
    label: 'NF 223 — Davi Felipe (guia 2328, active)',
    patientId: '692da1e37a66901c8975db66',
    insuranceProvider: 'unimed-campinas',
    invoiceNumber: '223',
    date: '2026-08-27',
    competenceMonth: '2026-08',
    documentedGross: 420,
    sessionIds: [
      '6a47a7b8251241ace3de8e00',
      '6a47a7b8251241ace3de8e01',
      '6a47a7b8251241ace3de8e03',
    ],
  },
  {
    label: 'NF 199 — Davi Felipe (guias 3050+3051+3052)',
    patientId: '692da1e37a66901c8975db66',
    insuranceProvider: 'unimed-campinas',
    invoiceNumber: '199',
    date: '2026-07-27',
    competenceMonth: '2026-06',
    documentedGross: 1400,
    sessionIds: [
      // guia 3050 (fonoaudiologia)
      '6a1dc25d4bafb710ab160f45', '6a1dc25d4bafb710ab160f43',
      '6a1dc25d4bafb710ab160f42', '6a1dc25d4bafb710ab160f40',
      // guia 3051 (fisioterapia)
      '6a1dc29f4bafb710ab161012', '6a1dc29f4bafb710ab161010',
      // guia 3052 (psicologia)
      '6a1dc2eb4bafb710ab1610b0', '6a1dc2eb4bafb710ab1610af',
      '6a1dc2eb4bafb710ab1610ae', '6a1dc2eb4bafb710ab1610ad',
    ],
  },
];

const MOTIVO_SUFFIX = 'Confirmado pelo usuário (Ricardo, 2026-09-14) a partir de planilha/NF física — guia cancelada/expirada travava faturamento pela tela normal.';

async function processOne(nf) {
  console.log(`\n${'─'.repeat(70)}\n${nf.label}\n${'─'.repeat(70)}`);

  const opts = {
    patientId: nf.patientId,
    insuranceProvider: nf.insuranceProvider,
    sessionIds: nf.sessionIds,
    invoiceNumber: nf.invoiceNumber,
    invoiceDate: nf.date,
    competenceMonth: nf.competenceMonth,
    documentedGross: nf.documentedGross,
    documentedNet: nf.documentedGross,
    documentReference: `NF ${nf.invoiceNumber} · planilha/confirmação verbal do usuário, 2026-09-14`,
    notes: `Reconciliação NF ${nf.invoiceNumber}: ${MOTIVO_SUFFIX}`,
  };

  const preview = await reconcileLegacyInsuranceBatch({ ...opts, dryRun: true });
  console.log(`  ${preview.sessionCount}/${nf.sessionIds.length} sessões resolvidas · bruto esperado R$${preview.expectedGross} · conferência: ${preview.reconciliation.status}`);
  if (preview.conflicts.length) {
    console.log('  conflitos:');
    preview.conflicts.forEach(c => console.log(`    - ${c.sessionId.slice(-6)}: ${c.code} (${c.detail})`));
  }
  if (preview.warnings.length) {
    preview.warnings.forEach(w => console.log(`    ⚠️  ${w.sessionId.slice(-6)}: ${w.code} (${w.detail})`));
  }

  if (!APPLY) return { nf, preview, applied: false };

  const alreadyBatched = await Session.find({ _id: { $in: nf.sessionIds }, billingBatchId: { $ne: null } })
    .select('_id billingBatchId').lean();

  if (!preview.canWrite && alreadyBatched.length !== nf.sessionIds.length) {
    console.error(`  🚫 ABORTADO (${nf.invoiceNumber}): conflitos e sessões ainda não totalmente em lote.`);
    return { nf, preview, applied: false, aborted: true };
  }

  let batchId;
  if (alreadyBatched.length === nf.sessionIds.length) {
    batchId = alreadyBatched[0].billingBatchId.toString();
    console.log(`  ⏭️  sessões já em lote (${batchId}) — indo direto pro recebimento.`);
  } else {
    const result = await reconcileLegacyInsuranceBatch({ ...opts, dryRun: false });
    batchId = result.batchId;
    console.log(`  ✅ lote criado: ${result.batchNumber} (${result.batchId})`);
    console.log(`  ${result.promotedPayments} payment(s) promovidos a 'billed', ${result.preservedPayments} preservados`);
  }

  const receiveResult = await receiveInsuranceBatch(batchId, { receivedDate: nf.date, userId: USER_ID });
  console.log(`  ${receiveResult.idempotent ? '⏭️  já estava recebido' : '✅ recebido'} · status=${receiveResult.status}`);
  if (!receiveResult.idempotent) {
    console.log(`  paymentsReceived=${receiveResult.paymentsReceived} · receivedAmount=R$${receiveResult.receivedAmount}`);
  }

  return { nf, preview, applied: true };
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`\n${APPLY ? '🔧 MODO APPLY (grava)' : '🔍 DRY-RUN (não grava nada)'}`);

  for (const nf of NFS) {
    await processOne(nf);
  }

  if (!APPLY) {
    console.log('\nNada foi gravado. Rode com --apply para aplicar.\n');
  } else {
    console.log('\n' + '═'.repeat(70));
    console.log('RECONCILIAÇÃO FINAL');
    console.log('═'.repeat(70));
    for (const nf of NFS) {
      const remaining = await Session.find({ _id: { $in: nf.sessionIds }, billingBatchId: null }).select('_id').lean();
      console.log(`  ${remaining.length === 0 ? '✅' : '🚫'} NF ${nf.invoiceNumber}: todas as sessões com billingBatchId (faltando: ${remaining.length})`);
    }
    console.log('═'.repeat(70));
  }

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
