#!/usr/bin/env node
/**
 * Auditoria READ-ONLY administrativa: guias per_month VENCIDAS (expiresAt no
 * passado) que ainda têm appointments pendentes vinculados, e quando foi o
 * último faturamento de cada uma.
 *
 * Substitui a ideia de fechamento automático dentro do faturarLote (revertida
 * em 2026-07-23 — ver back/services/insuranceGuide/closeGuideBillingPeriod.js
 * e memória do projeto project_guide_billing_closure_implemented.md): como o
 * sistema não consegue inferir, só olhando o faturamento, se a guia foi
 * abandonada ou está em faturamento parcial legítimo, a decisão de encerrar
 * fica com o operador humano (Opção A — botão manual "Encerrar guia").
 *
 * Este script é a ferramenta de apoio pra esse operador: reporta candidatas
 * a encerramento manual, não cancela nada sozinho.
 *
 * Não escreve nada no banco. Uso:
 *   node scripts/audits/audit-expired-guides-pending-sessions.js
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
import InsuranceGuide from '../../models/InsuranceGuide.js';
import Appointment from '../../models/Appointment.js';
import Session from '../../models/Session.js';
import InsuranceBatch from '../../models/InsuranceBatch.js';

const PENDING_STATUSES = ['scheduled', 'pre_agendado', 'confirmed'];

async function main() {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI/MONGO_URI não encontrado no .env');
    process.exit(1);
  }
  await mongoose.connect(mongoUri);

  const now = new Date();
  console.log(`Conectado. Auditando guias per_month vencidas em ${now.toISOString().slice(0, 10)}...\n`);

  const guides = await InsuranceGuide.find({
    billingMode: 'per_month',
    expiresAt: { $lt: now },
    status: { $in: ['active', 'exhausted', 'expired', 'linked'] }
  }).select('number insurance patientId status totalSessions usedSessions expiresAt').lean();

  console.log(`Guias per_month vencidas (qualquer status não-cancelado/superseded): ${guides.length}\n`);

  const rows = [];
  for (const guide of guides) {
    const pendingCount = await Appointment.countDocuments({
      insuranceGuide: guide._id,
      operationalStatus: { $in: PENDING_STATUSES }
    });
    if (pendingCount === 0) continue;

    // Último faturamento: maior createdAt entre os InsuranceBatch das sessões desta guia
    const billedSessionIds = await Session.find({ insuranceGuide: guide._id, billingBatchId: { $ne: null } })
      .distinct('billingBatchId');
    let lastBillingDate = null;
    if (billedSessionIds.length > 0) {
      const lastBatch = await InsuranceBatch.find({ _id: { $in: billedSessionIds } })
        .sort({ createdAt: -1 })
        .limit(1)
        .select('createdAt batchNumber')
        .lean();
      lastBillingDate = lastBatch[0]?.createdAt || null;
    }

    const daysSinceExpiry = Math.floor((now - new Date(guide.expiresAt)) / (1000 * 60 * 60 * 24));
    const daysSinceLastBilling = lastBillingDate ? Math.floor((now - new Date(lastBillingDate)) / (1000 * 60 * 60 * 24)) : null;

    rows.push({
      number: guide.number,
      insurance: guide.insurance,
      status: guide.status,
      usedSessions: guide.usedSessions,
      totalSessions: guide.totalSessions,
      expiresAt: guide.expiresAt?.toISOString?.().slice(0, 10),
      daysSinceExpiry,
      pendingCount,
      lastBillingDate: lastBillingDate ? new Date(lastBillingDate).toISOString().slice(0, 10) : 'nunca faturada',
      daysSinceLastBilling,
      guideId: guide._id.toString()
    });
  }

  console.log(`== RESUMO ==`);
  console.log(`Guias vencidas com pendência real: ${rows.length}\n`);

  if (rows.length === 0) {
    console.log('Nenhuma guia vencida com pendência — nada para revisar manualmente agora.');
  } else {
    console.log('== CANDIDATAS A ENCERRAMENTO MANUAL (ordenadas por dias sem faturar, desc) ==');
    rows
      .sort((a, b) => (b.daysSinceLastBilling ?? 9999) - (a.daysSinceLastBilling ?? 9999))
      .forEach((r) => {
        console.log(
          `  ${r.number} | ${r.insurance} | status=${r.status} | uso=${r.usedSessions}/${r.totalSessions} | ` +
          `venceu há ${r.daysSinceExpiry}d (${r.expiresAt}) | pendentes=${r.pendingCount} | ` +
          `último faturamento: ${r.lastBillingDate}${r.daysSinceLastBilling !== null ? ` (há ${r.daysSinceLastBilling}d)` : ''} | guideId=${r.guideId}`
        );
      });
    console.log(
      '\nInterpretação: quanto mais dias desde o último faturamento (ou "nunca faturada"), maior a chance de ser guia abandonada ' +
      '(candidata real a encerramento manual) em vez de faturamento parcial em andamento. Confirmar com o operador antes de agir — ' +
      'este script só reporta, não cancela nada.'
    );
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
