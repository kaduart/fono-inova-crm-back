#!/usr/bin/env node
/**
 * Diagnóstico da listagem "A Faturar" após ajuste do LEGACY_PENDING_CUTOFF.
 *
 * Objetivo: provar o contrato de que sessões de março/2026 em diante com guia
 * válida aparecem na listagem padrão, e medir quantas ainda são escondidas
 * pelo cutoff ou por outro filtro.
 *
 * O script NÃO modifica dados — apenas lê.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const CUTOFF = new Date('2026-03-01T00:00:00');

async function main() {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI ou MONGO_URI não configurado');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log('Conectado ao MongoDB');

  const Session = (await import('../models/Session.js')).default;
  const Payment = (await import('../models/Payment.js')).default;
  const InsuranceGuide = (await import('../models/InsuranceGuide.js')).default;

  // Período de interesse: jan/2026 a ago/2026 (para ver o que está antes/depois do corte)
  const start = new Date('2026-01-01T00:00:00-03:00');
  const end = new Date('2026-08-31T23:59:59-03:00');

  // Sessões de convênio completadas, com guia, sem lote, dentro do período
  const baseMatch = {
    status: 'completed',
    date: { $gte: start, $lte: end },
    insuranceGuide: { $exists: true, $ne: null },
    $or: [
      { billingBatchId: { $exists: false } },
      { billingBatchId: null }
    ]
  };

  const guideSessions = await Session.find(baseMatch)
    .populate('insuranceGuide', 'insurance specialty sessionValue totalSessions usedSessions issuedAt createdAt')
    .populate('patient', 'fullName')
    .lean();

  console.log(`\nTotal de sessões com guia (completed, sem lote, jan-ago/2026): ${guideSessions.length}`);

  // Agrupar por mês de competência (session.date)
  const byMonth = new Map();
  for (const s of guideSessions) {
    const d = new Date(s.date);
    const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!byMonth.has(mk)) byMonth.set(mk, []);
    byMonth.get(mk).push(s);
  }

  console.log('\n--- Sessões por mês de competência (Session.date) ---');
  for (const [mk, sessions] of [...byMonth.entries()].sort()) {
    const beforeCutoff = sessions.filter(s => new Date(s.date) < CUTOFF).length;
    const afterCutoff = sessions.filter(s => new Date(s.date) >= CUTOFF).length;

    const byProvider = {};
    for (const s of sessions) {
      const prov = s.insuranceGuide?.insurance || 'sem-guia';
      byProvider[prov] = (byProvider[prov] || 0) + 1;
    }

    const withoutSessionValue = sessions.filter(s => !s.insuranceGuide?.sessionValue).length;

    console.log(`${mk}: ${sessions.length} sessões`);
    console.log(`  antes do cutoff (${CUTOFF.toISOString().slice(0,10)}): ${beforeCutoff}`);
    console.log(`  a partir do cutoff: ${afterCutoff}`);
    console.log(`  sem sessionValue na guia: ${withoutSessionValue}`);
    console.log(`  por convênio: ${JSON.stringify(byProvider)}`);
  }

  // Detalhe específico: sessões antes de 01/05 que seriam escondidas se cutoff fosse maio
  console.log('\n--- Impacto do novo cutoff (março vs maio) ---');
  const marAbrMai = guideSessions.filter(s => {
    const d = new Date(s.date);
    return d >= new Date('2026-03-01T00:00:00') && d < new Date('2026-06-01T00:00:00');
  });

  console.log(`Sessões mar/abr/mai/2026 com guia: ${marAbrMai.length}`);

  const byProviderDetail = {};
  for (const s of marAbrMai) {
    const prov = s.insuranceGuide?.insurance || 'sem-guia';
    if (!byProviderDetail[prov]) byProviderDetail[prov] = { count: 0, withoutValue: 0 };
    byProviderDetail[prov].count += 1;
    if (!s.insuranceGuide?.sessionValue) byProviderDetail[prov].withoutValue += 1;
  }

  for (const [prov, data] of Object.entries(byProviderDetail)) {
    console.log(`  ${prov}: ${data.count} sessões (${data.withoutValue} sem sessionValue na guia)`);
  }

  // Verificar se sessões já foram faturadas/recebidas (seriam excluídas pelo adapter)
  const sessionIds = guideSessions.map(s => s._id);
  const handledPayments = await Payment.find({
    session: { $in: sessionIds },
    $or: [
      { 'insurance.status': { $in: ['billed', 'received', 'partial'] } },
      { status: { $in: ['billed', 'received', 'partial'] } }
    ]
  }).select('session insurance.status status').lean();

  const handledIds = new Set(handledPayments.map(p => String(p.session)));

  console.log(`\nSessões com Payment já billed/received/partial (excluídas do "A Faturar"): ${handledIds.size}`);

  // Resumo final: quantas aparecem na listagem padrão com cutoff em março
  const visibleWithMarchCutoff = guideSessions.filter(s => {
    const d = new Date(s.date);
    return d >= CUTOFF && !handledIds.has(String(s._id));
  });

  const hiddenByCutoff = guideSessions.filter(s => {
    const d = new Date(s.date);
    return d < CUTOFF && !handledIds.has(String(s._id));
  });

  console.log('\n--- Resumo contrato A Faturar (cutoff março/2026) ---');
  console.log(`Incluídas na listagem padrão: ${visibleWithMarchCutoff.length}`);
  console.log(`Escondidas pelo cutoff: ${hiddenByCutoff.length}`);
  console.log(`Já faturadas/recebidas: ${handledIds.size}`);

  await mongoose.disconnect();
  console.log('\nDesconectado.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
