#!/usr/bin/env node
/**
 * 🔍 EXPLAIN FINANCIAL AGGREGATES
 *
 * Roda explain('executionStats') nos pipelines pesados de
 * unifiedFinancialService.v2.js para identificar gargalos de índice.
 *
 * Uso:
 *   node scripts/explain-financial-aggregates.js --start=2026-03-01 --end=2026-03-31
 */

import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

function parseArgs() {
  const now = new Date();
  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

  const args = process.argv.slice(2);
  const result = { startDate: firstDay, endDate: lastDay };

  for (const arg of args) {
    if (arg.startsWith('--start=')) {
      result.startDate = new Date(arg.split('=')[1] + 'T00:00:00-03:00');
    }
    if (arg.startsWith('--end=')) {
      result.endDate = new Date(arg.split('=')[1] + 'T23:59:59-03:00');
    }
  }

  return result;
}

function cleanUri(uri) {
  // Remove writeConcern/retryWrites que impedem explain em aggregate
  const url = new URL(uri);
  url.searchParams.delete('w');
  url.searchParams.delete('retryWrites');
  return url.toString();
}

async function connect() {
  const rawUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!rawUri) {
    console.error('❌ MONGODB_URI ou MONGO_URI não encontrado');
    process.exit(1);
  }
  const client = new MongoClient(cleanUri(rawUri));
  await client.connect();
  console.log('✅ MongoDB conectado\n');
  return client;
}

function findScanStage(plan) {
  if (!plan) return null;
  if (plan.stage === 'IXSCAN' || plan.stage === 'COLLSCAN') {
    return plan;
  }
  // FETCH coberto por índice: o índice real está no inputStage
  if (plan.stage === 'FETCH' && plan.inputStage) {
    return findScanStage(plan.inputStage);
  }
  // explainVersion 2: plano aninhado em queryPlan
  if (plan.queryPlan) return findScanStage(plan.queryPlan);
  if (plan.inputStage) return findScanStage(plan.inputStage);
  if (plan.inputStages && plan.inputStages.length) return findScanStage(plan.inputStages[0]);
  return null;
}

function getCursorStage(result) {
  if (result.stages && result.stages[0] && result.stages[0].$cursor) {
    return result.stages[0].$cursor;
  }
  return null;
}

function summarizeExplain(result) {
  // explainVersion 1 (com $lookup): stats ficam dentro de stages[0].$cursor.executionStats
  const cursorStage = getCursorStage(result);
  const stats = result.executionStats || cursorStage?.executionStats || {};

  // Plano pode vir do nível do cursor ou do nível do topo (find / aggregate simples)
  const plan = cursorStage?.queryPlanner?.winningPlan || result.queryPlanner?.winningPlan;
  const scanStage = findScanStage(plan);

  return {
    executionTimeMillis: stats.executionTimeMillis,
    totalDocsExamined: stats.totalDocsExamined,
    totalKeysExamined: stats.totalKeysExamined,
    nReturned: stats.nReturned,
    stage: scanStage?.stage || plan?.stage || 'UNKNOWN',
    indexName: scanStage?.indexName || null,
    indexBounds: scanStage?.indexBounds || null
  };
}

async function explainCash(db, start, end) {
  console.log('══════════════════════════════════════════════════════════');
  console.log('💰 EXPLAIN: calculateCash');
  console.log(`   Período: ${start.toISOString()} → ${end.toISOString()}`);
  console.log('══════════════════════════════════════════════════════════\n');

  const match = {
    status: 'paid',
    amount: { $gt: 0 },
    kind: { $ne: 'package_consumed' },
    $and: [
      { $or: [{ isFromPackage: { $ne: true } }, { kind: 'session_payment' }] },
      {
        $or: [
          { financialDate: { $gte: start, $lte: end } },
          { financialDate: { $exists: false }, paymentDate: { $gte: start, $lte: end } },
          { financialDate: null, paymentDate: { $gte: start, $lte: end } },
          { financialDate: { $exists: false }, paymentDate: { $exists: false }, createdAt: { $gte: start, $lte: end } },
          { financialDate: null, paymentDate: null, createdAt: { $gte: start, $lte: end } }
        ]
      }
    ]
  };

  const totalPipeline = [{ $match: match }, { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }];
  const totalResult = await db.collection('payments').aggregate(totalPipeline).explain('executionStats');
  console.log('📌 Total geral');
  console.log(JSON.stringify(summarizeExplain(totalResult), null, 2));
  console.log('');

  console.log('📌 Payment.find() com match');
  const findResult = await db.collection('payments').find(match).explain('executionStats');
  console.log(JSON.stringify(summarizeExplain(findResult), null, 2));
  console.log('');
}

