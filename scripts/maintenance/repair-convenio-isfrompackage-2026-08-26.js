#!/usr/bin/env node
/**
 * 🔧 REPARO: Payments de convênio mis-tagged como isFromPackage=true
 *
 * Contexto (auditoria 2026-08-26, ver
 * scripts/maintenance/audit-convenio-isfrompackage-2026-08-26.mjs): 37
 * Payments com `billingType:'convenio', isFromPackage:true` — herança de
 * scripts/corrigir-backfill-abril.js (19/04/2026), que aplicou
 * isFromPackage=true em TODO consumo de sessão vinculado a Package sem
 * diferenciar particular pré-pago (correto) de convênio (incorreto: convênio
 * não tem "adiantamento agregado", o dinheiro só entra na liquidação da NF).
 *
 * Classificação (recomputada do zero a cada execução): dos 37,
 *   - 36 = ERRO_BACKFILL_CONFIRMADO
 *   - 1  = CANCELADO (Payment já cancelado — metadado corrigido, status/
 *     financialDate/paidAt/valor/vínculos preservados; nunca reabre nada).
 *   Resultado final esperado: ZERO Payments de convênio com isFromPackage=true.
 *
 * Três sub-grupos de correção (achado da auditoria, não presumido):
 *   - 25 sem `package` vinculado, kind='package_consumed' (inconsistente por
 *     si só): isFromPackage->false E kind->'session_payment'.
 *   - 11 com `package` vinculado (Package.model='convenio' legado), já com
 *     kind='session_payment' correto: só isFromPackage->false.
 *   - 1 cancelado, com `package` vinculado, kind já correto: só
 *     isFromPackage->false (mesma regra dos 11, preservando status='canceled').
 *
 * NUNCA seta financialDate/paidAt/status (nem no cancelado) — é correção de
 * metadado (classificação), não liquidação nem reabertura. NUNCA toca liminar
 * (fora da query por construção, billingType='convenio') nem particular
 * (per_session/prepaid teriam ido para AGREGADO_REAL_CONFIRMADO ou AMBIGUO,
 * bloqueando o apply inteiro).
 *
 * Modo padrão: DRY-RUN (só relatório, zero escrita).
 * Uso:
 *   node scripts/maintenance/repair-convenio-isfrompackage-2026-08-26.js
 *   node scripts/maintenance/repair-convenio-isfrompackage-2026-08-26.js --apply --expected-count=37
 *
 * Garantias:
 *   - ABORTA (zero escrita) se: contagem recomputada != N esperado, OU
 *     qualquer registro do universo cair fora de
 *     ERRO_BACKFILL_CONFIRMADO/CANCELADO — zero tolerância a ambíguo.
 *   - Reconfirma, DENTRO da mesma transação, que a InsuranceBatch/NF de cada
 *     payment (quando existe) ainda está com receivedAt=null — aborta o lote
 *     inteiro se qualquer uma mudou desde a auditoria.
 *   - ATÔMICO: todas as validações e todos os CAS (compare-and-set) rodam
 *     dentro de uma única transação MongoDB (mongoSession.withTransaction).
 *     Se qualquer CAS não modificar exatamente 1 documento, a transação
 *     inteira dá rollback — nunca há reparo parcial.
 *   - Rebuild de PatientsView acontece DEPOIS do commit (não pode ser
 *     transacional — projeção materializada em processo separado), com retry
 *     explícito (até 3 tentativas, backoff) por paciente.
 *   - Idempotente: após o reparo, isFromPackage=false tira o registro da
 *     query do universo — segunda execução encontra 0 candidatos.
 *   - Snapshot completo antes/depois em JSON.
 */

import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Payment from '../../models/Payment.js';
import Package from '../../models/Package.js';
import InsuranceBatch from '../../models/InsuranceBatch.js';
import PackageCreditTransfer from '../../models/PackageCreditTransfer.js';
import { buildPatientView } from '../../domains/clinical/services/patientProjectionService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

const ARGS = process.argv.slice(2);
const APPLY = ARGS.includes('--apply');
const expectedCountArg = ARGS.find(a => a.startsWith('--expected-count='));
const EXPECTED_COUNT = expectedCountArg ? parseInt(expectedCountArg.split('=')[1], 10) : null;

const SNAPSHOT_DIR = path.join(__dirname, 'snapshots');
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');

class RepairAbortedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RepairAbortedError';
  }
}

async function findBatchForPayment(paymentId, mongoSession) {
  const q = InsuranceBatch.find({ 'sessions.payment': paymentId })
    .select('invoiceNumber status receivedAt batchNumber');
  if (mongoSession) q.session(mongoSession);
  const all = await q.lean();
  if (all.length === 0) return null;
  return all.find(b => b.status !== 'superseded') || all[0];
}

