#!/usr/bin/env node
/**
 * Reconciliação da NF 230 (Daiane Felix Bezerra, Unimed Fesp, guia 202602517989).
 *
 * ══ O QUE ACONTECEU ═══════════════════════════════════════════════════════
 *
 * A guia 202602517989 (MENSAL, 10/10 sessões, esgotada) tem 10 atendimentos
 * completed de 01/07 a 05/08/2026, todos R$180 (total R$1.800). A clínica
 * emitiu de verdade a NF 230 (05/08/2026, Prefeitura de Anápolis, PDF em
 * mãos) cobrindo os 10.
 *
 * No sistema, 8 desses 10 Payments estão com status='canceled' apesar da
 * Session estar 'completed' — conflito de integridade que o backend detecta
 * (paymentIntegrityConflictCount) e por isso some tanto de "A Faturar" quanto
 * de "Faturados". Causa: o campo Payment.insuranceGuide desses 8 ainda aponta
 * para uma guia ANTERIOR já cancelada (202602518072) — a Session foi
 * relinkada pra guia atual em algum momento, o Payment não. Em 12/08/2026
 * 13:47 (mesmíssimo updatedAt nos 8), algo cancelou em lote os payments
 * ligados àquela guia velha cancelada e pegou estes de arrasto.
 *
 * ══ O QUE ESTE SCRIPT FAZ ═════════════════════════════════════════════════
 *
 *   1. Corrige os 8 Payments: status canceled → pending (via
 *      transitionPaymentStatus, canônico — emite evento), e corrige
 *      insuranceGuide/insurance.guideId pra guia atual (202602517989).
 *   2. Registra a NF 230 como InsuranceBatch legado via
 *      reconcileLegacyInsuranceBatch (origin: legacy_reconciliation, dryRun
 *      por padrão) cobrindo as 10 sessões — isso seta Session.billingBatchId
 *      e promove Payment.insurance.status → 'billed' nos 10, movendo a guia
 *      inteira pra "Faturados · aguardando recebimento".
 *
 * Idempotente: reexecução detecta que já não há payment 'canceled' entre os
 * 8 e que a guia já tem lote, e não repete a escrita.
 *
 * ══ USO ═══════════════════════════════════════════════════════════════════
 *   node scripts/maintenance/fix-daiane-nf230-2026-09-02.js            (dry-run)
 *   node scripts/maintenance/fix-daiane-nf230-2026-09-02.js --apply
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../../.env') });
dotenv.config();

import '../../models/index.js';
import Payment from '../../models/Payment.js';
import Session from '../../models/Session.js';
import InsuranceGuide from '../../models/InsuranceGuide.js';
import { transitionPaymentStatus } from '../../services/paymentStatusService.js';
import { reconcileLegacyInsuranceBatch } from '../../services/insuranceGuide/reconcileLegacyInsuranceBatch.js';

const APPLY = process.argv.includes('--apply');

const PATIENT_ID = '6a3a93fb53b86f5ce4309c04';
const GUIDE_ID = '6a3bd6105b6d4a449ef8d959'; // 202602517989
const WRONG_GUIDE_ID = '6a3bcae786be5ba3b1a46153'; // 202602518072 (cancelada — referência velha)
const INSURANCE_PROVIDER = 'unimed-fesp';

const PAYMENTS_TO_REVIVE = [
  '6a3bcd0f86be5ba3b1a461bf', '6a3bcd0f86be5ba3b1a461be', '6a3bcd0f86be5ba3b1a461c1',
  '6a3bcd0f86be5ba3b1a461c0', '6a3bcd0f86be5ba3b1a461c3', '6a3bcd0f86be5ba3b1a461c2',
  '6a3bcd0f86be5ba3b1a461c5', '6a3bcd0f86be5ba3b1a461c4'
];

const ALL_10_SESSION_IDS = [
  '6a3bcd0f86be5ba3b1a461cb', '6a3bcd0f86be5ba3b1a461ca', '6a3bcd0f86be5ba3b1a461cd',
  '6a3bcd0f86be5ba3b1a461cc', '6a3bcd0f86be5ba3b1a461cf', '6a3bcd0f86be5ba3b1a461ce',
  '6a3bcd0f86be5ba3b1a461d1', '6a3bcd0f86be5ba3b1a461d0', '6a6892fd848d16ca08e4a3b4',
  '6a6892fd848d16ca08e4a3b6'
];

const MOTIVO = 'Reconciliação NF 230: payment cancelado por referência de guia desatualizada (guia anterior 202602518072); sessão confirmada na guia atual 202602517989 e na NF real emitida 05/08/2026.';

const oid = (s) => new mongoose.Types.ObjectId(s);

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`\n${APPLY ? '🔧 MODO APPLY (grava)' : '🔍 DRY-RUN (não grava nada)'}\n`);

  // ── Levantamento ──────────────────────────────────────────────────────
  const payments = await Payment.find({ _id: { $in: PAYMENTS_TO_REVIVE.map(oid) } }).lean();
  const guide = await InsuranceGuide.findById(GUIDE_ID).lean();

  console.log('── PASSO 1: Payments a reviver ──');
  const problemas1 = [];
  for (const id of PAYMENTS_TO_REVIVE) {
    const p = payments.find(x => String(x._id) === id);
    if (!p) { problemas1.push(`payment ${id} não encontrado`); continue; }
    if (p.status !== 'canceled') {
      console.log(`  ⏭️  ${id}: status já é '${p.status}' — no-op`);
      continue;
    }
    const wrongGuide = String(p.insuranceGuide) === WRONG_GUIDE_ID;
    console.log(`  ↩️  ${id}: canceled → pending${wrongGuide ? `, insuranceGuide ${WRONG_GUIDE_ID.slice(-6)} → ${GUIDE_ID.slice(-6)}` : ''}`);
  }
  if (problemas1.length) {
    console.error('\n🚫 ABORTADO:', problemas1.join('; '));
    await mongoose.disconnect();
    process.exit(2);
  }

  console.log('\n── PASSO 2: Lote legado (NF 230) ──');
  const preview = await reconcileLegacyInsuranceBatch({
    patientId: PATIENT_ID,
    insuranceProvider: INSURANCE_PROVIDER,
    sessionIds: ALL_10_SESSION_IDS,
    invoiceNumber: '230',
    invoiceDate: '2026-08-05',
    competenceMonth: '2026-08',
    documentedGross: 1800,
    documentedNet: 1800,
    issRate: 2.30,
    issAmount: 41.40,
    documentReference: 'NF-e 230 · Prefeitura de Anápolis · PDF fornecido pela clínica',
    notes: MOTIVO,
    dryRun: true // sempre prévia primeiro, mesmo em --apply
  });

  console.log(`  guia: ${guide.number} (${guide.status}) · ${preview.sessionCount}/10 sessões resolvidas`);
  console.log(`  bruto esperado: R$${preview.expectedGross}  ·  documentado: R$${preview.documentedGross}  ·  conferência: ${preview.reconciliation.status}`);
  if (preview.conflicts.length) {
    console.log('  conflitos (pré-fix, esperado nos 8 ainda cancelados):');
    preview.conflicts.forEach(c => console.log(`    - ${c.sessionId.slice(-6)}: ${c.code} (${c.detail})`));
  }
  if (preview.warnings.length) {
    preview.warnings.forEach(w => console.log(`    ⚠️  ${w.sessionId.slice(-6)}: ${w.code} (${w.detail})`));
  }

  if (!APPLY) {
    console.log('\nNada foi gravado. Rode com --apply para aplicar.\n');
    await mongoose.disconnect();
    return;
  }

  // ── Escrita: passo 1 (reviver payments) ────────────────────────────────
  let revividos = 0;
  for (const id of PAYMENTS_TO_REVIVE) {
    const p = payments.find(x => String(x._id) === id);
    if (!p || p.status !== 'canceled') continue;

    await transitionPaymentStatus(id, 'pending', { reason: MOTIVO });
    await Payment.updateOne(
      { _id: id },
      {
        $set: {
          insuranceGuide: oid(GUIDE_ID),
          'insurance.guideId': oid(GUIDE_ID),
          notes: `${MOTIVO} ${p.notes || ''}`.trim(),
          updatedAt: new Date()
        }
      }
    );
    console.log(`  ✅ ${id}: revivido e religado à guia ${GUIDE_ID.slice(-6)}`);
    revividos++;
  }
  console.log(`  ${revividos} payment(s) revividos.`);

  // ── Escrita: passo 2 (lote legado de verdade) ──────────────────────────
  const result = await reconcileLegacyInsuranceBatch({
    patientId: PATIENT_ID,
    insuranceProvider: INSURANCE_PROVIDER,
    sessionIds: ALL_10_SESSION_IDS,
    invoiceNumber: '230',
    invoiceDate: '2026-08-05',
    competenceMonth: '2026-08',
    documentedGross: 1800,
    documentedNet: 1800,
    issRate: 2.30,
    issAmount: 41.40,
    documentReference: 'NF-e 230 · Prefeitura de Anápolis · PDF fornecido pela clínica',
    notes: MOTIVO,
    dryRun: false
  });

  console.log(`\n  ✅ lote criado: ${result.batchNumber} (${result.batchId})`);
  console.log(`  ${result.promotedPayments} payment(s) promovidos a 'billed', ${result.preservedPayments} preservados`);

  // ── Reconciliação final ─────────────────────────────────────────────────
  const finalSessions = await Session.find({ _id: { $in: ALL_10_SESSION_IDS.map(oid) } })
    .select('_id billingBatchId').lean();
  const finalPayments = await Payment.find({ _id: { $in: [...payments.map(p => p._id)] } }).lean();
  const semLote = finalSessions.filter(s => !s.billingBatchId);
  const aindaCancelado = await Payment.find({ _id: { $in: PAYMENTS_TO_REVIVE.map(oid) }, status: 'canceled' }).lean();

  console.log('\n' + '═'.repeat(70));
  console.log('RECONCILIAÇÃO FINAL');
  console.log('═'.repeat(70));
  console.log(`  ${semLote.length === 0 ? '✅' : '🚫'} todas as 10 sessões com billingBatchId (faltando: ${semLote.length})`);
  console.log(`  ${aindaCancelado.length === 0 ? '✅' : '🚫'} nenhum dos 8 payments ainda 'canceled' (restantes: ${aindaCancelado.length})`);
  console.log('═'.repeat(70));

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
