#!/usr/bin/env node
/**
 * 📊 Report Projection Usage
 *
 * Gera o relatório oficial de uso da aba "Projeção & Cenários"
 * e do endpoint legado projection-daily, com base nas métricas
 * persistidas em MetricLog.
 *
 * Uso:
 *   node back/scripts/report-projection-usage.js [--days=15]
 *   node back/scripts/report-projection-usage.js [--start=2026-06-01] [--end=2026-06-15]
 *   node back/scripts/report-projection-usage.js [--days=7] --json > projection-usage.json
 *
 * Saída: relatório em texto (padrão) ou JSON (--json).
 */

import mongoose from 'mongoose';
import { writeFileSync } from 'fs';
import { join } from 'path';

const MONGO_URI = process.env.MONGO_URI ||
  'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/fono_inova_prod?retryWrites=true&w=majority&appName=Cluster0';

const args = process.argv.slice(2);
const outputJson = args.includes('--json');
const daysArg = args.find(a => a.startsWith('--days='))?.split('=')[1];
const startArg = args.find(a => a.startsWith('--start='))?.split('=')[1];
const endArg = args.find(a => a.startsWith('--end='))?.split('=')[1];

const DAYS = daysArg ? parseInt(daysArg, 10) : 15;

let startDate;
let endDate = new Date();

if (startArg && endArg) {
  startDate = new Date(startArg + 'T00:00:00.000-03:00');
  endDate = new Date(endArg + 'T23:59:59.999-03:00');
} else {
  startDate = new Date();
  startDate.setDate(startDate.getDate() - DAYS);
  startDate.setHours(0, 0, 0, 0);
}

function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

function formatDateTime(d) {
  return d.toISOString();
}

