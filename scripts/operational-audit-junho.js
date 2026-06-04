#!/usr/bin/env node
/**
 * 🔍 AUDITORIA OPERACIONAL — JUNHO 2026 (MÊS PILOTO)
 *
 * Valida consistência semântica entre:
 * - Caixa (unifiedFinancialService)
 * - Produção (unifiedFinancialService)
 * - Snapshot (FinancialDailySnapshot)
 * - Edge cases semânticos reais
 *
 * Executar: node scripts/operational-audit-junho.js
 */

import mongoose from 'mongoose';
import moment from 'moment-timezone';
import unifiedFinancialService from '../services/unifiedFinancialService.v2.js';
import FinancialDailySnapshot from '../models/FinancialDailySnapshot.js';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';
import Package from '../models/Package.js';

const TIMEZONE = 'America/Sao_Paulo';

// ============================================
// CONFIGURAÇÃO
// ============================================
const ANO = 2026;
const MES = 6; // Junho

// ============================================
// RELATÓRIO
// ============================================
const report = {
    periodo: `${ANO}-${String(MES).padStart(2, '0')}`,
    geradoEm: new Date().toISOString(),
    dias: [],
    edgeCases: {},
    divergencias: [],
    warnings: [],
    resumo: {}
};

function addDivergencia(dia, tipo, esperado, obtido, detalhe) {
    report.divergencias.push({
        dia,
        tipo,
        esperado: typeof esperado === 'number' ? `R$ ${esperado.toFixed(2)}` : esperado,
        obtido: typeof obtido === 'number' ? `R$ ${obtido.toFixed(2)}` : obtido,
        delta: typeof esperado === 'number' && typeof obtido === 'number' ? `R$ ${(esperado - obtido).toFixed(2)}` : 'N/A',
        detalhe
    });
}

function addWarning(dia, tipo, mensagem) {
    report.warnings.push({ dia, tipo, mensagem });
}

// ============================================
// 1. VALIDAÇÃO DIÁRIA (Caixa + Produção + Snapshot)
// ============================================
async function validarDia(dateStr) {
    const start = moment.tz(dateStr, TIMEZONE).startOf('day').toDate();
    const end = moment.tz(dateStr, TIMEZONE).endOf('day').toDate();

    console.log(`\n📅 ${dateStr}`);

    // 1.1 Caixa via unifiedFinancialService (fonte única)
    const cash = await unifiedFinancialService.calculateCash(start, end);

    // 1.2 Produção via unifiedFinancialService (fonte única)
    const production = await unifiedFinancialService.calculateProduction(start, end);

    // 1.3 Snapshot (se existir)
    const snapshot = await FinancialDailySnapshot.findOne({
        clinicId: 'default',
        date: dateStr
    }).lean();

    // 1.4 Validação: Snapshot vs Realtime
    if (snapshot) {
        const snapshotCash = snapshot.cash?.total || 0;
        const snapshotProd = snapshot.production?.total || 0;

        if (Math.abs(snapshotCash - cash.total) > 0.01) {
            addDivergencia(dateStr, 'SNAPSHOT_CASH_DRIFT', cash.total, snapshotCash,
                `Snapshot cash=${snapshotCash} vs Realtime cash=${cash.total}`);
        }
        if (Math.abs(snapshotProd - production.total) > 0.01) {
            addDivergencia(dateStr, 'SNAPSHOT_PROD_DRIFT', production.total, snapshotProd,
                `Snapshot production=${snapshotProd} vs Realtime production=${production.total}`);
        }
    } else {
        addWarning(dateStr, 'SNAPSHOT_MISSING', 'Não existe snapshot para este dia');
    }

    // 1.5 Validação: Produção ≥ Caixa (produção nunca pode ser menor que caixa no mesmo dia? Não necessariamente)
    // Na verdade, caixa pode ser maior (venda de pacote sem consumo)
    // E produção pode ser maior (sessões realizadas sem pagamento)
    // Então não há invariante direto. Mas vamos logar a diferença.

    const diff = production.total - cash.total;
    console.log(`   💰 Caixa: R$ ${cash.total.toFixed(2)} | 🏭 Produção: R$ ${production.total.toFixed(2)} | Δ: R$ ${diff.toFixed(2)}`);

    report.dias.push({
        dia: dateStr,
        caixa: cash.total,
        producao: production.total,
        particular: cash.particular,
        convenio: cash.convenio,
        pacote: cash.pacote,
        liminar: cash.liminar,
        snapshotCash: snapshot?.cash?.total || null,
        snapshotProd: snapshot?.production?.total || null,
        diffProdCash: diff
    });

    return { cash, production, snapshot };
}

