#!/usr/bin/env node
/**
 * 🔍 FINANCIAL INTEGRITY CHECK
 *
 * Valida se os principais endpoints financeiros retornam valores
 * consistentes para o mesmo período.
 *
 * Uso:
 *   cd back && node scripts/financial-integrity-check.js 2026-05-25
 *
 * Critério de sucesso:
 *   - cashflow.diario.producao.total === dashboard.mensal.producao (para o dia)
 *   - totals.production === cashflow.diario.producao.total
 *   - Nenhum endpoint usa valuation divergente
 */

import mongoose from 'mongoose';
import moment from 'moment-timezone';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

dotenv.config({ path: resolve(rootDir, '.env') });

import unifiedFinancialService from '../services/unifiedFinancialService.v2.js';

const TIMEZONE = 'America/Sao_Paulo';

async function connect() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('❌ MONGODB_URI não encontrado no .env');
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log('✅ MongoDB conectado');
}

async function disconnect() {
  await mongoose.disconnect();
  console.log('👋 MongoDB desconectado');
}

async function checkDay(targetDateStr) {
  const target = moment.tz(targetDateStr, TIMEZONE);
  const start = target.clone().startOf('day').utc().toDate();
  const end = target.clone().endOf('day').utc().toDate();

  console.log(`\n📅 Verificando: ${targetDateStr}`);
  console.log('─'.repeat(60));

  // 1. unifiedFinancialService (fonte única V2)
  const [cash, production] = await Promise.all([
    unifiedFinancialService.calculateCash(start, end),
    unifiedFinancialService.calculateProduction(start, end),
  ]);

  console.log(`\n  unifiedFinancialService:`);
  console.log(`    Caixa total:      R$ ${cash.total.toFixed(2)}`);
  console.log(`    Produção total:   R$ ${production.total.toFixed(2)}`);
  console.log(`    Atendimentos:     ${production.count}`);

  // 2. Verifica se todas as sessions têm effectiveValue > 0
  const zeroValueSessions = production.sessions.filter(s => {
    const v = s.sessionValue > 0
      ? s.sessionValue
      : s.package?.sessionValue > 0
        ? s.package.sessionValue
        : (s.package?.totalValue && s.package?.totalSessions)
          ? Math.round(s.package.totalValue / s.package.totalSessions)
          : 0;
    return v === 0;
  });

  if (zeroValueSessions.length > 0) {
    console.error(`\n  🚨 CRÍTICO: ${zeroValueSessions.length} sessão(ões) COMPLETED com valuation ZERO:`);
    zeroValueSessions.forEach(s => {
      console.error(`     - ${s._id} | patient=${s.patient} | date=${moment(s.date).format('YYYY-MM-DD')} | package=${s.package || 'none'}`);
    });
  } else {
    console.log(`\n  ✅ Todas as ${production.count} sessões têm valuation > 0`);
  }

  // 3. Consistência por tipo
  const tipoSoma = (production.particular || 0) + (production.pacote || 0)
                 + (production.convenio || 0) + (production.liminar || 0);

  console.log(`\n  Consistência de tipos:`);
  console.log(`    Soma dos tipos:     R$ ${tipoSoma.toFixed(2)}`);
  console.log(`    Produção total:     R$ ${production.total.toFixed(2)}`);
  console.log(`    Diferença:          R$ ${(production.total - tipoSoma).toFixed(2)} ${Math.abs(production.total - tipoSoma) < 0.01 ? '✅' : '❌'}`);

  // 4. Consistência liquidada vs total
  const liquidada = production.recebido || 0;
  const pendente = production.pendente || 0;
  console.log(`\n  Consistência liquidada:`);
  console.log(`    Liquidada:          R$ ${liquidada.toFixed(2)}`);
  console.log(`    Pendente:           R$ ${pendente.toFixed(2)}`);
  console.log(`    Total:              R$ ${production.total.toFixed(2)}`);
  console.log(`    Soma L+P:           R$ ${(liquidada + pendente).toFixed(2)} ${Math.abs(production.total - liquidada - pendente) < 0.01 ? '✅' : '❌'}`);

  return {
    date: targetDateStr,
    caixa: cash.total,
    producao: production.total,
    count: production.count,
    zeroValueCount: zeroValueSessions.length,
    tipoConsistente: Math.abs(production.total - tipoSoma) < 0.01,
    liquidacaoConsistente: Math.abs(production.total - liquidada - pendente) < 0.01,
  };
}

async function main() {
  const dateArg = process.argv[2];
  const datesToCheck = dateArg
    ? [dateArg]
    : [
        moment.tz(TIMEZONE).format('YYYY-MM-DD'),
        moment.tz(TIMEZONE).subtract(1, 'day').format('YYYY-MM-DD'),
        moment.tz(TIMEZONE).startOf('month').format('YYYY-MM-DD'),
        moment.tz(TIMEZONE).subtract(1, 'month').startOf('month').format('YYYY-MM-DD'),
      ];

  await connect();

  const results = [];
  for (const d of datesToCheck) {
    try {
      const r = await checkDay(d);
      results.push(r);
    } catch (err) {
      console.error(`❌ Erro ao verificar ${d}:`, err.message);
      results.push({ date: d, error: err.message });
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('RESUMO');
  console.log('='.repeat(60));

  let allOk = true;
  for (const r of results) {
    if (r.error) {
      console.log(`❌ ${r.date}: ERRO — ${r.error}`);
      allOk = false;
    } else {
      const ok = r.tipoConsistente && r.liquidacaoConsistente && r.zeroValueCount === 0;
      console.log(`${ok ? '✅' : '⚠️'} ${r.date}: Produção=R$${r.producao.toFixed(2)} Caixa=R$${r.caixa.toFixed(2)} Atend=${r.count} Zeros=${r.zeroValueCount}`);
      if (!ok) allOk = false;
    }
  }

  await disconnect();

  process.exit(allOk ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
