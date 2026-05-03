// scripts/migrate-liminar-packages.js
// Migra packages legados type='liminar' para LiminarContract + TherapeuticPlan
//
// Idempotente: usa idempotencyKey = 'migrate_package_<packageId>'
// Rollback: salva log com IDs criados

import mongoose from 'mongoose';
import Package from '../models/Package.js';
import LiminarContract from '../models/LiminarContract.js';
import TherapeuticPlan from '../models/TherapeuticPlan.js';

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/fono_inova_prod?retryWrites=true&w=majority&appName=Cluster0';

async function migrate() {
  await mongoose.connect(MONGO_URI);
  console.log('[MIGRATE] Conectado ao MongoDB');

  const results = {
    scanned: 0,
    migrated: 0,
    skipped: 0,
    errors: 0,
    details: []
  };

  const packages = await Package.find({ type: 'liminar', status: 'active' }).lean();
  results.scanned = packages.length;
  console.log(`[MIGRATE] ${packages.length} packages legados encontrados`);

  for (const pkg of packages) {
    const packageId = pkg._id.toString();
    const idempotencyKey = `migrate_package_${packageId}`;

    try {
      // IDEMPOTÊNCIA: já migrado?
      const existing = await LiminarContract.findOne({ idempotencyKey }).lean();
      if (existing) {
        console.log(`[MIGRATE][SKIP] Package ${packageId} já migrado → Contract ${existing._id}`);
        results.skipped++;
        results.details.push({ packageId, action: 'skipped', contractId: existing._id });
        continue;
      }

      // ── 1. Criar LiminarContract ──
      const totalCredit = pkg.liminarTotalCredit || pkg.totalValue || 0;
      const creditBalance = pkg.liminarCreditBalance || 0;
      const usedCredit = totalCredit - creditBalance;

      const creditHistory = [];
      if (totalCredit > 0) {
        creditHistory.push({
          amount: totalCredit,
          type: 'initial',
          reason: 'contract_created',
          createdAt: pkg.date || new Date(),
          createdBy: null
        });
      }
      if (usedCredit > 0.001) {
        creditHistory.push({
          amount: usedCredit,
          type: 'debit',
          reason: 'session_completed',
          createdAt: new Date(),
          createdBy: null
        });
      }

      const contract = await LiminarContract.create({
        patient: pkg.patient,
        doctor: pkg.doctor,
        totalCredit,
        creditBalance,
        usedCredit,
        status: 'active',
        mode: pkg.liminarMode || 'hybrid',
        processNumber: pkg.liminarProcessNumber || null,
        court: pkg.liminarCourt || null,
        expirationDate: pkg.liminarExpirationDate || null,
        authorized: pkg.liminarAuthorized ?? true,
        creditHistory,
        plans: [],
        idempotencyKey
      });

      // ── 2. Criar TherapeuticPlan base ──
      const specialty = pkg.specialty || 'fonoaudiologia';
      const sessionValue = pkg.sessionValue || 0;

      const plan = await TherapeuticPlan.create({
        patient: pkg.patient,
        liminarContract: contract._id,
        version: 1,
        startDate: pkg.date || new Date(),
        endDate: null,
        status: 'active',
        therapies: new Map([
          [specialty, {
            slots: [],
            sessionValue,
            sessionDurationMinutes: 40
          }]
        ]),
        notes: `Migrado automaticamente do Package ${packageId} (${pkg.totalSessions} sessões, ${pkg.sessionsDone} realizadas)`,
        createdBy: null
      });

      // Vincular plano ao contrato
      await LiminarContract.findByIdAndUpdate(contract._id, {
        $push: { plans: plan._id }
      });

      // ── 3. Arquivar package legado ──
      await Package.findByIdAndUpdate(pkg._id, {
        $set: {
          status: 'superseded',
          updatedAt: new Date()
        }
      });

      console.log(`[MIGRATE][OK] Package ${packageId} → Contract ${contract._id} | Plan ${plan._id} | Saldo R$ ${creditBalance}`);
      results.migrated++;
      results.details.push({
        packageId,
        action: 'migrated',
        contractId: contract._id.toString(),
        planId: plan._id.toString(),
        patientId: pkg.patient.toString(),
        specialty,
        totalCredit,
        creditBalance,
        usedCredit
      });

    } catch (err) {
      console.error(`[MIGRATE][ERR] Package ${packageId}:`, err.message);
      results.errors++;
      results.details.push({ packageId, action: 'error', error: err.message });
    }
  }

  console.log('\n=== RESULTADO ===');
  console.log(JSON.stringify(results, null, 2));

  await mongoose.disconnect();
  console.log('[MIGRATE] Desconectado');
}

migrate().catch(err => {
  console.error('[MIGRATE] Falha geral:', err);
  process.exit(1);
});