// ============================================
// 2. EDGE CASES SEMÂNTICOS
// ============================================
async function validarEdgeCases() {
    console.log('\n\n🔬 VALIDANDO EDGE CASES SEMÂNTICOS\n');

    const startMes = moment.tz([ANO, MES - 1], TIMEZONE).startOf('month').toDate();
    const endMes = moment.tz([ANO, MES - 1], TIMEZONE).endOf('month').toDate();
    const hoje = moment.tz(TIMEZONE).startOf('day').toDate();
    const endAteHoje = moment.min(moment.tz([ANO, MES - 1], TIMEZONE).endOf('month'), moment.tz(TIMEZONE).endOf('day')).toDate();

    // ── 2.1 Pacote Prepaid Consumido ───────────────────────────────
    console.log('📦 2.1 Pacote Prepaid Consumido');
    const pacotesConsumidos = await Session.find({
        date: { $gte: startMes, $lte: endAteHoje },
        status: 'completed',
        package: { $exists: true, $ne: null }
    }).populate('package', 'type paymentType').lean();

    const pacotesPrepaid = pacotesConsumidos.filter(s =>
        s.package?.type === 'prepaid' || s.package?.paymentType === 'full'
    );

    console.log(`   Sessões de pacote prepaid: ${pacotesPrepaid.length}`);

    // Verificar se existe payment package_consumed para essas sessões
    const sessionIds = pacotesPrepaid.map(s => s._id.toString());
    const consumedPayments = await Payment.find({
        session: { $in: sessionIds },
        kind: 'package_consumed'
    }).lean();

    console.log(`   Payments package_consumed: ${consumedPayments.length}`);

    // Verificar se NENHUM desses payments tem status='paid' (devem ser 'consumed')
    const consumedComPaid = consumedPayments.filter(p => p.status === 'paid');
    if (consumedComPaid.length > 0) {
        addDivergencia('EDGE', 'PACKAGE_CONSUMED_WITH_PAID', 0, consumedComPaid.length,
            `${consumedComPaid.length} payments package_consumed com status='paid' (devem ser 'consumed')`);
    }

    // Verificar se NENHUM desses payments tem financialDate (consumo não tem data financeira)
    const consumedComFinancialDate = consumedPayments.filter(p => p.financialDate);
    if (consumedComFinancialDate.length > 0) {
        addDivergencia('EDGE', 'PACKAGE_CONSUMED_WITH_FINANCIAL_DATE', 0, consumedComFinancialDate.length,
            `${consumedComFinancialDate.length} payments package_consumed com financialDate (devem ser null)`);
    }

    report.edgeCases.pacotePrepaid = {
        sessoes: pacotesPrepaid.length,
        payments: consumedPayments.length,
        comStatusPaid: consumedComPaid.length,
        comFinancialDate: consumedComFinancialDate.length
    };

    // ── 2.2 Convênio Realizado Não Recebido ───────────────────────
    console.log('\n🏥 2.2 Convênio Realizado Não Recebido');
    const convenioSessions = await Session.find({
        date: { $gte: startMes, $lte: endAteHoje },
        status: 'completed',
        $or: [
            { paymentMethod: 'convenio' },
            { paymentOrigin: 'convenio' }
        ]
    }).lean();

    const convenioNaoRecebido = [];
    for (const s of convenioSessions) {
        const payment = await Payment.findOne({ session: s._id }).lean();
        if (!payment || payment.status !== 'paid') {
            convenioNaoRecebido.push({
                sessionId: s._id,
                paymentId: payment?._id,
                status: payment?.status || 'sem_payment',
                valor: s.sessionValue || 0
            });
        }
    }

    console.log(`   Sessões convênio: ${convenioSessions.length}`);
    console.log(`   Não recebidas: ${convenioNaoRecebido.length}`);

    report.edgeCases.convenioNaoRecebido = {
        total: convenioSessions.length,
        naoRecebidas: convenioNaoRecebido.length,
        valorTotal: convenioNaoRecebido.reduce((s, x) => s + x.valor, 0)
    };

    // ── 2.3 Particular Pending ────────────────────────────────────
    console.log('\n💳 2.3 Particular Pending');
    const particularPending = await Payment.find({
        status: 'pending',
        billingType: 'particular',
        paymentDate: { $gte: startMes, $lte: endAteHoje }
    }).lean();

    console.log(`   Payments particular pending: ${particularPending.length}`);
    console.log(`   Valor total: R$ ${particularPending.reduce((s, p) => s + p.amount, 0).toFixed(2)}`);

    report.edgeCases.particularPending = {
        count: particularPending.length,
        valorTotal: particularPending.reduce((s, p) => s + p.amount, 0)
    };

    // ── 2.4 Venda de Pacote ───────────────────────────────────────
    console.log('\n🎁 2.4 Venda de Pacote (caixa sem produção)');
    const vendasPacote = await Payment.find({
        status: 'paid',
        kind: 'package_receipt',
        paymentDate: { $gte: startMes, $lte: endAteHoje }
    }).lean();

    console.log(`   Vendas de pacote: ${vendasPacote.length}`);
    console.log(`   Valor total: R$ ${vendasPacote.reduce((s, p) => s + p.amount, 0).toFixed(2)}`);

    report.edgeCases.vendasPacote = {
        count: vendasPacote.length,
        valorTotal: vendasPacote.reduce((s, p) => s + p.amount, 0)
    };

    // ── 2.5 Cancelamentos ─────────────────────────────────────────
    console.log('\n❌ 2.5 Cancelamentos');
    const cancelamentos = await Payment.find({
        status: 'canceled',
        updatedAt: { $gte: startMes, $lte: endAteHoje }
    }).lean();

    console.log(`   Payments cancelados: ${cancelamentos.length}`);

    // Verificar se algum snapshot inclui pagamentos cancelados
    for (const p of cancelamentos) {
        const snapDate = p.financialDate || p.paymentDate;
        if (snapDate) {
            const dateStr = moment(snapDate).tz(TIMEZONE).format('YYYY-MM-DD');
            const snap = await FinancialDailySnapshot.findOne({ date: dateStr }).lean();
            if (snap && snap.processedEvents) {
                const temReversal = snap.processedEvents.some(e => e.includes(p._id.toString()) && e.includes('canceled'));
                if (!temReversal) {
                    addWarning(dateStr, 'CANCELAMENTO_SEM_REVERSAO_SNAPSHOT',
                        `Payment ${p._id} cancelado mas snapshot ${dateStr} não tem evento de reversão`);
                }
            }
        }
    }

    report.edgeCases.cancelamentos = {
        count: cancelamentos.length
    };

    // ── 2.6 Partial Payments ──────────────────────────────────────
    console.log('\n💰 2.6 Partial Payments');
    const partials = await Payment.find({
        status: 'partial',
        updatedAt: { $gte: startMes, $lte: endAteHoje }
    }).lean();

    console.log(`   Payments parciais: ${partials.length}`);
    for (const p of partials) {
        console.log(`     ${p._id}: amount=${p.amount} receivedAmount=${p.receivedAmount || 0}`);
    }

    report.edgeCases.partialPayments = {
        count: partials.length,
        detalhes: partials.map(p => ({
            id: p._id.toString(),
            amount: p.amount,
            received: p.receivedAmount || 0
        }))
    };
}

