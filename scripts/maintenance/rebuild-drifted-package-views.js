#!/usr/bin/env node
/**
 * Reconstrói as PackagesView que divergem do domínio.
 *
 * Contexto (incidente 2026-08-12): o payload de APPOINTMENT_CANCELLED não
 * levava `packageId`, então o packageProjectionWorker descartava o evento em
 * `ignored / no_package_id` e a view nunca era reconstruída. O emissor já foi
 * corrigido — este script limpa o passivo acumulado enquanto o bug existiu.
 *
 * Divergência medida contra a fonte de verdade (Appointment/Session):
 *   - sessionsCanceled  vs  appointments com operationalStatus='canceled'
 *   - sessionsUsed      vs  appointments com operationalStatus='completed'
 *   - view mais antiga que a última mutação de um appointment do pacote
 *
 * USO:
 *   node scripts/maintenance/rebuild-drifted-package-views.js              # dry-run (padrão)
 *   node scripts/maintenance/rebuild-drifted-package-views.js --apply      # grava
 *   node scripts/maintenance/rebuild-drifted-package-views.js --apply --id=<packageId>
 *
 * Sem --apply nada é escrito. Com --apply, a única escrita é o rebuild da
 * projeção a partir do domínio — nenhum dado de negócio é alterado.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../../.env') });
dotenv.config();

import '../../models/index.js';
import PackagesView from '../../models/PackagesView.js';
import Appointment from '../../models/Appointment.js';
import Session from '../../models/Session.js';
import { buildPackageView } from '../../domains/billing/services/PackageProjectionService.js';

const APPLY = process.argv.includes('--apply');
const INCLUDE_STALE = process.argv.includes('--include-stale');
const ONLY_ID = process.argv.find(a => a.startsWith('--id='))?.split('=')[1] || null;

function fmt(d) {
  return d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '—';
}

/**
 * Espelha calculateSessionMetrics() do PackageProjectionService:
 *   sessionsUsed     = max(appointments completed, sessions completed)
 *   sessionsCanceled = max(appointments canceled,  sessions canceled)
 *
 * Comparar só contra Appointment produzia falso positivo (a view legitimamente
 * fica maior quando a Session está cancelada e o Appointment não). O objetivo
 * aqui é achar view DESATUALIZADA, não discordar da regra da projeção.
 */
async function measure(view) {
  const pid = view.packageId;
  if (!pid) return null;

  const [apptCanceled, apptCompleted, sessCanceled, sessCompleted, lastMutation] = await Promise.all([
    Appointment.countDocuments({ package: pid, operationalStatus: 'canceled' }),
    Appointment.countDocuments({ package: pid, operationalStatus: 'completed' }),
    Session.countDocuments({ package: pid, status: 'canceled' }),
    Session.countDocuments({ package: pid, status: 'completed' }),
    Appointment.findOne({ package: pid }).sort({ updatedAt: -1 }).select('updatedAt').lean(),
  ]);

  const realCanceled = Math.max(apptCanceled, sessCanceled);
  const realCompleted = Math.max(apptCompleted, sessCompleted);

  const viewCanceled = view.sessionsCanceled || 0;
  const viewUsed = view.sessionsUsed || 0;
  const calculatedAt = view.snapshot?.calculatedAt || null;

  const stale = Boolean(
    lastMutation?.updatedAt && calculatedAt && new Date(lastMutation.updatedAt) > new Date(calculatedAt)
  );
  const drifted = viewCanceled !== realCanceled || viewUsed !== realCompleted;

  if (!drifted && !stale) return null;

  return {
    packageId: pid.toString(),
    viewId: view._id.toString(),
    patient: view.searchFields?.patientName || '—',
    viewCanceled, realCanceled,
    viewUsed, realCompleted,
    calculatedAt, lastMutationAt: lastMutation?.updatedAt || null,
    drifted,
    reason: drifted ? 'contagem divergente' : 'apenas defasada (contagens batem)',
  };
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`\n${APPLY ? '🔧 MODO APPLY (grava)' : '🔍 DRY-RUN (não grava nada)'}\n`);

  const query = { status: { $ne: 'canceled' } };
  if (ONLY_ID) query.packageId = new mongoose.Types.ObjectId(ONLY_ID);

  const views = await PackagesView.find(query).lean();
  console.log(`Analisando ${views.length} projeções…\n`);

  const found = [];
  for (const view of views) {
    const result = await measure(view);
    if (result) found.push(result);
  }

  // Só as de contagem divergente entram no rebuild por padrão. "Apenas
  // defasada" significa que o appointment foi tocado depois do último build
  // sem mover métrica (ex.: sync de pagamento) — reconstruir não muda nada.
  const drifted = found.filter(f => f.drifted);
  const staleOnly = found.filter(f => !f.drifted);
  const targets = INCLUDE_STALE ? found : drifted;

  console.log(`📊 ${drifted.length} com contagem divergente | ${staleOnly.length} apenas defasadas (sem impacto na métrica)\n`);

  if (targets.length === 0) {
    console.log('✅ Nada a reconstruir.');
    await mongoose.disconnect();
    return;
  }

  targets.sort((a, b) => new Date(b.lastMutationAt || 0) - new Date(a.lastMutationAt || 0));

  console.log(`Alvos (${targets.length}):\n`);
  console.log('pacote        paciente                 canc(view→real)  usadas(view→real)  view calculada em   motivo');
  console.log('─'.repeat(122));
  for (const t of targets) {
    console.log(
      t.packageId.slice(-8).padEnd(13),
      String(t.patient).slice(0, 22).padEnd(24),
      `${t.viewCanceled}→${t.realCanceled}`.padEnd(17),
      `${t.viewUsed}→${t.realCompleted}`.padEnd(19),
      fmt(t.calculatedAt).padEnd(19),
      t.reason
    );
  }

  if (!APPLY) {
    console.log(`\nNada foi gravado. Para aplicar: node ${process.argv[1].split(/[\\/]/).pop()} --apply\n`);
    await mongoose.disconnect();
    return;
  }

  console.log('\n🔧 Reconstruindo…\n');
  let ok = 0;
  const failures = [];

  for (const t of targets) {
    try {
      await buildPackageView(t.packageId, {
        correlationId: `rebuild_drift_${Date.now()}`,
        force: true,
      });
      const after = await PackagesView.findOne({ packageId: t.packageId }).lean();
      console.log(
        `✅ ${t.packageId.slice(-8)}  canceladas ${t.viewCanceled}→${after?.sessionsCanceled ?? '?'}` +
        `  usadas ${t.viewUsed}→${after?.sessionsUsed ?? '?'}` +
        `  restantes ${after?.sessionsRemaining ?? '?'}`
      );
      ok++;
    } catch (err) {
      console.error(`❌ ${t.packageId.slice(-8)}: ${err.message}`);
      failures.push({ packageId: t.packageId, error: err.message });
    }
  }

  console.log(`\nResumo: ${ok} reconstruída(s), ${failures.length} falha(s).`);
  if (failures.length) console.log(JSON.stringify(failures, null, 2));

  await mongoose.disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
