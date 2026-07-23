#!/usr/bin/env node
/**
 * Auditoria READ-ONLY do card "Dívidas de Meses Anteriores" (Dashboard > Metas).
 *
 * Reproduz de forma independente a query oficial de `previousCompetenceDebt`
 * (back/routes/financialDashboard.v2.js, calculatePendentes) e também o cálculo
 * legado por resíduo (allParticularTotal - mesMesAtual), que foi descontinuado em
 * 2026-07-23 por inflar a dívida com payments de agendamentos futuros/não realizados
 * (achado: R$6.010 residual vs R$1.070 real, diferença 100% explicada por 19 payments
 * com appointment.operationalStatus != 'completed').
 *
 * Rodar periodicamente para confirmar que dashboard e query oficial não divergem.
 * Não escreve nada no banco. Uso:
 *   node scripts/audits/audit-dashboard-metas-pendentes.js 2026 7
 */

import mongoose from 'mongoose';
import moment from 'moment-timezone';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '../../.env') });
dotenv.config();

import Payment from '../../models/Payment.js';
import Session from '../../models/Session.js';

const TIMEZONE = 'America/Sao_Paulo';
const year = parseInt(process.argv[2]) || 2026;
const month = parseInt(process.argv[3]) || 7;

async function main() {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI/MONGO_URI não encontrado no .env');
    process.exit(1);
  }
  await mongoose.connect(mongoUri);
  console.log(`Conectado. Analisando competência ${year}-${String(month).padStart(2, '0')}\n`);

  const startStr = moment.tz([year, month - 1], TIMEZONE).startOf('month').format('YYYY-MM-DD');
  const endStr = moment.tz([year, month - 1], TIMEZONE).endOf('month').format('YYYY-MM-DD');
  const start = moment.tz([year, month - 1], TIMEZONE).startOf('month').toDate();
  const end = moment.tz([year, month - 1], TIMEZONE).endOf('month').toDate();

  // Réplica exata de financialDashboard.v2.js:2076-2244 (allParticularTotal)
  const paymentsAll = await Payment.find({ status: 'pending' })
    .populate('patient', 'fullName')
    .populate('appointment', 'date time operationalStatus')
    .lean();

  const particularPayments = paymentsAll.filter(
    p => p.billingType !== 'convenio' && p.paymentMethod !== 'convenio'
  );
  const allParticularTotal = particularPayments.reduce((s, p) => s + (p.amount || 0), 0);

  // Réplica de unifiedFinancialService.v2.js:568-597 (particularPendente / mesMesAtual)
  const particularPendenteAgg = await Session.aggregate([
    { $match: { date: { $gte: start, $lte: end }, status: 'completed' } },
    { $lookup: { from: 'appointments', localField: 'appointmentId', foreignField: '_id', as: 'appt' } },
    { $unwind: '$appt' },
    { $match: { 'appt.billingType': { $nin: ['convenio', 'liminar'] }, 'appt.operationalStatus': 'completed' } },
    { $match: { paymentMethod: { $nin: ['convenio', 'liminar_credit'] }, paymentOrigin: { $nin: ['convenio', 'liminar', 'liminar_credit'] } } },
    { $lookup: { from: 'packages', localField: 'appt.package', foreignField: '_id', as: 'pkg' } },
    { $match: { $or: [
      { 'appt.package': { $exists: false } }, { 'appt.package': null },
      { 'pkg.paymentType': { $in: ['per_session', 'session'] } }, { 'pkg.model': 'per_session' },
      { pkg: { $size: 0 } }
    ]}},
    { $lookup: { from: 'payments', localField: 'appt.payment', foreignField: '_id', as: 'payment' } },
    { $match: { $or: [{ payment: { $size: 0 } }, { 'payment.status': { $ne: 'paid' } }] } },
    { $group: { _id: null, total: { $sum: '$sessionValue' }, count: { $sum: 1 } } }
  ]);
  const mesMesAtual = particularPendenteAgg[0]?.total || 0;

  const residual = Math.max(0, allParticularTotal - mesMesAtual);

  console.log('== Reprodução do cálculo ATUAL do dashboard ==');
  console.log(`allParticularTotal (Payment.pending, todas as datas): R$ ${allParticularTotal.toFixed(2)}  (${particularPayments.length} payments)`);
  console.log(`mesMesAtual (Session completed em ${startStr}..${endStr}):  R$ ${mesMesAtual.toFixed(2)}`);
  console.log(`"Meses anteriores" residual (atual = allParticularTotal - mesMesAtual): R$ ${residual.toFixed(2)}\n`);

  // PERGUNTA 1: quantos desses "particularPayments" são de agendamento NÃO completado (futuro/agendado)?
  let naoCompletedCount = 0, naoCompletedTotal = 0;
  let semAppointmentCount = 0, semAppointmentTotal = 0;
  for (const p of particularPayments) {
    if (!p.appointment) {
      semAppointmentCount++;
      semAppointmentTotal += p.amount || 0;
      continue;
    }
    if (p.appointment.operationalStatus !== 'completed') {
      naoCompletedCount++;
      naoCompletedTotal += p.amount || 0;
    }
  }
  console.log('== PERGUNTA 1: existem payments pending que NÃO são de sessão realizada? ==');
  console.log(`Sem appointment vinculado: ${semAppointmentCount} payments, R$ ${semAppointmentTotal.toFixed(2)}`);
  console.log(`Com appointment mas operationalStatus != completed (futuro/agendado/cancelado): ${naoCompletedCount} payments, R$ ${naoCompletedTotal.toFixed(2)}\n`);

  // PERGUNTA 2: query direta e correta — pending, não-convênio, sessão REALMENTE completed, com data < início do mês selecionado
  let realDebtTotal = 0, realDebtCount = 0;
  const realDebtItems = [];
  for (const p of particularPayments) {
    if (!p.appointment || p.appointment.operationalStatus !== 'completed') continue;
    const dataRef = p.appointment?.date ? moment(p.appointment.date).format('YYYY-MM-DD')
      : p.paymentDate ? moment(p.paymentDate).format('YYYY-MM-DD')
      : p.serviceDate ? moment(p.serviceDate).format('YYYY-MM-DD') : null;
    if (dataRef && dataRef < startStr) {
      realDebtTotal += p.amount || 0;
      realDebtCount++;
      realDebtItems.push({ id: p._id.toString(), patient: p.patient?.fullName, amount: p.amount, dataRef });
    }
  }
  console.log('== PERGUNTA 2: query direta (pending + sessão completed + competência < mês atual) ==');
  console.log(`Dívida real de competências anteriores: R$ ${realDebtTotal.toFixed(2)}  (${realDebtCount} payments)`);
  console.log(`Diferença vs residual atual (R$ ${residual.toFixed(2)}): R$ ${(residual - realDebtTotal).toFixed(2)}\n`);

  if (realDebtItems.length) {
    console.log('Amostra (até 10):');
    realDebtItems.slice(0, 10).forEach(i => console.log(`  ${i.dataRef} | ${i.patient || '?'} | R$ ${i.amount?.toFixed(2)} | ${i.id}`));
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
