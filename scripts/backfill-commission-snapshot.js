#!/usr/bin/env node
/**
 * 🔁 BACKFILL COMMISSION SNAPSHOT
 *
 * Preenche Session.commissionSnapshot para sessões completed antigas
 * que ainda não possuem snapshot.
 *
 * Uso:
 *   node scripts/backfill-commission-snapshot.js
 *   node scripts/backfill-commission-snapshot.js --dry-run
 *   node scripts/backfill-commission-snapshot.js --batch=100 --start=2025-01-01 --end=2026-06-30
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import '../models/index.js';
import Session from '../models/Session.js';
import Doctor from '../models/Doctor.js';
import { createCommissionSnapshot } from '../services/commissionRule.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { dryRun: false, batchSize: 100, startDate: null, endDate: null };
  for (const arg of args) {
    if (arg === '--dry-run') result.dryRun = true;
    if (arg.startsWith('--batch=')) result.batchSize = parseInt(arg.split('=')[1], 10);
    if (arg.startsWith('--start=')) result.startDate = new Date(arg.split('=')[1] + 'T00:00:00-03:00');
    if (arg.startsWith('--end=')) result.endDate = new Date(arg.split('=')[1] + 'T23:59:59-03:00');
  }
  return result;
}

async function connect() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('❌ MONGODB_URI ou MONGO_URI não encontrado no .env');
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log('✅ MongoDB conectado\n');
}

async function disconnect() {
  await mongoose.disconnect();
  console.log('\n👋 MongoDB desconectado');
}

async function main() {
  const { dryRun, batchSize, startDate, endDate } = parseArgs();

  await connect();

  try {
    const match = {
      status: 'completed',
      $or: [
        { commissionSnapshot: { $exists: false } },
        { commissionSnapshot: null }
      ]
    };
    if (startDate) match.date = { ...match.date, $gte: startDate };
    if (endDate) match.date = { ...match.date, $lte: endDate };

    const totalToProcess = await Session.countDocuments(match);
    console.log(`🔍 Sessões sem commissionSnapshot: ${totalToProcess}`);
    console.log(`📦 Batch size: ${batchSize}`);
    console.log(`🧪 Modo: ${dryRun ? 'DRY-RUN (não grava)' : 'GRAVAÇÃO REAL'}\n`);

    if (totalToProcess === 0) {
      console.log('✅ Nada a fazer. Todas as sessões já possuem snapshot.');
      return;
    }

    let processed = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;

    while (processed < totalToProcess) {
      const sessions = await Session.find(match)
        .limit(batchSize)
        .populate('package', 'sessionType totalSessions insuranceProvider')
        .populate('insuranceGuide', 'insurance')
        .lean();

      if (sessions.length === 0) break;

      const doctorIds = [...new Set(sessions.map(s => s.doctor?.toString?.()).filter(Boolean))];
      const doctors = doctorIds.length
        ? await Doctor.find({ _id: { $in: doctorIds } }).select('specialty commissionRules commissionRuleVersion').lean()
        : [];
      const doctorById = Object.fromEntries(doctors.map(d => [d._id.toString(), d]));

      const bulkOps = [];

      for (const session of sessions) {
        try {
          const doctorId = session.doctor?.toString?.();
          const doctor = doctorById[doctorId];

          let snapshot;
          let originalRuleVersion = 1;

          if (!doctor) {
            console.warn(`⚠️ Profissional não encontrado para sessão ${session._id}`);
            snapshot = {
              ruleId: null,
              version: 1,
              commissionType: 'fixed',
              value: 0,
              calculatedCommission: 0,
              calculatedAt: new Date().toISOString(),
              missingDoctor: true,
              notes: 'Profissional não encontrado durante backfill'
            };
          } else {
            snapshot = createCommissionSnapshot(doctor, session, session.date);
            originalRuleVersion = doctor.commissionRuleVersion || 1;
          }

          const migratedSnapshot = {
            ...snapshot,
            migrated: true,
            migratedAt: new Date().toISOString(),
            originalRuleVersion
          };

          if (!dryRun) {
            bulkOps.push({
              updateOne: {
                filter: { _id: session._id },
                update: { $set: { commissionSnapshot: migratedSnapshot } }
              }
            });
          }

          updated += 1;
        } catch (err) {
          console.error(`❌ Erro ao processar sessão ${session._id}:`, err.message);
          errors += 1;
        }
      }

      if (!dryRun && bulkOps.length > 0) {
        await Session.bulkWrite(bulkOps);
      }

      processed += sessions.length;
      console.log(`⏳ Processado ${processed}/${totalToProcess} | atualizado: ${updated} | skipped: ${skipped} | erros: ${errors}`);
    }

    console.log('\n✅ Backfill finalizado');
    console.log(`   Total processado: ${processed}`);
    console.log(`   Atualizadas: ${updated}`);
    console.log(`   Skipped: ${skipped}`);
    console.log(`   Erros: ${errors}`);
  } catch (error) {
    console.error('❌ Erro no backfill:', error);
    process.exitCode = 1;
  }
}

main()
  .then(disconnect)
  .catch(err => {
    console.error(err);
    disconnect().then(() => process.exit(1));
  });
