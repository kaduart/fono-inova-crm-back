/**
 * ⏱️ benchmark-financial-v2.js
 *
 * Mede a latência end-to-end de calculateCash e calculateProduction
 * usando UnifiedFinancialService.v2.js com autoIndex desligado,
 * simulando o comportamento do servidor em produção.
 *
 * Uso:
 *   node scripts/benchmark-financial-v2.js --start=2026-03-01 --end=2026-03-31 --runs=5
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import '../models/index.js';
import UnifiedFinancialService from '../services/unifiedFinancialService.v2.js';

dotenv.config();

function parseArgs() {
  const now = new Date();
  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

  const args = process.argv.slice(2);
  const result = { start: firstDay, end: lastDay, runs: 5 };

  for (const arg of args) {
    if (arg.startsWith('--start=')) {
      result.start = new Date(arg.split('=')[1] + 'T03:00:00-03:00');
    }
    if (arg.startsWith('--end=')) {
      result.end = new Date(arg.split('=')[1] + 'T23:59:59-03:00');
    }
    if (arg.startsWith('--runs=')) {
      result.runs = parseInt(arg.split('=')[1], 10);
    }
  }

  return result;
}

async function benchmark() {
  const { start, end, runs } = parseArgs();

  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI, {
    readPreference: 'primary',
    retryWrites: true,
    w: 'majority',
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
    autoIndex: false, // simula produção
  });

  console.log('✅ MongoDB conectado (autoIndex=false)\n');
  console.log(`Período: ${start.toISOString()} → ${end.toISOString()}`);
  console.log(`Execuções: ${runs}\n`);

  // Aquecimento
  await UnifiedFinancialService.calculateCash(start, end);
  await UnifiedFinancialService.calculateProduction(start, end);

  const cashTimes = [];
  const productionTimes = [];

  for (let i = 0; i < runs; i++) {
    const t0 = Date.now();
    await UnifiedFinancialService.calculateCash(start, end);
    cashTimes.push(Date.now() - t0);

    const t1 = Date.now();
    await UnifiedFinancialService.calculateProduction(start, end);
    productionTimes.push(Date.now() - t1);
  }

  function summarize(times) {
    times.sort((a, b) => a - b);
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const p50 = times[Math.floor(times.length * 0.5)];
    const p95 = times[Math.ceil(times.length * 0.95) - 1];
    return { avg: Math.round(avg), min: times[0], max: times[times.length - 1], p50, p95 };
  }

  console.log('💰 calculateCash (ms):', summarize(cashTimes));
  console.log('🏭 calculateProduction (ms):', summarize(productionTimes));

  await mongoose.disconnect();
}

benchmark().catch(err => {
  console.error('❌ Falha no benchmark:', err.message);
  process.exit(1);
});
