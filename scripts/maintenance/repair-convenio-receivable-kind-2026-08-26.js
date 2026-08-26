#!/usr/bin/env node
/**
 * 🔧 REPARO: Payments de convênio com kind='convenio_receivable' (valor inválido)
 *
 * Contexto (2026-08-26): recebimento real da NF #115 falhou com
 * `ValidationError: kind: 'convenio_receivable' is not a valid enum value`.
 * `convenio_receivable` NUNCA existiu no enum de Payment.kind (conferido em
 * todo o histórico do git) — foi escrito via caminho de escrita raw que
 * bypassa a validação do Mongoose (updateMany/bulkWrite/collection.*), então
 * nunca gerou erro até algo chamar `.save()` no documento (que valida o
 * documento inteiro, não só os campos tocados).
 *
 * Universo: 213 Payments, `billingType:'convenio'` em 100% dos casos,
 * `isFromPackage:true` em ZERO casos (não é o mesmo bug do backfill de abril
 * já corrigido — é um valor de `kind` diferente, mesma classe de problema:
 * dado escrito fora do caminho canônico). 207/213 têm `package` vinculado
 * (referência informativa, não implica pré-pagamento — mesmo racional já
 * estabelecido no reparo de isFromPackage).
 *
 * Origem identificada por amostragem de `notes`:
 *   - "Recebível de convênio (corrigido de package_receipt)" — script
 *     histórico (não localizado no repo atual) que tentou corrigir Payments
 *     mal classificados como package_receipt, mas escreveu um kind que nunca
 *     foi declarado no schema.
 *   - "Payment criado automaticamente para session completed sem payment
 *     ativo" — script de 2026-06-25 (mesmo já citado na auditoria de
 *     isFromPackage), maioria status='canceled'.
 *   - "Payment criado manualmente - sessão sem package/valor".
 *
 * Decisão (usuário, 2026-08-26): NÃO adicionar 'convenio_receivable' ao enum
 * (evitar duas grafias pro mesmo conceito) — corrigir o dado na origem,
 * padronizando para 'session_payment' (o kind que o ConvenioHandler ativo já
 * usa hoje para todo Payment de sessão de convênio, independente de status
 * ou vínculo com package).
 *
 * NUNCA seta financialDate/paidAt/status/insurance.* — é correção de
 * metadado (kind), igual ao reparo de isFromPackage de ontem. Um registro
 * (6a1dfc6e416faf6dce8563b2) tem financialDate setado com status='pending' —
 * anomalia PRÉ-EXISTENTE não relacionada a este reparo (não é criada nem
 * agravada por ele, já que kind não influencia financialDate); fica registrada
 * para investigação futura separada.
 *
 * Modo padrão: DRY-RUN (só relatório, zero escrita).
 * Uso:
 *   node scripts/maintenance/repair-convenio-receivable-kind-2026-08-26.js
 *   node scripts/maintenance/repair-convenio-receivable-kind-2026-08-26.js --apply --expected-count=213
 *
 * Garantias (mesmo padrão do reparo de isFromPackage):
 *   - ATÔMICO: valida todos os candidatos e faz todos os CAS dentro de uma
 *     única transação MongoDB. Qualquer CAS que não modifique exatamente 1
 *     documento aborta a transação inteira (rollback total).
 *   - Idempotente: após o reparo, kind='session_payment' tira o registro da
 *     query do universo — segunda execução encontra 0 candidatos.
 *   - Snapshot completo antes/depois em JSON.
 *   - Rebuild de PatientsView pós-commit (com retry) só dos pacientes
 *     efetivamente reparados.
 */

import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Payment from '../../models/Payment.js';
import { buildPatientView } from '../../domains/clinical/services/patientProjectionService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

const ARGS = process.argv.slice(2);
const APPLY = ARGS.includes('--apply');
const expectedCountArg = ARGS.find(a => a.startsWith('--expected-count='));
const EXPECTED_COUNT = expectedCountArg ? parseInt(expectedCountArg.split('=')[1], 10) : null;

const SNAPSHOT_DIR = path.join(__dirname, 'snapshots');
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const TARGET_KIND = 'session_payment';

class RepairAbortedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RepairAbortedError';
  }
}

async function buildManifest(mongoSession) {
  const q = Payment.find({ kind: 'convenio_receivable' });
  if (mongoSession) q.session(mongoSession);
  const universe = await q.lean();

  const manifest = [];
  const nonActionable = [];

  for (const p of universe) {
    // Zero tolerância: qualquer coisa fora do padrão esperado (billingType
    // != convenio, ou isFromPackage=true — que pertenceria ao OUTRO reparo)
    // bloqueia o registro individualmente para revisão manual.
    if (p.billingType !== 'convenio') {
      nonActionable.push({ paymentId: p._id.toString(), motivo: `billingType inesperado: ${p.billingType}` });
      continue;
    }
    if (p.isFromPackage === true) {
      nonActionable.push({ paymentId: p._id.toString(), motivo: 'isFromPackage=true — pertence ao reparo de isFromPackage, não a este' });
      continue;
    }

    manifest.push({
      paymentId: p._id.toString(),
      patientId: p.patient?.toString() || null,
      package: p.package?.toString() || null,
      status: p.status,
      hasFinancialTrace: !!(p.financialDate || p.paidAt),
    });
  }

  return { manifest, nonActionable, universeSize: universe.length };
}