async function run() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const collection = db.collection('metriclogs');

  console.error('🔌 Conectado ao MongoDB');

  // ─── 1. Quem abriu a aba Projeção & Cenários ───────────────────────────────
  const tabOpens = await collection
    .aggregate([
      {
        $match: {
          service: 'ProjectionTab',
          operation: 'opened',
          timestamp: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: { userId: '$data.userId', role: '$data.role' },
          opens: { $sum: 1 },
          lastAccess: { $max: '$timestamp' }
        }
      },
      { $sort: { opens: -1 } }
    ])
    .toArray();

  const totalTabOpens = tabOpens.reduce((sum, u) => sum + u.opens, 0);
  const uniqueTabUsers = tabOpens.length;

  // ─── 2. Chamadas ao endpoint legado projection-daily ────────────────────────
  const endpointUsage = await collection
    .aggregate([
      {
        $match: {
          service: 'LegacyFinancialDashboard',
          operation: 'projection-daily-request',
          timestamp: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: null,
          totalRequests: { $sum: 1 },
          uniqueUsers: { $addToSet: '$data.userId' }
        }
      }
    ])
    .toArray();

  const endpointStats = endpointUsage[0] || { totalRequests: 0, uniqueUsers: [] };
  const endpointUniqueUsers = (endpointStats.uniqueUsers || []).filter(Boolean).length;

  // ─── 3. Leituras de FinancialProjection ─────────────────────────────────────
  const projectionReads = await collection
    .aggregate([
      {
        $match: {
          service: { $in: ['FinancialProjection', 'ReconciliationWorker'] },
          timestamp: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: { service: '$service', operation: '$operation' },
          count: { $sum: 1 },
          lastSeen: { $max: '$timestamp' }
        }
      },
      { $sort: { count: -1 } }
    ])
    .toArray();

  // ─── 4. Go/No-Go count ──────────────────────────────────────────────────────
  const goNoGoCount = await collection.countDocuments({
    service: 'ProjectionTab',
    operation: 'opened',
    timestamp: { $gte: startDate, $lte: endDate }
  });

  // ─── Monta relatório ────────────────────────────────────────────────────────
  const report = {
    period: {
      start: formatDateTime(startDate),
      end: formatDateTime(endDate),
      days: Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24))
    },
    projectionTab: {
      totalOpens: totalTabOpens,
      uniqueUsers: uniqueTabUsers,
      topUsers: tabOpens.map(u => ({
        userId: u._id.userId || 'anonymous',
        role: u._id.role || 'unknown',
        opens: u.opens,
        lastAccess: formatDateTime(u.lastAccess)
      }))
    },
    projectionDailyEndpoint: {
      totalRequests: endpointStats.totalRequests,
      uniqueUsers: endpointUniqueUsers
    },
    financialProjection: {
      reads: projectionReads.map(r => ({
        service: r._id.service,
        operation: r._id.operation,
        count: r.count,
        lastSeen: formatDateTime(r.lastSeen)
      }))
    },
    goNoGo: {
      totalTabOpens: goNoGoCount,
      recommendation:
        goNoGoCount === 0
          ? 'REMOVER — nenhum acesso na janela'
          : goNoGoCount <= 3
          ? 'AVALIAR REMOÇÃO — uso muito baixo'
          : 'MANTER / INCORPORAR — uso detectado'
    }
  };

  if (outputJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const lines = [];
    lines.push('═══════════════════════════════════════════════════════════════');
    lines.push('  📊 PROJECTION TAB USAGE REPORT');
    lines.push('═══════════════════════════════════════════════════════════════');
    lines.push('');
    lines.push(`Período: ${formatDate(startDate)} → ${formatDate(endDate)} (${report.period.days} dias)`);
    lines.push('');

    lines.push('───────────────────────────────────────────────────────────────');
    lines.push('  1. ProjectionTab.opened');
    lines.push('───────────────────────────────────────────────────────────────');
    lines.push(`Total de acessos: ${totalTabOpens}`);
    lines.push(`Usuários únicos:  ${uniqueTabUsers}`);
    lines.push('');
    if (tabOpens.length === 0) {
      lines.push('Nenhum acesso registrado.');
    } else {
      lines.push('Top usuários:');
      tabOpens.forEach((u, i) => {
        lines.push(`  ${i + 1}. ${u._id.userId || 'anonymous'} (${u._id.role || 'unknown'}) — ${u.opens} acesso(s), último em ${formatDateTime(u.lastAccess)}`);
      });
    }
    lines.push('');

    lines.push('───────────────────────────────────────────────────────────────');
    lines.push('  2. projection-daily-request (endpoint legado)');
    lines.push('───────────────────────────────────────────────────────────────');
    lines.push(`Total de chamadas: ${endpointStats.totalRequests}`);
    lines.push(`Usuários únicos:   ${endpointUniqueUsers}`);
    lines.push('');

    lines.push('───────────────────────────────────────────────────────────────');
    lines.push('  3. FinancialProjection / ReconciliationWorker');
    lines.push('───────────────────────────────────────────────────────────────');
    if (projectionReads.length === 0) {
      lines.push('Nenhuma leitura registrada.');
    } else {
      projectionReads.forEach(r => {
        lines.push(`  • ${r._id.service}:${r._id.operation} — ${r.count} leitura(s), última em ${formatDateTime(r.lastSeen)}`);
      });
    }
    lines.push('');

    lines.push('───────────────────────────────────────────────────────────────');
    lines.push('  4. Go / No-Go');
    lines.push('───────────────────────────────────────────────────────────────');
    lines.push(`Total de acessos à aba: ${goNoGoCount}`);
    lines.push(`Recomendação: ${report.goNoGo.recommendation}`);
    lines.push('');

    lines.push('═══════════════════════════════════════════════════════════════');
    lines.push('  DECISÃO:');
    lines.push('  [ ] Remover');
    lines.push('  [ ] Incorporar na aba Metas');
    lines.push('  [ ] Módulo moderno na Sprint 4');
    lines.push('═══════════════════════════════════════════════════════════════');

    const output = lines.join('\n');
    console.log(output);

    // Salva relatório em arquivo para anexar em decisões
    const fileName = `projection-usage-report-${formatDate(startDate)}_${formatDate(endDate)}.txt`;
    const filePath = join(process.cwd(), fileName);
    writeFileSync(filePath, output);
    console.error(`\n📝 Relatório salvo em: ${filePath}`);
  }

  await mongoose.disconnect();
  process.exit(0);
}

run().catch(err => {
  console.error('❌ Erro ao gerar relatório:', err.message);
  process.exit(1);
});