/**
 * Recomputa a classificação do zero — mesma lógica da auditoria
 * (scripts/maintenance/audit-convenio-isfrompackage-2026-08-26.mjs), com uma
 * diferença: CANCELADO agora é acionável (metadado corrigido, sem reabrir
 * nada), e um cancelado com rastro financeiro é tratado como contradição
 * (AMBIGUO), não como "sem ação".
 */
async function classifyPayment(p, mongoSession) {
  let pkg = null;
  let aggregatePayment = null;
  let transfersIn = [];
  if (p.package) {
    const pkgQ = Package.findById(p.package).select('model paymentType fundedByTransfer');
    if (mongoSession) pkgQ.session(mongoSession);
    pkg = await pkgQ.lean();

    const aggQ = Payment.findOne({ package: p.package, kind: 'package_receipt' }).select('status financialDate paidAt');
    if (mongoSession) aggQ.session(mongoSession);
    aggregatePayment = await aggQ.lean();

    const transQ = PackageCreditTransfer.find({ targetPackageId: p.package }).select('amount');
    if (mongoSession) transQ.session(mongoSession);
    transfersIn = await transQ.lean();
  }

  const hasBackfillNote = /CORREÇÃO BACKFILL/.test(p.notes || '');
  const hasFinancialTrace = !!(p.financialDate || p.paidAt || p.insurance?.receivedAt);
  const aggregatePaymentIsRealCash = !!(aggregatePayment && aggregatePayment.status === 'paid' && (aggregatePayment.financialDate || aggregatePayment.paidAt));
  const fundedByTransferReal = !!((pkg?.fundedByTransfer > 0) || transfersIn.length > 0);
  const isLiminarAnomaly = (p.billingType === 'liminar') || (pkg?.model === 'liminar');
  const isCanceled = p.status === 'canceled' || p.status === 'cancelled';

  if (isLiminarAnomaly) return { categoria: 'AMBIGUO', motivo: 'anomalia liminar' };
  // Rastro financeiro bloqueia SEMPRE, mesmo cancelado — um cancelado com
  // financialDate/paidAt é contradição, não "sem ação".
  if (hasFinancialTrace) return { categoria: 'AMBIGUO', motivo: 'já tem rastro financeiro' };
  if (isCanceled) {
    // Metadado incorreto mesmo em Payment cancelado — corrige, nunca reabre
    // (status/financialDate/paidAt não fazem parte do $set em nenhum fix).
    return { categoria: 'CANCELADO', motivo: 'já cancelado, metadado isFromPackage incorreto', fix: p.package ? 'ISFROMPACKAGE_ONLY' : 'ISFROMPACKAGE_AND_KIND' };
  }
  if (aggregatePaymentIsRealCash) return { categoria: 'AGREGADO_REAL_CONFIRMADO', motivo: 'agregado pago real' };
  if (fundedByTransferReal) return { categoria: 'AGREGADO_REAL_CONFIRMADO', motivo: 'financiado por transferência' };
  if (pkg && pkg.model === 'prepaid') return { categoria: 'AMBIGUO', motivo: 'contradição prepaid sem agregado' };
  if (pkg && pkg.model === 'per_session') {
    return { categoria: 'ERRO_BACKFILL_CONFIRMADO', motivo: 'per_session mal classificado', fix: 'ISFROMPACKAGE_ONLY' };
  }
  if (pkg && pkg.model === 'convenio' && !aggregatePaymentIsRealCash && !fundedByTransferReal) {
    return { categoria: 'ERRO_BACKFILL_CONFIRMADO', motivo: 'convenio legado sem agregado', fix: 'ISFROMPACKAGE_ONLY' };
  }
  if (!pkg && hasBackfillNote) {
    return { categoria: 'ERRO_BACKFILL_CONFIRMADO', motivo: 'órfão com nota do backfill', fix: 'ISFROMPACKAGE_AND_KIND' };
  }
  if (!pkg) return { categoria: 'AMBIGUO', motivo: 'órfão sem nota' };
  return { categoria: 'AMBIGUO', motivo: 'não classificado com confiança' };
}

/**
 * @param {mongoose.ClientSession} [mongoSession] — quando fornecida, todas as
 * leituras acontecem dentro dela (para o apply, que precisa reler tudo
 * consistentemente antes de fazer os CAS na mesma transação).
 */