// ============================================
// 3. RESUMO E RELATÓRIO
// ============================================
function gerarResumo() {
    const dias = report.dias;
    const totalCaixa = dias.reduce((s, d) => s + d.caixa, 0);
    const totalProducao = dias.reduce((s, d) => s + d.producao, 0);
    const totalSnapshotCash = dias.filter(d => d.snapshotCash !== null).reduce((s, d) => s + d.snapshotCash, 0);
    const totalSnapshotProd = dias.filter(d => d.snapshotProd !== null).reduce((s, d) => s + d.snapshotProd, 0);

    report.resumo = {
        diasAuditados: dias.length,
        totalCaixa,
        totalProducao,
        totalSnapshotCash,
        totalSnapshotProd,
        divergenciasSnapshot: report.divergencias.filter(d => d.tipo.startsWith('SNAPSHOT')).length,
        warnings: report.warnings.length,
        divergenciasCriticas: report.divergencias.filter(d => !d.tipo.startsWith('SNAPSHOT')).length
    };

    console.log('\n\n' + '='.repeat(60));
    console.log('📊 RESUMO DA AUDITORIA');
    console.log('='.repeat(60));
    console.log(`Dias auditados: ${dias.length}`);
    console.log(`Total Caixa: R$ ${totalCaixa.toFixed(2)}`);
    console.log(`Total Produção: R$ ${totalProducao.toFixed(2)}`);
    console.log(`Total Snapshot Cash: R$ ${totalSnapshotCash.toFixed(2)}`);
    console.log(`Total Snapshot Prod: R$ ${totalSnapshotProd.toFixed(2)}`);
    console.log(`Divergências Snapshot: ${report.resumo.divergenciasSnapshot}`);
    console.log(`Warnings: ${report.resumo.warnings}`);
    console.log(`Divergências Críticas: ${report.resumo.divergenciasCriticas}`);
}

// ============================================
// MAIN
// ============================================
async function main() {
    console.log('🔍 AUDITORIA OPERACIONAL — JUNHO 2026');
    console.log('Conectando ao MongoDB...');

    const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/fono_inova_prod?retryWrites=true&w=majority&appName=Cluster0';
    await mongoose.connect(MONGO_URI);
    console.log('✅ Conectado');

    // Gerar todos os dias do mês até hoje
    const hoje = moment.tz(TIMEZONE);
    const ultimoDia = Math.min(hoje.date(), moment.tz([ANO, MES - 1], TIMEZONE).endOf('month').date());

    for (let dia = 1; dia <= ultimoDia; dia++) {
        const dateStr = `${ANO}-${String(MES).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
        await validarDia(dateStr);
    }

    await validarEdgeCases();
    gerarResumo();

    // Salvar relatório
    const fs = await import('fs');
    const reportPath = `./scripts/reports/operational-audit-${ANO}-${String(MES).padStart(2, '0')}.json`;
    fs.mkdirSync('./scripts/reports', { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n📁 Relatório salvo em: ${reportPath}`);

    await mongoose.disconnect();
    console.log('\n✅ Auditoria concluída');
}

main().catch(err => {
    console.error('❌ Erro na auditoria:', err);
    process.exit(1);
});
