#!/usr/bin/env node
/**
 * Auditoria READ-ONLY: mede quantos appointments pendentes (scheduled/pre_agendado/
 * confirmed) estão hoje vinculados a guias de convênio billingMode='per_month'.
 *
 * Serve como baseline ANTES do deploy de closeGuideBillingPeriod (ver
 * back/services/insuranceGuide/closeGuideBillingPeriod.js e o plano em
 * /home/user/.claude/plans/purring-sleeping-allen.md) — esse "lixo" de agenda
 * é exatamente o que a feature deve eliminar a cada faturamento.
 *
 * Rodar de novo depois de cada faturamento em produção nas primeiras semanas
 * para confirmar que guias recém-faturadas não acumulam mais pendências.
 *
 * Não escreve nada no banco. Uso:
 *   node scripts/audits/audit-guide-billing-closure.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '../../.env') });
dotenv.config();

// Registra todos os models na ordem certa antes de importar InsuranceGuide —
// InsuranceGuide.js -> identityResolver.js resolve mongoose.model('PatientsView'/'Patient')
// no topo do módulo, então precisam já estar registrados.
import '../../models/index.js';
import InsuranceGuide from '../../models/InsuranceGuide.js';
import Appointment from '../../models/Appointment.js';

const PENDING_STATUSES = ['scheduled', 'pre_agendado', 'confirmed'];

async function main() {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI/MONGO_URI não encontrado no .env');
    process.exit(1);
  }
  await mongoose.connect(mongoUri);
  console.log('Conectado. Auditando guias per_month com appointments pendentes...\n');

  const guides = await InsuranceGuide.find({
    billingMode: 'per_month',
    status: { $in: ['active', 'exhausted', 'linked'] }
  }).select('number insurance patientId status totalSessions usedSessions expiresAt').lean();

  console.log(`Guias per_month ativas/esgotadas/vinculadas: ${guides.length}\n`);

  let guidesComPendencia = 0;
  let totalAppointmentsPendentes = 0;
  const rows = [];

  for (const guide of guides) {
    const pendingCount = await Appointment.countDocuments({
      insuranceGuide: guide._id,
      operationalStatus: { $in: PENDING_STATUSES }
    });

    if (pendingCount > 0) {
      guidesComPendencia++;
      totalAppointmentsPendentes += pendingCount;
      rows.push({
        guideId: guide._id.toString(),
        number: guide.number,
        insurance: guide.insurance,
        status: guide.status,
        usedSessions: guide.usedSessions,
        totalSessions: guide.totalSessions,
        expiresAt: guide.expiresAt?.toISOString?.().slice(0, 10),
        pendingCount
      });
    }
  }

  console.log(`== RESUMO ==`);
  console.log(`Guias per_month com appointments pendentes: ${guidesComPendencia} / ${guides.length}`);
  console.log(`Total de appointments pendentes vinculados a guias per_month: ${totalAppointmentsPendentes}\n`);

  if (rows.length) {
    console.log('== DETALHE (guias com pendência) ==');
    rows
      .sort((a, b) => b.pendingCount - a.pendingCount)
      .forEach((r) => {
        console.log(
          `  ${r.number} | ${r.insurance} | status=${r.status} | uso=${r.usedSessions}/${r.totalSessions} | expira=${r.expiresAt} | pendentes=${r.pendingCount} | guideId=${r.guideId}`
        );
      });
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
