// crons/packageViewDriftCheck.cron.js
/**
 * Detector de deriva entre PackagesView e o domínio.
 *
 * Origem (incidente 2026-08-12): o payload de APPOINTMENT_CANCELLED não levava
 * `packageId`, o packageProjectionWorker descartava o evento em
 * `ignored / no_package_id`, e a view congelava. Nada falhava: o evento ficava
 * 'published', sem retry, sem DLQ, sem log de erro. O problema só apareceu
 * quando alguém estranhou um card na tela — meses depois, em alguns casos.
 *
 * Este cron fecha esse ponto cego. Ele NÃO conserta nada: só compara e alerta.
 * Reconstruir automaticamente esconderia a causa raiz de novo — que é
 * exatamente o que deixou o bug vivo por tanto tempo.
 *
 * Para corrigir o passivo detectado:
 *   node scripts/maintenance/rebuild-drifted-package-views.js --apply
 */

import PackagesView from '../models/PackagesView.js';
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import { createContextLogger } from '../utils/logger.js';

const log = createContextLogger(null, 'package_view_drift');
let isRunning = false;
let intervalId = null;

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h — deriva não é urgência de minuto
const WARMUP_DELAY_MS = 10 * 60 * 1000;
const MAX_PACKAGES_PER_RUN = 500;
const REPORT_SAMPLE_SIZE = 10;

/**
 * Espelha calculateSessionMetrics() do PackageProjectionService.
 * Se aquela regra mudar, esta precisa mudar junto — comparar por outra
 * fórmula produz alarme falso, que é pior que alarme nenhum.
 */
async function realMetrics(packageId) {
  const [apptCanceled, apptCompleted, sessCanceled, sessCompleted] = await Promise.all([
    Appointment.countDocuments({ package: packageId, operationalStatus: 'canceled' }),
    Appointment.countDocuments({ package: packageId, operationalStatus: 'completed' }),
    Session.countDocuments({ package: packageId, status: 'canceled' }),
    Session.countDocuments({ package: packageId, status: 'completed' }),
  ]);

  return {
    canceled: Math.max(apptCanceled, sessCanceled),
    used: Math.max(apptCompleted, sessCompleted),
  };
}

export async function checkDrift() {
  const views = await PackagesView.find({ status: { $ne: 'canceled' } })
    .select('packageId sessionsCanceled sessionsUsed snapshot.calculatedAt searchFields.patientName')
    .limit(MAX_PACKAGES_PER_RUN)
    .lean();

  const drifted = [];

  for (const view of views) {
    if (!view.packageId) continue;

    const real = await realMetrics(view.packageId);
    const viewCanceled = view.sessionsCanceled || 0;
    const viewUsed = view.sessionsUsed || 0;

    if (viewCanceled !== real.canceled || viewUsed !== real.used) {
      drifted.push({
        packageId: view.packageId.toString(),
        patient: view.searchFields?.patientName || null,
        canceled: { view: viewCanceled, real: real.canceled },
        used: { view: viewUsed, real: real.used },
        calculatedAt: view.snapshot?.calculatedAt || null,
      });
    }
  }

  return { checked: views.length, drifted };
}

async function runOnce() {
  if (isRunning) {
    console.log('[PackageViewDrift] ⏭️ Já está rodando, pulando...');
    return;
  }

  isRunning = true;
  const startedAt = Date.now();
  console.log(`[PackageViewDrift] 🔁 [${new Date().toISOString()}] Comparando projeções com o domínio...`);

  try {
    const { checked, drifted } = await checkDrift();
    const duration = Date.now() - startedAt;

    if (drifted.length === 0) {
      console.log(`[PackageViewDrift] ✅ ${checked} projeções consistentes em ${duration}ms`);
      return;
    }

    console.warn(`[PackageViewDrift] ⚠️ ${drifted.length}/${checked} projeção(ões) divergente(s) em ${duration}ms`);
    log.warn('drift_detected', `${drifted.length} PackagesView divergentes do domínio`, {
      checked,
      driftedCount: drifted.length,
      sample: drifted.slice(0, REPORT_SAMPLE_SIZE),
      remediation: 'node scripts/maintenance/rebuild-drifted-package-views.js --apply',
    });

    for (const d of drifted.slice(0, REPORT_SAMPLE_SIZE)) {
      console.warn(
        `[PackageViewDrift]   ${d.packageId.slice(-8)} ${d.patient || '—'}: ` +
        `canceladas ${d.canceled.view}→${d.canceled.real}, usadas ${d.used.view}→${d.used.real}`
      );
    }
    if (drifted.length > REPORT_SAMPLE_SIZE) {
      console.warn(`[PackageViewDrift]   … e mais ${drifted.length - REPORT_SAMPLE_SIZE}`);
    }
  } catch (error) {
    console.error('[PackageViewDrift] ❌ Erro:', error.message);
    log.error('drift_check_error', 'Falha na verificação de deriva', { error: error.message });
  } finally {
    isRunning = false;
  }
}

export function initPackageViewDriftCron() {
  if (intervalId) {
    console.log('[PackageViewDrift] ⚠️ Já inicializado, ignorando');
    return { stop: () => clearInterval(intervalId) };
  }

  console.log('🔄 Inicializando Package View Drift Check...');

  intervalId = setInterval(runOnce, CHECK_INTERVAL_MS);

  setTimeout(() => {
    console.log('[PackageViewDrift] 🚀 Primeira execução (warmup)...');
    runOnce().catch(e => console.error('[PackageViewDrift] Erro no warmup:', e.message));
  }, WARMUP_DELAY_MS);

  console.log('✅ Package View Drift Check inicializado (a cada 6h)');

  return {
    stop: () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    }
  };
}

export default { initPackageViewDriftCron, checkDrift };
