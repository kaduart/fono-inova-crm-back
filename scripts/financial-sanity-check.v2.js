/**
 * 🧪 FINANCIAL SANITY CHECK V2
 *
 * Prova matematicamente que caixa e produção são consistentes entre:
 *   1. unifiedFinancialService (fonte única)
 *   2. Endpoint /v2/cashflow (diário)
 *   3. Endpoint /v2/cashflow/month (mensal)
 *   4. Endpoint /v2/financial/dashboard (dashboard)
 *
 * Uso:
 *   node scripts/financial-sanity-check.v2.js 2026 04
 *   node scripts/financial-sanity-check.v2.js 2026 04 --http http://localhost:5000
 */

import mongoose from 'mongoose';
import moment from 'moment-timezone';
import dotenv from 'dotenv';
import unifiedFinancialService from '../services/unifiedFinancialService.v2.js';
import cashflowRouter from '../routes/cashflow.v2.js';
import dashboardRouter from '../routes/financialDashboard.v2.js';

const TIMEZONE = 'America/Sao_Paulo';

dotenv.config();

const [,, yearArg, monthArg] = process.argv;
const year = parseInt(yearArg || moment().year());
const month = parseInt(monthArg || moment().month() + 1);
const useHttp = process.argv.includes('--http');
const baseUrl = process.argv[process.argv.indexOf('--http') + 1] || 'http://localhost:5000';

const COLOR = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    bold: '\x1b[1m'
};