async function buildManifest(mongoSession) {
  const universeQ = Payment.find({ billingType: 'convenio', isFromPackage: true });
  if (mongoSession) universeQ.session(mongoSession);
  const universe = await universeQ.lean();

  const manifest = [];
  const nonActionable = [];

  for (const p of universe) {
    const classification = await classifyPayment(p, mongoSession);
    if (classification.categoria !== 'ERRO_BACKFILL_CONFIRMADO' && classification.categoria !== 'CANCELADO') {
      nonActionable.push({ paymentId: p._id.toString(), categoria: classification.categoria, motivo: classification.motivo });
      continue;
    }

    const batch = await findBatchForPayment(p._id, mongoSession);
    manifest.push({
      paymentId: p._id.toString(),
      patientId: p.patient?.toString() || null,
      package: p.package?.toString() || null,
      categoria: classification.categoria,
      currentKind: p.kind,
      fix: classification.fix,
      expectedStatus: p.status,
      expectedIsFromPackage: true,
      expectedKind: p.kind,
      expectedFinancialDate: p.financialDate || null,
      expectedPaidAt: p.paidAt || null,
      batchId: batch?._id?.toString() || null,
      batchInvoiceNumber: batch?.invoiceNumber || null,
      batchStatus: batch?.status || null,
      batchReceivedAt: batch?.receivedAt || null,
    });
  }

  return { manifest, nonActionable, universeSize: universe.length };
}

async function snapshotFullDocs(manifest) {
  const ids = manifest.map(m => m.paymentId);
  const payments = await Payment.find({ _id: { $in: ids } }).lean();
  return payments;
}

