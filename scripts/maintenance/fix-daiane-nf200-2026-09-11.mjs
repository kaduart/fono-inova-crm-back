#!/usr/bin/env node
/**
 * Reconciliação da NF 200 (Daiane Felix Bezerra, Unimed Fesp, guia 202602518072).
 *
 * ══ O QUE ACONTECEU ═══════════════════════════════════════════════════════
 *
 * A guia 202602518072 (id 6a3bcae786be5ba3b1a46153) tem 2 sessões completed
 * (avaliação 24/06/2026 R$250 + sessão 26/06/2026 R$180 = R$430) cujos
 * Payments nunca saíram de insurance.status='pending_billing' — nenhum lote
 * foi criado (billingBatchId null nos dois). A guia foi cancelada em
 * 12/08/2026 pelo fluxo antigo (pré-fix 2026-08-14), que não gerava
 * histórico nem tocava nada além do status — por isso hoje `canBill: false`
 * bloqueia faturar essa guia pela tela normal, e as 2 sessões ficam presas
 * pra sempre em "A Faturar"/atrasado no painel de Convênios.
 *
 * Confirmado pelo usuário (Ricardo, 2026-09-11): a NF real é a **200**, o
 * valor de R$430 foi efetivamente recebido do convênio. Sem data exata em
 * mãos — por decisão do usuário, usa a data das próprias sessões (última:
 * 26/06/2026) tanto pra emissão da NF quanto pro recebimento.
 *
 * ══ O QUE ESTE SCRIPT FAZ ═════════════════════════════════════════════════
 *
 *   1. Registra a NF 200 como InsuranceBatch legado via
 *      reconcileLegacyInsuranceBatch (origin: legacy_reconciliation, dryRun
 *      por padrão) cobrindo as 2 sessões — seta Session.billingBatchId e
 *      promove Payment.insurance.status → 'billed' nas 2.
 *   2. Baixa o lote como recebido via receiveInsuranceBatch (mesmo serviço
 *      canônico do botão "Marcar como recebido" da tela), com
 *      receivedDate=2026-06-26 — promove os 2 Payments a 'received'.
 *
 * Idempotente: reexecução detecta guide.status já 'cancelled' inalterado,
 * sessões já com billingBatchId e batch já 'received' (idempotent:true).
 *
 * ══ USO ═══════════════════════════════════════════════════════════════════
 *   node scripts/maintenance/fix-daiane-nf200-2026-09-11.mjs            (dry-run)
 *   node scripts/maintenance/fix-daiane-nf200-2026-09-11.mjs --apply
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
import InsuranceGuide from '../../models/InsuranceGuide.js';
import { reconcileLegacyInsuranceBatch } from '../../services/insuranceGuide/reconcileLegacyInsuranceBatch.js';
import { receiveInsuranceBatch } from '../../services/insuranceBatch/InsuranceBatchReceiptService.js';

const APPLY = process.argv.includes('--apply');

const PATIENT_ID = '6a3a93fb53b86f5ce4309c04';
const GUIDE_ID = '6a3bcae786be5ba3b1a46153'; // 202602518072 (cancelled)
const INSURANCE_PROVIDER = 'unimed-fesp';
const SESSION_IDS = ['6a3bc29486be5ba3b1a45ce4', '6a3bcd0f86be5ba3b1a461c9'];
const INVOICE_NUMBER = '200';
const NF_DATE = '2026-06-26';
const GROSS = 430;
const USER_ID = '6a2806fbd330bd5bec8e8d37'; // Ricardo Maia Santos (admin) — quem disparou a reconciliação

const MOTIVO = 'Reconciliação NF 200: guia cancelada em 12/08/2026 pelo fluxo antigo (sem histórico), 2 sessões nunca faturadas ficaram presas em pending_billing. Confirmado pelo usuário: NF 200, R$430 recebidos do convênio.';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`\n${APPLY ? '🔧 MODO APPLY (grava)' : '🔍 DRY-RUN (não grava nada)'}\n`);

  const guide = await InsuranceGuide.findById(GUIDE_ID).lean();
  if (!guide) { console.error('🚫 Guia não encontrada'); await mongoose.disconnect(); process.exit(2); }
  console.log(`guia ${guide.number} (${guide.status}) · usedSessions ${guide.usedSessions}/${guide.totalSessions}`);

  console.log('\n── PASSO 1: Lote legado (NF 200) ──');
  const previewOpts = {
    patientId: PATIENT_ID,
    insuranceProvider: INSURANCE_PROVIDER,
    sessionIds: SESSION_IDS,
    invoiceNumber: INVOICE_NUMBER,
    invoiceDate: NF_DATE,
    competenceMonth: '2026-06',
    documentedGross: GROSS,
    documentedNet: GROSS,
    documentReference: 'NF 200 · confirmada verbalmente pelo usuário (Ricardo, 2026-09-11) — sem PDF em mãos',
    notes: MOTIVO,
  };

  const preview = await reconcileLegacyInsuranceBatch({ ...previewOpts, dryRun: true });
  console.log(`  ${preview.sessionCount}/2 sessões resolvidas · bruto esperado R$${preview.expectedGross} · conferência: ${preview.reconciliation.status}`);
  if (preview.conflicts.length) {
    console.log('  conflitos:');
    preview.conflicts.forEach(c => console.log(`    - ${c.sessionId.slice(-6)}: ${c.code} (${c.detail})`));
  }
  if (preview.warnings.length) {
    preview.warnings.forEach(w => console.log(`    ⚠️  ${w.sessionId.slice(-6)}: ${w.code} (${w.detail})`));
  }

  // Já existe lote pra essas sessões? (idempotência)
  const alreadyBatched = await Session.find({ _id: { $in: SESSION_IDS }, billingBatchId: { $ne: null } })
    .select('_id billingBatchId').lean();

  if (!APPLY) {
    console.log('\nNada foi gravado. Rode com --apply para aplicar.\n');
    await mongoose.disconnect();
    return;
  }

  if (!preview.canWrite && alreadyBatched.length !== SESSION_IDS.length) {
    console.error('\n🚫 ABORTADO: preview com conflitos e sessões ainda não totalmente em lote.');
    await mongoose.disconnect();
    process.exit(2);
  }

  let batchId;
  if (alreadyBatched.length === SESSION_IDS.length) {
    batchId = alreadyBatched[0].billingBatchId.toString();
    console.log(`\n  ⏭️  sessões já em lote (${batchId}) — pulando criação, indo direto pro recebimento.`);
  } else {
    const result = await reconcileLegacyInsuranceBatch({ ...previewOpts, dryRun: false });
    batchId = result.batchId;
    console.log(`\n  ✅ lote criado: ${result.batchNumber} (${result.batchId})`);
    console.log(`  ${result.promotedPayments} payment(s) promovidos a 'billed', ${result.preservedPayments} preservados`);
  }

  console.log('\n── PASSO 2: Baixa como recebido ──');
  const receiveResult = await receiveInsuranceBatch(batchId, { receivedDate: NF_DATE, userId: USER_ID });
  console.log(`  ${receiveResult.idempotent ? '⏭️  já estava recebido (idempotente)' : '✅ recebido'} · status=${receiveResult.status}`);
  if (!receiveResult.idempotent) {
    console.log(`  paymentsReceived=${receiveResult.paymentsReceived} · receivedAmount=R$${receiveResult.receivedAmount}`);
  }

  // ── Reconciliação final ─────────────────────────────────────────────────
  const finalSessions = await Session.find({ _id: { $in: SESSION_IDS } }).select('_id billingBatchId').lean();
  const semLote = finalSessions.filter(s => !s.billingBatchId);

  console.log('\n' + '═'.repeat(70));
  console.log('RECONCILIAÇÃO FINAL');
  console.log('═'.repeat(70));
  console.log(`  ${semLote.length === 0 ? '✅' : '🚫'} todas as 2 sessões com billingBatchId (faltando: ${semLote.length})`);
  console.log('═'.repeat(70));

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