async function explainProduction(db, start, end) {
  console.log('══════════════════════════════════════════════════════════');
  console.log('🏭 EXPLAIN: calculateProduction');
  console.log(`   Período: ${start.toISOString()} → ${end.toISOString()}`);
  console.log('══════════════════════════════════════════════════════════\n');

  const match = { date: { $gte: start, $lte: end }, status: 'completed' };

  const pkgLookup = { $lookup: { from: 'packages', localField: 'package', foreignField: '_id', pipeline: [{ $project: { sessionValue: 1, totalValue: 1, totalSessions: 1 } }], as: '_pkg' } };
  const pkgUnwind = { $unwind: { path: '$_pkg', preserveNullAndEmptyArrays: true } };

  const totalPipeline = [ { $match: match }, pkgLookup, pkgUnwind, { $group: { _id: null, total: { $sum: '$sessionValue' }, count: { $sum: 1 } } } ];
  const totalResult = await db.collection('sessions').aggregate(totalPipeline).explain('executionStats');
  console.log('📌 Total geral');
  console.log(JSON.stringify(summarizeExplain(totalResult), null, 2));
  console.log('');

  const typePipeline = [
    { $match: match }, pkgLookup, pkgUnwind,
    { $group: { _id: '$paymentMethod', total: { $sum: '$sessionValue' }, count: { $sum: 1 } } }
  ];
  const typeResult = await db.collection('sessions').aggregate(typePipeline).explain('executionStats');
  console.log('📌 Por paymentMethod (proxy do tipo)');
  console.log(JSON.stringify(summarizeExplain(typeResult), null, 2));
  console.log('');

  const recebidoPipeline = [
    { $match: { date: { $gte: start, $lte: end }, status: 'completed', $or: [{ isPaid: true }, { paymentStatus: { $in: ['paid', 'package_paid'] } }, { paymentOrigin: 'package_prepaid' }, { paymentMethod: 'convenio' }, { paymentOrigin: 'convenio' }] } },
    pkgLookup, pkgUnwind,
    { $group: { _id: null, total: { $sum: '$sessionValue' } } }
  ];
  const recebidoResult = await db.collection('sessions').aggregate(recebidoPipeline).explain('executionStats');
  console.log('📌 Recebido vs Pendente');
  console.log(JSON.stringify(summarizeExplain(recebidoResult), null, 2));
  console.log('');

  const particularPendentePipeline = [
    { $match: { date: { $gte: start, $lte: end }, status: 'completed' } },
    { $lookup: { from: 'appointments', localField: 'appointmentId', foreignField: '_id', as: 'appt' } },
    { $unwind: '$appt' },
    { $match: { 'appt.billingType': { $nin: ['convenio', 'liminar'] }, 'appt.operationalStatus': 'completed' } },
    { $lookup: { from: 'packages', localField: 'appt.package', foreignField: '_id', as: 'pkg' } },
    { $match: { $or: [{ 'appt.package': { $exists: false } }, { 'appt.package': null }, { 'pkg.paymentType': { $in: ['per_session', 'session'] }, 'pkg.model': 'per_session' }, { pkg: { $size: 0 } }] } },
    { $lookup: { from: 'payments', localField: 'appt.payment', foreignField: '_id', as: 'payment' } },
    { $match: { $or: [{ payment: { $size: 0 } }, { 'payment.status': { $ne: 'paid' } }] } },
    { $group: { _id: null, total: { $sum: '$sessionValue' }, count: { $sum: 1 } } }
  ];
  const particularResult = await db.collection('sessions').aggregate(particularPendentePipeline).explain('executionStats');
  console.log('📌 Particular Pendente (pipeline pesado)');
  console.log(JSON.stringify(summarizeExplain(particularResult), null, 2));
  console.log('');
}

async function main() {
  const { startDate, endDate } = parseArgs();
  const client = await connect();
  const db = client.db();
  await explainCash(db, startDate, endDate);
  await explainProduction(db, startDate, endDate);
  await client.close();
  console.log('👋 MongoDB desconectado');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