async function snapshotFullDocs(manifest) {
  const ids = manifest.map(m => m.paymentId);
  return Payment.find({ _id: { $in: ids } }).lean();
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

  console.log(`\n=== REPARO: kind='convenio_receivable' -> '${TARGET_KIND}' ===`);
  console.log(`Modo: ${APPLY ? '⚠️  APPLY (vai escrever, transação atômica)' : 'DRY-RUN (só leitura)'}`);
  if (EXPECTED_COUNT !== null) console.log(`Contagem esperada: ${EXPECTED_COUNT}`);

  if (!APPLY) {
    const { manifest, nonActionable, universeSize } = await buildManifest(null);
    console.log(`\nUniverso: ${universeSize} Payments (kind='convenio_receivable')`);
    console.log(`Acionáveis: ${manifest.length}`);
    console.log(`Não-acionáveis (bloqueiam apply): ${nonActionable.length}`);
    if (nonActionable.length > 0) {
      console.error('\n❌', JSON.stringify(nonActionable, null, 2));
    }
    const byStatus = {};
    manifest.forEach(m => { byStatus[m.status] = (byStatus[m.status] || 0) + 1; });
    const withFinancialTrace = manifest.filter(m => m.hasFinancialTrace);
    console.log(`\nPor status:`, JSON.stringify(byStatus));
    console.log(`Com financialDate/paidAt já setado (não alterado por este reparo, só informativo):`, withFinancialTrace.length);
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

      console.log(`\nUniverso recomputado (dentro da transação): ${built.universeSize} Payments`);
      console.log(`Acionáveis: ${manifest.length}, não-acionáveis: ${built.nonActionable.length}`);

      if (built.nonActionable.length > 0) {
        throw new RepairAbortedError(
          `${built.nonActionable.length} registro(s) NÃO acionáveis — abortando a transação inteira:\n${JSON.stringify(built.nonActionable, null, 2)}`
        );
      }
      if (EXPECTED_COUNT !== null && manifest.length !== EXPECTED_COUNT) {
        throw new RepairAbortedError(`Esperado ${EXPECTED_COUNT}, encontrado ${manifest.length} — estado do banco mudou desde a auditoria.`);
      }
      if (manifest.length === 0) {
        console.log('\n✅ Nada a fazer.');
        repaired = [];
        return;
      }

      const beforeSnapshot = await snapshotFullDocs(manifest);
      const beforePath = path.join(SNAPSHOT_DIR, `${RUN_ID}-convenio-receivable-kind-before.json`);
      fs.writeFileSync(beforePath, JSON.stringify({ manifest, snapshot: beforeSnapshot }, null, 2));
      console.log(`📸 Snapshot "antes" salvo em: ${beforePath}`);

      repaired = [];
      for (const item of manifest) {
        const result = await Payment.updateOne(
          { _id: item.paymentId, kind: 'convenio_receivable', status: item.status },
          { $set: { kind: TARGET_KIND } },
          { session: mongoSession }
        );

        if (result.modifiedCount !== 1) {
          throw new RepairAbortedError(
            `CAS não modificou exatamente 1 documento pra Payment ${item.paymentId} (modifiedCount=${result.modifiedCount}) — abortando TUDO (rollback).`
          );
        }

        repaired.push({ paymentId: item.paymentId, patientId: item.patientId });
        console.log(`  ✅ Reparado: ${item.paymentId} (paciente ${item.patientId})`);
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

  const patientsToRebuild = [...new Set(repaired.map(r => r.patientId).filter(Boolean))];
  console.log(`\n=== REBUILD DE PatientsView (${patientsToRebuild.length} pacientes, com retry) ===`);
  const rebuildResults = [];
  for (const patientId of patientsToRebuild) {
    const result = await rebuildPatientViewWithRetry(patientId, `integrity_repair_convenio_receivable_${RUN_ID}`);
    rebuildResults.push(result);
    console.log(result.status === 'ok'
      ? `  🔄 PatientsView reconstruída: ${patientId} (tentativa ${result.attempts})`
      : `  ❌ PatientsView de ${patientId} falhou após ${result.attempts} tentativas: ${result.error}`);
  }

  const afterSnapshot = await snapshotFullDocs(manifest);
  const afterPath = path.join(SNAPSHOT_DIR, `${RUN_ID}-convenio-receivable-kind-after.json`);
  fs.writeFileSync(afterPath, JSON.stringify({ repaired, rebuildResults, snapshot: afterSnapshot }, null, 2));
  console.log(`\n📸 Snapshot "depois" salvo em: ${afterPath}`);

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('❌ ERRO FATAL:', err);
  process.exit(1);
});
