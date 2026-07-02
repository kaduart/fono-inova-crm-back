#!/usr/bin/env node
/**
 * Preview do impacto do backfill de guidePolicy.
 *
 * Uso:
 *   node scripts/preview-backfill-guidePolicy.js
 *
 * O script simula a aplicação de guidePolicy end_of_month nos convênios legados
 * e compara o lifecycle atual (sem política) com o futuro (com política).
 * Não altera dados.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { GuideLifecycleService } from '../services/guideLifecycle/GuideLifecycleService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const PROPOSED_POLICY = {
  renewalType: 'end_of_month',
  renewalDay: 'last_day',
  expirationWarningDays: 5,
  autoSuggestRenewal: true,
  defaultMigrationStrategy: 'eligible'
};

function formatDate(date) {
  if (!date) return 'N/A';
  return new Date(date).toISOString().split('T')[0];
}

function lifecycleSummary(lifecycle) {
  return {
    status: lifecycle.state.status,
    canSchedule: lifecycle.eligibility.canSchedule,
    canBill: lifecycle.eligibility.canBill,
    canRenew: lifecycle.eligibility.canRenew,
    alerts: lifecycle.alerts.map(a => a.code).join(', ') || 'nenhum'
  };
}

async function main() {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI ou MONGO_URI não configurado no .env');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log('Conectado ao MongoDB');

  const db = mongoose.connection.db;

  try {
    const conveniosSemPolicy = await db.collection('convenios').find({
      $or: [
        { guidePolicy: { $exists: false } },
        { guidePolicy: null }
      ]
    }).project({ code: 1, name: 1 }).toArray();

    let relatorio = '';
    relatorio += '=====================================================\n';
    relatorio += 'PREVIEW DO BACKFILL DE GUIDEPOLICY\n';
    relatorio += '=====================================================\n';
    relatorio += `Gerado em: ${new Date().toISOString()}\n`;
    relatorio += `Política proposta: ${JSON.stringify(PROPOSED_POLICY)}\n\n`;

    let totalGuiasAfetadas = 0;
    let totalMudancas = 0;

    for (const convenio of conveniosSemPolicy) {
      const guias = await db.collection('insuranceguides')
        .find({ insurance: convenio.code })
        .project({ number: 1, patientId: 1, specialty: 1, status: 1, totalSessions: 1, usedSessions: 1, expiresAt: 1, createdAt: 1 })
        .toArray();

      totalGuiasAfetadas += guias.length;

      relatorio += `-----------------------------------------------------\n`;
      relatorio += `Convênio: ${convenio.code} (${convenio.name || 'sem nome'})\n`;
      relatorio += `Guias afetadas: ${guias.length}\n\n`;

      for (const g of guias) {
        const lifecycleAtual = await GuideLifecycleService.evaluate(g, new Date());
        const lifecycleFuturo = GuideLifecycleService.evaluateWithPolicy(g, PROPOSED_POLICY, new Date());

        const atual = lifecycleSummary(lifecycleAtual);
        const futuro = lifecycleSummary(lifecycleFuturo);

        const mudou =
          atual.status !== futuro.status ||
          atual.canSchedule !== futuro.canSchedule ||
          atual.canBill !== futuro.canBill ||
          atual.canRenew !== futuro.canRenew ||
          atual.alerts !== futuro.alerts;

        if (mudou) totalMudancas++;

        relatorio += `  Guia: ${g.number || '(sem número)'} | ${g.specialty}\n`;
        relatorio += `    ID: ${g._id}\n`;
        relatorio += `    Status bruto: ${g.status}\n`;
        relatorio += `    Total/Usado: ${g.totalSessions}/${g.usedSessions}\n`;
        relatorio += `    Expira em: ${formatDate(g.expiresAt)}\n`;
        relatorio += `    Criada em: ${formatDate(g.createdAt)}\n`;
        relatorio += `    ATUAL  -> status: ${atual.status}, canSchedule: ${atual.canSchedule}, canBill: ${atual.canBill}, canRenew: ${atual.canRenew}, alerts: [${atual.alerts}]\n`;
        relatorio += `    FUTURO -> status: ${futuro.status}, canSchedule: ${futuro.canSchedule}, canBill: ${futuro.canBill}, canRenew: ${futuro.canRenew}, alerts: [${futuro.alerts}]\n`;
        relatorio += `    ${mudou ? '⚠️ MUDANÇA DETECTADA' : '✅ sem mudança'}\n\n`;
      }
    }

    relatorio += '=====================================================\n';
    relatorio += 'RESUMO\n';
    relatorio += '=====================================================\n';
    relatorio += `Convênios sem guidePolicy: ${conveniosSemPolicy.length}\n`;
    relatorio += `Total de guias afetadas: ${totalGuiasAfetadas}\n`;
    relatorio += `Guias com mudança de comportamento: ${totalMudancas}\n`;
    relatorio += `Guias sem mudança: ${totalGuiasAfetadas - totalMudancas}\n`;

    const outputPath = path.resolve(__dirname, `../../auditoria-output/preview-backfill-guidePolicy-${Date.now()}.txt`);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, relatorio);

    console.log(relatorio);
    console.log(`\nRelatório salvo em: ${outputPath}`);

  } finally {
    await mongoose.disconnect();
    console.log('\nDesconectado do MongoDB');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
