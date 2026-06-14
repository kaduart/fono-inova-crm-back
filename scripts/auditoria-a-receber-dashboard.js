#!/usr/bin/env node
/**
 * 🔍 Auditoria do "A Receber" exibido no Dashboard Financeiro V3
 *
 * Reproduz o cálculo exato do endpoint /v2/financial/dashboard para um mês
 * e decompõe a origem do valor. Útil para revalidar se há contaminação por
 * pendentes de meses anteriores ou inconsistência no snapshot diário.
 *
 * Uso:
 *   node back/scripts/auditoria-a-receber-dashboard.js [YYYY] [MM]
 *
 * Exemplo:
 *   node back/scripts/auditoria-a-receber-dashboard.js 2026 6
 */

import mongoose from 'mongoose';
import moment from 'moment-timezone';
import unifiedFinancialService from '../services/unifiedFinancialService.v2.js';

const MONGO_URI = process.env.MONGO_URI ||
  'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/fono_inova_prod?retryWrites=true&w=majority&appName=Cluster0';

const TIMEZONE = 'America/Sao_Paulo';

function formatCurrency(v) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v || 0);
}

async function run() {
  const year = parseInt(process.argv[2] || '2026', 10);
  const month = parseInt(process.argv[3] || '6', 10);

  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  const now = moment.tz(TIMEZONE);
  const isCurrentMonth = year === now.year() && month === now.month() + 1;

  const start = moment.tz([year, month - 1], TIMEZONE).startOf('month').utc().toDate();
  const end = isCurrentMonth
    ? now.endOf('day').utc().toDate()
    : moment.tz([year, month - 1], TIMEZONE).endOf('month').utc().toDate();

  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`  🔍 AUDITORIA DO "A RECEBER" — DASHBOARD FINANCEIRO V3`);
  console.log(`  Período: ${String(month).padStart(2, '0')}/${year}`);
  console.log(`  Range UTC: ${start.toISOString()} → ${end.toISOString()}`);
  console.log(`  Mês atual? ${isCurrentMonth ? 'SIM (usa real-time, ignora snapshot)' : 'NÃO (pode usar snapshot)'}`);
  console.log('═══════════════════════════════════════════════════════════════════\n');

  // 1. Cálculo idêntico ao endpoint /v2/financial/dashboard
  const [cash, production] = await Promise.all([
    unifiedFinancialService.calculateCash(start, end),
    unifiedFinancialService.calculateProduction(start, end)
  ]);

  const convenioAReceber = Math.max(0, (production.convenio || 0) - (cash.convenio || 0));
  const liminarAReceber  = Math.max(0, (production.liminar  || 0) - (cash.liminar  || 0));
  const particularPendente = production.particularPendente || 0;
  const pacotePendente = production.pacotePendente || 0;
  const aReceberProducao = convenioAReceber + liminarAReceber + particularPendente + pacotePendente;
  const receitaReconhecida = cash.total + aReceberProducao;

  console.log('1. CAIXA (Payment.status = paid)');
  console.log(`   Total:        ${formatCurrency(cash.total)}`);
  console.log(`   • Particular: ${formatCurrency(cash.particular)}`);
  console.log(`   • Pacote:     ${formatCurrency(cash.pacote)}`);
  console.log(`   • Convênio:   ${formatCurrency(cash.convenio)}`);
  console.log(`   • Liminar:    ${formatCurrency(cash.liminar)}`);
  console.log(`   Transações:   ${cash.count}\n`);

  console.log('2. PRODUÇÃO (Session.status = completed)');
  console.log(`   Total:        ${formatCurrency(production.total)}`);
  console.log(`   • Particular: ${formatCurrency(production.particular)}`);
  console.log(`   • Pacote:     ${formatCurrency(production.pacote)}`);
  console.log(`   • Convênio:   ${formatCurrency(production.convenio)}`);
  console.log(`   • Liminar:    ${formatCurrency(production.liminar)}`);
  console.log(`   Sessões:      ${production.count}\n`);

  console.log('3. COMPOSIÇÃO DO "A RECEBER" (= aReceberProducao enviado ao front)');
  console.log(`   Convênio a receber:  ${formatCurrency(convenioAReceber)}  (produção convênio − caixa convênio)`);
  console.log(`   Liminar a receber:   ${formatCurrency(liminarAReceber)}  (produção liminar − caixa liminar)`);
  console.log(`   Particular pendente: ${formatCurrency(particularPendente)}  (sessões completed sem payment paid)`);
  console.log(`   Pacote pendente:     ${formatCurrency(pacotePendente)}  (forçado 0 — pacotes pré-pagos já geraram caixa)`);
  console.log(`   ─────────────────────────────────────────────────────────────`);
  console.log(`   A RECEBER DO MÊS:    ${formatCurrency(aReceberProducao)}`);
  console.log(`   RECEITA RECONHECIDA: ${formatCurrency(receitaReconhecida)}  (caixa + a receber)\n`);

  // 4. Pendentes de meses anteriores (não devem entrar no aReceberProducao)
  const monthStart = moment.tz([year, month - 1], TIMEZONE).startOf('month').toDate();
  const previousStart = new Date(Date.UTC(2024, 0, 1));

  const previousPending = await db.collection('payments').find({
    status: 'pending',
    billingType: { $in: ['convenio', 'particular'] },
    $or: [
      { createdAt: { $gte: previousStart, $lt: monthStart } },
      { paymentDate: { $gte: previousStart.toISOString(), $lt: moment.tz([year, month - 1], TIMEZONE).startOf('month').format('YYYY-MM-DD') } }
    ]
  }).project({ amount: 1, billingType: 1, status: 1, createdAt: 1, paymentDate: 1 }).toArray();

  const previousPendingTotal = previousPending.reduce((s, p) => s + (p.amount || 0), 0);

  console.log('4. PENDENTES DE MESES ANTERIORES (não entram no cálculo acima)');
  console.log(`   Quantidade: ${previousPending.length}`);
  console.log(`   Valor total: ${formatCurrency(previousPendingTotal)}`);
  console.log(`   Status: ${previousPendingTotal > 0 ? '⚠️ EXISTEM, mas NÃO somados no A Receber do mês' : '✅ Nenhum encontrado'}\n`);

  // 5. Snapshot diário (só informativo — mês atual não usa)
  const startStr = moment.tz([year, month - 1], TIMEZONE).startOf('month').format('YYYY-MM-DD');
  const endStr = moment.tz([year, month - 1], TIMEZONE).endOf('month').format('YYYY-MM-DD');
  const snapshots = await db.collection('financialdailysnapshots')
    .find({ date: { $gte: startStr, $lte: endStr }, clinicId: 'default' })
    .sort({ date: 1 })
    .toArray();

  const snapProductionTotal = snapshots.reduce((s, x) => s + (x.production?.total || 0), 0);
  const snapCashTotal = snapshots.reduce((s, x) => s + (x.cash?.total || 0), 0);

  console.log('5. SNAPSHOTS DIÁRIOS (FinancialDailySnapshot)');
  console.log(`   Dias com snapshot: ${snapshots.length}`);
  console.log(`   Soma production.total nos snapshots: ${formatCurrency(snapProductionTotal)}`);
  console.log(`   Soma cash.total nos snapshots:       ${formatCurrency(snapCashTotal)}`);
  console.log(`   Observação: ${isCurrentMonth ? 'mês atual IGNORA snapshot e usa real-time' : 'mês fechado pode usar snapshot como fonte'}\n`);

  // 6. Conclusão
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  CONCLUSÃO');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`  O dashboard exibe "A Receber" = ${formatCurrency(aReceberProducao)}`);
  console.log(`  Composto por: convênio ${formatCurrency(convenioAReceber)} + liminar ${formatCurrency(liminarAReceber)} + particular ${formatCurrency(particularPendente)} + pacote ${formatCurrency(pacotePendente)}.`);
  console.log(`  Pendentes de meses anteriores (${formatCurrency(previousPendingTotal)}) NÃO entram no valor do mês.`);
  if (isCurrentMonth) {
    console.log(`  Snapshot diário NÃO é usado no mês atual (fonte: unifiedFinancialService.v2 real-time).`);
  }
  console.log('═══════════════════════════════════════════════════════════════════');

  await mongoose.disconnect();
}

run().catch(err => {
  console.error('❌ Erro na auditoria:', err.message);
  process.exit(1);
});