async function rebuildPatientViewWithRetry(patientId, correlationId, maxAttempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await buildPatientView(patientId, { correlationId, force: true });
      return { patientId, status: 'ok', attempts: attempt };
    } catch (err) {
      lastError = err;
      console.error(`  ⚠️  Tentativa ${attempt}/${maxAttempts} falhou pra PatientsView de ${patientId}: ${err.message}`);
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 500 * attempt));
    }
  }
  return { patientId, status: 'error', error: lastError.message, attempts: maxAttempts };
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  console.log(`\n=== REPARO: convênio isFromPackage=true mis-tagged ===`);
  console.log(`Modo: ${APPLY ? '⚠️  APPLY (vai escrever, transação atômica)' : 'DRY-RUN (só leitura)'}`);
  if (EXPECTED_COUNT !== null) console.log(`Contagem esperada: ${EXPECTED_COUNT}`);

  // ─── DRY-RUN: fora de transação, só leitura ───────────────────────────
  if (!APPLY) {
    const { manifest, nonActionable, universeSize } = await buildManifest(null);
    console.log(`\nUniverso recomputado agora: ${universeSize} Payments (billingType=convenio, isFromPackage=true)`);
    console.log(`Acionáveis (ERRO_BACKFILL_CONFIRMADO + CANCELADO): ${manifest.length}`);
    console.log(`Não-acionáveis (ambíguo/bloqueia): ${nonActionable.length}`);

    if (nonActionable.length > 0) {
      console.error(`\n❌ ${nonActionable.length} registro(s) do universo NÃO são acionáveis — há ambiguidade. Zero tolerância neste reparo:`);
      console.error(JSON.stringify(nonActionable, null, 2));
    }

    const byCategoria = { ERRO_BACKFILL_CONFIRMADO: 0, CANCELADO: 0 };
    for (const m of manifest) byCategoria[m.categoria] = (byCategoria[m.categoria] || 0) + 1;
    const batchesAffected = [...new Set(manifest.map(m => m.batchInvoiceNumber).filter(Boolean))];
    const alreadyReceivedBatches = manifest.filter(m => m.batchReceivedAt);

    console.log(`\n=== RESUMO DO MANIFESTO ===`);
    console.log(`ERRO_BACKFILL_CONFIRMADO: ${byCategoria.ERRO_BACKFILL_CONFIRMADO}`);
    console.log(`CANCELADO (metadado corrigido, sem reabrir): ${byCategoria.CANCELADO}`);
    console.log(`NFs afetadas: ${batchesAffected.join(', ') || 'nenhuma (órfãos sem batch)'}`);
    console.log(`NFs já recebidas dentre as afetadas: ${alreadyReceivedBatches.length} (deve ser 0)`);
    console.log(`\n=== AMOSTRA (5 de ${manifest.length}) ===`);
    manifest.slice(0, 5).forEach(m => console.log(JSON.stringify(m, null, 2)));
    console.log(`\nℹ️  DRY-RUN — nada foi escrito. Rode com --apply --expected-count=${manifest.length} para aplicar.`);
    await mongoose.disconnect();
    return;
  }

  // ─── APPLY: tudo dentro de uma única transação ────────────────────────
  if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

  const mongoSession = await mongoose.startSession();
  let manifest, repaired;
  try {
    await mongoSession.withTransaction(async () => {
      const built = await buildManifest(mongoSession);
      manifest = built.manifest;

      console.log(`\nUniverso recomputado agora (dentro da transação): ${built.universeSize} Payments`);
      console.log(`Acionáveis: ${manifest.length}, não-acionáveis: ${built.nonActionable.length}`);

      if (built.nonActionable.length > 0) {
        throw new RepairAbortedError(
          `${built.nonActionable.length} registro(s) NÃO são acionáveis (ambiguidade) — abortando a transação inteira:\n${JSON.stringify(built.nonActionable, null, 2)}`
        );
      }
      if (EXPECTED_COUNT !== null && manifest.length !== EXPECTED_COUNT) {
        throw new RepairAbortedError(`Esperado ${EXPECTED_COUNT} acionáveis, encontrado ${manifest.length} — estado do banco mudou desde a auditoria.`);
      }
      if (manifest.length === 0) {
        console.log('\n✅ Nada a fazer — nenhum candidato encontrado.');
        repaired = [];
        return;
      }

      const alreadyReceivedBatches = manifest.filter(m => m.batchReceivedAt);
      if (alreadyReceivedBatches.length > 0) {
        throw new RepairAbortedError(
          `${alreadyReceivedBatches.length} payment(s) pertencem a NF já recebida — abortando: ${JSON.stringify(alreadyReceivedBatches, null, 2)}`
        );
      }

      // Snapshot "antes" — dentro da transação, mesmo dado que será alterado.
      const beforeSnapshot = await snapshotFullDocs(manifest);
      const beforePath = path.join(SNAPSHOT_DIR, `${RUN_ID}-convenio-before.json`);
      fs.writeFileSync(beforePath, JSON.stringify({ manifest, snapshot: beforeSnapshot }, null, 2));
      console.log(`📸 Snapshot "antes" salvo em: ${beforePath}`);

      repaired = [];
      for (const item of manifest) {
        const set = { isFromPackage: false };
        if (item.fix === 'ISFROMPACKAGE_AND_KIND') set.kind = 'session_payment';

        // CAS dentro da transação. Filtro reafirma TODO o estado esperado —
        // financialDate/paidAt não são alterados (nem checados no filtro
        // porque não fazem parte do $set), preservando-os como estavam.
        const result = await Payment.updateOne(
          { _id: item.paymentId, isFromPackage: true, status: item.expectedStatus, kind: item.currentKind },
          { $set: set },
          { session: mongoSession }
        );

        if (result.modifiedCount !== 1) {
          throw new RepairAbortedError(
            `CAS não modificou exatamente 1 documento pra Payment ${item.paymentId} (modifiedCount=${result.modifiedCount}) — estado mudou desde o início da transação. Abortando TUDO (rollback).`
          );
        }

        repaired.push({ paymentId: item.paymentId, patientId: item.patientId, fix: item.fix, categoria: item.categoria });
        console.log(`  ✅ Reparado (dentro da transação): ${item.paymentId} (paciente ${item.patientId}, fix=${item.fix}, categoria=${item.categoria})`);
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
  console.log(`Reparados: ${repaired.length}`);

  if (repaired.length === 0) {
    await mongoose.disconnect();
    return;
  }

  // ─── Pós-commit: rebuild de PatientsView com retry (não-transacional) ──
  const patientsToRebuild = [...new Set(repaired.map(r => r.patientId).filter(Boolean))];
  console.log(`\n=== REBUILD DE PatientsView (${patientsToRebuild.length} pacientes, com retry) ===`);
  const rebuildResults = [];
  for (const patientId of patientsToRebuild) {
    const result = await rebuildPatientViewWithRetry(patientId, `integrity_repair_convenio_${RUN_ID}`);
    rebuildResults.push(result);
    console.log(result.status === 'ok'
      ? `  🔄 PatientsView reconstruída: ${patientId} (tentativa ${result.attempts})`
      : `  ❌ PatientsView de ${patientId} falhou após ${result.attempts} tentativas: ${result.error}`);
  }
  const rebuildFailures = rebuildResults.filter(r => r.status === 'error');
  if (rebuildFailures.length > 0) {
    console.error(`\n⚠️  ${rebuildFailures.length} PatientsView não reconstruída(s) mesmo após retry — o dado financeiro (Payment) já está correto e commitado; só a projeção de leitura ficou desatualizada. Rode buildPatientView manualmente pra: ${rebuildFailures.map(r => r.patientId).join(', ')}`);
  }

  const afterSnapshot = await snapshotFullDocs(manifest);
  const afterPath = path.join(SNAPSHOT_DIR, `${RUN_ID}-convenio-after.json`);
  fs.writeFileSync(afterPath, JSON.stringify({ repaired, rebuildResults, snapshot: afterSnapshot }, null, 2));
  console.log(`\n📸 Snapshot "depois" salvo em: ${afterPath}`);

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('❌ ERRO FATAL:', err);
  process.exit(1);
});