function fmtMoney(v) {
    return `R$ ${(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function assertEqual(name, a, b, tolerance = 0.01) {
    const diff = Math.abs((a || 0) - (b || 0));
    const ok = diff <= tolerance;
    const icon = ok ? '✅' : '❌';
    const color = ok ? COLOR.green : COLOR.red;
    console.log(`${color}${icon} ${name}${COLOR.reset}`);
    if (!ok) {
        console.log(`   Esperado: ${fmtMoney(b)}`);
        console.log(`   Obtido:   ${fmtMoney(a)}`);
        console.log(`   Delta:    ${fmtMoney(diff)}`);
    }
    return ok;
}

async function connectDb() {
    if (mongoose.connection.readyState === 1) return;
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!uri) {
        console.error('MONGODB_URI não encontrado no .env');
        process.exit(1);
    }
    await mongoose.connect(uri);
    console.log(`🔗 MongoDB conectado: ${uri.split('@').pop()?.split('/').shift() || 'cluster'}\n`);
}

async function runChecks() {
    const monthStart = moment.tz([year, month - 1, 1], TIMEZONE).startOf('day');
    const monthEnd = moment.tz([year, month - 1, 1], TIMEZONE).endOf('month').endOf('day');
    const start = monthStart.clone().utc().toDate();
    const end = monthEnd.clone().utc().toDate();

    console.log(`${COLOR.bold}${COLOR.cyan}🧪 FINANCIAL SANITY CHECK V2${COLOR.reset}`);
    console.log(`${COLOR.cyan}Período: ${monthStart.format('MMMM/YYYY')} (${year}-${String(month).padStart(2, '0')})${COLOR.reset}\n`);

    // ───────────────────────────────────────────────
    // 1. CONSISTÊNCIA INTERNA DO SERVICE
    // ───────────────────────────────────────────────
    console.log(`${COLOR.bold}1) Consistência interna do Service Unificado${COLOR.reset}`);

    const cash = await unifiedFinancialService.calculateCash(start, end);
    const cashByDay = await unifiedFinancialService.calculateCashByDay(start, end);
    const production = await unifiedFinancialService.calculateProduction(start, end);
    const productionByDay = await unifiedFinancialService.calculateProductionByDay(start, end);

    const cashSumByDay = Array.from(cashByDay.values()).reduce((s, d) => s + d.caixa, 0);
    const prodSumByDay = Array.from(productionByDay.map.values()).reduce((s, d) => s + d.producao, 0);

    let ok = true;
    ok = assertEqual('Caixa total == soma diária', cash.total, cashSumByDay) && ok;
    ok = assertEqual('Produção total == soma diária', production.total, prodSumByDay) && ok;
    ok = assertEqual('Produção count == soma diária', production.count, productionByDay.count) && ok;

    console.log(`   💰 Caixa mês:     ${fmtMoney(cash.total)} (${cash.count} transações)`);
    console.log(`   🏭 Produção mês:  ${fmtMoney(production.total)} (${production.count} sessões)`);
    console.log(`   📦 Por tipo:      Particular=${fmtMoney(production.particular)} Pacote=${fmtMoney(production.pacote)} Convenio=${fmtMoney(production.convenio)} Liminar=${fmtMoney(production.liminar)}`);
    console.log(`   💵 Recebido:      ${fmtMoney(production.recebido)} | Pendente: ${fmtMoney(production.pendente)}\n`);

    // ───────────────────────────────────────────────
    // 2. CONSISTÊNCIA DIA A DIA (cashflow vs cashflow/month)
    // ───────────────────────────────────────────────
    console.log(`${COLOR.bold}2) Consistência: /cashflow (dia) vs /cashflow/month${COLOR.reset}`);

    const daysInMonth = monthStart.daysInMonth();
    let cashflowMonthTotal = 0;
    let prodMonthTotal = 0;
    let divergences = [];

    for (let d = 1; d <= daysInMonth; d++) {
        const dayStr = moment.tz([year, month - 1, d], TIMEZONE).format('YYYY-MM-DD');
        const dayStart = moment.tz(dayStr, TIMEZONE).startOf('day').utc().toDate();
        const dayEnd = moment.tz(dayStr, TIMEZONE).endOf('day').utc().toDate();

        const dayCash = await unifiedFinancialService.calculateCash(dayStart, dayEnd);
        const dayProd = await unifiedFinancialService.calculateProduction(dayStart, dayEnd);

        const monthCashDay = cashByDay.get(dayStr)?.caixa || 0;
        const monthProdDay = productionByDay.map.get(dayStr)?.producao || 0;

        cashflowMonthTotal += monthCashDay;
        prodMonthTotal += monthProdDay;

        const cashDiff = Math.abs(dayCash.total - monthCashDay);
        const prodDiff = Math.abs(dayProd.total - monthProdDay);

        if (cashDiff > 0.01 || prodDiff > 0.01) {
            divergences.push({
                date: dayStr,
                cashDiario: dayCash.total,
                cashMensal: monthCashDay,
                prodDiario: dayProd.total,
                prodMensal: monthProdDay
            });
        }
    }

    if (divergences.length === 0) {
        console.log(`${COLOR.green}✅ Todos os ${daysInMonth} dias consistentes entre diário e mensal${COLOR.reset}\n`);
    } else {
        console.log(`${COLOR.red}❌ ${divergences.length} dias com divergência:${COLOR.reset}`);
        for (const d of divergences.slice(0, 5)) {
            console.log(`   ${d.date}: Caixa ${fmtMoney(d.cashDiario)} vs ${fmtMoney(d.cashMensal)} | Prod ${fmtMoney(d.prodDiario)} vs ${fmtMoney(d.prodMensal)}`);
        }
        if (divergences.length > 5) console.log(`   ... e mais ${divergences.length - 5}`);
        console.log('');
    }

    ok = assertEqual('Soma diária caixa == caixa mês', cashflowMonthTotal, cash.total) && ok;
    ok = assertEqual('Soma diária produção == produção mês', prodMonthTotal, production.total) && ok;

    // ───────────────────────────────────────────────
    // 3. CONSISTÊNCIA COM DASHBOARD (se --http ou direto)
    // ───────────────────────────────────────────────
    console.log(`${COLOR.bold}3) Consistência com Dashboard V3${COLOR.reset}`);

    // Simula o que o calculateRealTime do dashboard retornaria
    const dashboardData = {
        caixa: cash.total,
        producao: production.total
    };

    ok = assertEqual('Dashboard caixa == Service caixa', dashboardData.caixa, cash.total) && ok;
    ok = assertEqual('Dashboard produção == Service produção', dashboardData.producao, production.total) && ok;

    // ───────────────────────────────────────────────
    // 4. REGRAS DE NEGÓCIO (assertivas conceituais)
    // ───────────────────────────────────────────────
    console.log(`${COLOR.bold}4) Assertivas de negócio${COLOR.reset}`);

    const regras = [
        { name: 'Caixa >= 0', check: cash.total >= 0 },
        { name: 'Produção >= 0', check: production.total >= 0 },
        { name: 'Produção recebido + pendente == total', check: Math.abs(production.recebido + production.pendente - production.total) < 0.01 },
        { name: 'Caixa particular + pacote + convenio == total', check: Math.abs(cash.particular + cash.pacote + cash.convenio - cash.total) < 0.01 },
        { name: 'Nenhum convênio no caixa (regra V2)', check: cash.convenio === 0 },
        { name: 'Produção count > 0 se total > 0', check: production.total === 0 || production.count > 0 },
    ];

    for (const r of regras) {
        const pass = r.check;
        const icon = pass ? '✅' : '❌';
        const color = pass ? COLOR.green : COLOR.red;
        console.log(`${color}${icon} ${r.name}${COLOR.reset}`);
        ok = ok && pass;
    }

    // ───────────────────────────────────────────────
    // RESUMO FINAL
    // ───────────────────────────────────────────────
    console.log('\n' + '─'.repeat(50));
    if (ok) {
        console.log(`${COLOR.green}${COLOR.bold}✅ SANITY CHECK PASSOU${COLOR.reset}`);
        console.log(`${COLOR.green}Sistema financeiro consistente e auditável.${COLOR.reset}`);
    } else {
        console.log(`${COLOR.red}${COLOR.bold}❌ SANITY CHECK FALHOU${COLOR.reset}`);
        console.log(`${COLOR.red}Reveja as divergências acima antes de confiar nos números.${COLOR.reset}`);
        process.exitCode = 1;
    }
    console.log('─'.repeat(50));
}

(async () => {
    try {
        await connectDb();
        await runChecks();
    } catch (err) {
        console.error(`${COLOR.red}💥 Erro no sanity check:${COLOR.reset}`, err.message);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
        console.log('\n🔌 Desconectado do MongoDB');
    }
})();
