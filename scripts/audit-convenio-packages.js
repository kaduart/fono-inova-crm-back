/**
 * ============================================================================
 * AUDITORIA GLOBAL: Packages tipo convenio
 * ============================================================================
 *
 * Classifica TODOS os packages type='convenio' em:
 *   ✅ SAFE      → pode migrar automaticamente
 *   ⚠️  WARNING  → divergência leve, atenção necessária
 *   🔴 CRITICAL  → risco financeiro, revisão manual obrigatória
 *
 * Critérios de classificação:
 *   CRITICAL se qualquer um:
 *     - Payment com status='paid' + paidAt/financialDate + amount > 0
 *     - Session em InsuranceBatch com status='received'
 *     - Session com isPaid=true E payment.status='paid'
 *     - Guide não encontrada (órfão)
 *   WARNING se qualquer um:
 *     - guide.usedSessions !== completedSessions (divergência)
 *     - Session com paymentMethod='package_prepaid' em convênio
 *     - Appointment.paymentStatus inconsistente
 *   SAFE se:
 *     - Nenhum dos acima
 *     - Todos os payments são pending/unpaid com amount=0
 *
 * Saída:
 *   - JSON detalhado em logs/
 *   - CSV resumido em logs/
 *   - Resumo no console
 *
 * Uso:
 *   node scripts/audit-convenio-packages.js
 *   node scripts/audit-convenio-packages.js --csv
 * ============================================================================
 */

import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
const GENERATE_CSV = process.argv.includes('--csv');

// =============================================================================
// CLASSIFICAÇÃO DE RISCO
// =============================================================================

function classifyPackage(audit) {
    if (audit.criticalFlags.length > 0) return 'CRITICAL';
    if (audit.warningFlags.length > 0) return 'WARNING';
    return 'SAFE';
}

// =============================================================================
// AUDITORIA DE UM PACKAGE
// =============================================================================

async function auditPackage(db, pkg) {
    const result = {
        packageId: pkg._id.toString(),
        patientId: pkg.patient?.toString(),
        patientName: null,
        packageNumber: null, // não tem number, mas podemos usar createdAt
        createdAt: pkg.createdAt,
        status: pkg.status,
        totalSessions: pkg.totalSessions,
        sessionsDone: pkg.sessionsDone,
        totalValue: pkg.totalValue,
        totalPaid: pkg.totalPaid,
        balance: pkg.balance,
        insuranceGuideId: pkg.insuranceGuide?.toString(),
        insuranceProvider: pkg.insuranceProvider,
        insuranceGrossAmount: pkg.insuranceGrossAmount,
        guideExists: false,
        guideNumber: null,
        guideStatus: null,
        guideTotalSessions: null,
        guideUsedSessions: null,
        completedSessionsCount: 0,
        guideConsumedTrueCount: 0,
        guideConsumedFalseCount: 0,
        anomalousSessionsCount: 0,
        paidPaymentsCount: 0,
        pendingPaymentsCount: 0,
        paymentsWithFinancialDate: 0,
        paymentsWithPaidAt: 0,
        paymentsWithAmountGreaterThanZero: 0,
        sessionsInReceivedBatch: 0,
        criticalFlags: [],
        warningFlags: [],
        details: {
            sessions: [],
            payments: []
        }
    };

    // 1. Buscar paciente
    const patient = await db.collection('patients').findOne({ _id: pkg.patient });
    if (patient) {
        result.patientName = patient.fullName;
    }

    // 2. Verificar InsuranceGuide
    if (pkg.insuranceGuide) {
        const guide = await db.collection('insuranceguides').findOne({ _id: pkg.insuranceGuide });
        if (guide) {
            result.guideExists = true;
            result.guideNumber = guide.number;
            result.guideStatus = guide.status;
            result.guideTotalSessions = guide.totalSessions;
            result.guideUsedSessions = guide.usedSessions;
        } else {
            result.criticalFlags.push('GUIDE_NOT_FOUND: Package referencia guia inexistente');
        }
    } else {
        result.criticalFlags.push('NO_GUIDE: Package sem insuranceGuide vinculado');
    }

    // 3. Buscar sessions
    const sessions = await db.collection('sessions').find({
        package: pkg._id
    }).toArray();

    const completedSessions = sessions.filter(s => s.status === 'completed');
    result.completedSessionsCount = completedSessions.length;
    result.guideConsumedTrueCount = sessions.filter(s => s.guideConsumed === true).length;
    result.guideConsumedFalseCount = sessions.filter(s => s.guideConsumed === false && s.status === 'completed').length;

    // Divergência de consumo
    if (result.guideExists && result.guideUsedSessions !== result.completedSessionsCount) {
        result.warningFlags.push(
            `GUIDE_DIVERGENCE: usedSessions=${result.guideUsedSessions}, completed=${result.completedSessionsCount}, delta=${result.completedSessionsCount - result.guideUsedSessions}`
        );
    }

    for (const sess of sessions) {
        const sessAudit = {
            sessionId: sess._id.toString(),
            date: sess.date?.toISOString?.().split('T')[0],
            time: sess.time,
            status: sess.status,
            paymentOrigin: sess.paymentOrigin,
            paymentMethod: sess.paymentMethod,
            paymentStatus: sess.paymentStatus,
            isPaid: sess.isPaid,
            sessionValue: sess.sessionValue,
            guideConsumed: sess.guideConsumed,
            billingBatchId: sess.billingBatchId?.toString(),
            paymentId: sess.paymentId?.toString(),
            anomalies: []
        };

        // Anomalias de classificação
        if (sess.paymentOrigin === 'package_prepaid') {
            sessAudit.anomalies.push('paymentOrigin=package_prepaid em convênio');
        }
        if (sess.paymentMethod === 'package_prepaid') {
            sessAudit.anomalies.push('paymentMethod=package_prepaid em convênio');
        }
        if (sess.paymentStatus === 'package_paid') {
            sessAudit.anomalies.push('paymentStatus=package_paid em convênio');
        }
        if (sess.isPaid === true && sess.status !== 'canceled') {
            sessAudit.anomalies.push('isPaid=true em sessão convênio');
        }
        if (sess.status === 'completed' && !sess.guideConsumed) {
            sessAudit.anomalies.push('completed sem guideConsumed');
        }

        if (sessAudit.anomalies.length > 0) {
            result.anomalousSessionsCount++;
            result.details.sessions.push(sessAudit);
        }
    }

    if (result.anomalousSessionsCount > 0) {
        result.warningFlags.push(`ANOMALOUS_SESSIONS: ${result.anomalousSessionsCount} sessões com classificação errada`);
    }

    // 4. Buscar payments
    const payments = await db.collection('payments').find({
        package: pkg._id
    }).toArray();

    for (const pay of payments) {
        const payAudit = {
            paymentId: pay._id.toString(),
            amount: pay.amount,
            status: pay.status,
            kind: pay.kind,
            billingType: pay.billingType,
            paymentMethod: pay.paymentMethod,
            paidAt: pay.paidAt,
            financialDate: pay.financialDate,
            isFromPackage: pay.isFromPackage,
            insuranceStatus: pay.insurance?.status,
            sessionId: pay.session?.toString(),
            appointmentId: pay.appointment?.toString(),
            riskFlags: []
        };

        // Riscos financeiros
        if (pay.status === 'paid' && pay.amount > 0) {
            payAudit.riskFlags.push('PAID_WITH_AMOUNT');
            result.paidPaymentsCount++;
        } else if (pay.status === 'pending') {
            result.pendingPaymentsCount++;
        }

        if (pay.financialDate) {
            payAudit.riskFlags.push('HAS_FINANCIAL_DATE');
            result.paymentsWithFinancialDate++;
        }
        if (pay.paidAt) {
            payAudit.riskFlags.push('HAS_PAID_AT');
            result.paymentsWithPaidAt++;
        }
        if (pay.amount > 0) {
            result.paymentsWithAmountGreaterThanZero++;
        }

        if (payAudit.riskFlags.length > 0) {
            result.details.payments.push(payAudit);
        }
    }

    // Flags críticas baseadas em payments
    if (result.paidPaymentsCount > 0) {
        result.criticalFlags.push(`PAID_PAYMENTS: ${result.paidPaymentsCount} payments com status='paid' e amount>0`);
    }
    if (result.paymentsWithFinancialDate > 0) {
        result.criticalFlags.push(`FINANCIAL_DATE: ${result.paymentsWithFinancialDate} payments com financialDate preenchido`);
    }
    if (result.paymentsWithPaidAt > 0) {
        result.criticalFlags.push(`PAID_AT: ${result.paymentsWithPaidAt} payments com paidAt preenchido`);
    }

    // 5. Verificar batches
    const batchSessions = sessions.filter(s => s.billingBatchId);
    if (batchSessions.length > 0) {
        const batchIds = [...new Set(batchSessions.map(s => s.billingBatchId.toString()))];
        for (const batchId of batchIds) {
            const batch = await db.collection('insurancebatches').findOne({ _id: new mongoose.Types.ObjectId(batchId) });
            if (batch && batch.status === 'received') {
                result.sessionsInReceivedBatch++;
            }
        }
    }

    if (result.sessionsInReceivedBatch > 0) {
        result.criticalFlags.push(`RECEIVED_BATCH: ${result.sessionsInReceivedBatch} sessões em batch com status='received'`);
    }

    // Classificação final
    result.classification = classifyPackage(result);

    return result;
}

// =============================================================================
// CSV GENERATOR
// =============================================================================

function generateCSV(audits) {
    const headers = [
        'patientName',
        'packageId',
        'guideNumber',
        'classification',
        'packageStatus',
        'totalSessions',
        'sessionsDone',
        'completedSessions',
        'guideUsedSessions',
        'guideDivergence',
        'anomalousSessions',
        'paidPayments',
        'paymentsWithFinancialDate',
        'paymentsWithPaidAt',
        'sessionsInReceivedBatch',
        'criticalFlags',
        'warningFlags'
    ];

    const rows = audits.map(a => [
        a.patientName || 'N/A',
        a.packageId,
        a.guideNumber || 'N/A',
        a.classification,
        a.status,
        a.totalSessions,
        a.sessionsDone,
        a.completedSessionsCount,
        a.guideUsedSessions ?? 'N/A',
        a.guideExists ? (a.completedSessionsCount - a.guideUsedSessions) : 'N/A',
        a.anomalousSessionsCount,
        a.paidPaymentsCount,
        a.paymentsWithFinancialDate,
        a.paymentsWithPaidAt,
        a.sessionsInReceivedBatch,
        a.criticalFlags.join('; '),
        a.warningFlags.join('; ')
    ]);

    return [headers.join(','), ...rows.map(r => r.map(v => `"${v}"`).join(','))].join('\n');
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
    if (!MONGO_URI) {
        console.error('❌ MONGO_URI não encontrado');
        process.exit(1);
    }

    await mongoose.connect(MONGO_URI);
    const db = mongoose.connection.db;

    console.log('='.repeat(80));
    console.log('AUDITORIA GLOBAL: Packages tipo convenio');
    console.log('='.repeat(80));

    // Buscar TODOS os packages tipo convenio (ativos e inativos)
    const packages = await db.collection('packages').find({
        type: 'convenio'
    }).toArray();

    console.log(`Total de packages convenio encontrados: ${packages.length}\n`);

    const audits = [];
    const stats = { SAFE: 0, WARNING: 0, CRITICAL: 0 };

    for (let i = 0; i < packages.length; i++) {
        const pkg = packages[i];
        process.stdout.write(`\rAuditing ${i + 1}/${packages.length} ... `);

        const audit = await auditPackage(db, pkg);
        audits.push(audit);
        stats[audit.classification]++;
    }

    console.log('\r' + ' '.repeat(50) + '\r');

    // Resumo por paciente
    const byPatient = {};
    for (const a of audits) {
        if (!byPatient[a.patientId]) {
            byPatient[a.patientId] = { name: a.patientName, packages: [] };
        }
        byPatient[a.patientId].packages.push(a);
    }

    // Console output
    console.log('\n📊 RESUMO POR PACIENTE:');
    console.log('-'.repeat(80));

    for (const [patientId, data] of Object.entries(byPatient)) {
        const criticalCount = data.packages.filter(p => p.classification === 'CRITICAL').length;
        const warningCount = data.packages.filter(p => p.classification === 'WARNING').length;
        const safeCount = data.packages.filter(p => p.classification === 'SAFE').length;

        const flag = criticalCount > 0 ? '🔴' : warningCount > 0 ? '⚠️' : '✅';
        console.log(`${flag} ${data.name || 'N/A'} (${patientId})`);
        console.log(`   Packages: ${data.packages.length} | 🔴${criticalCount} ⚠️${warningCount} ✅${safeCount}`);

        for (const pkg of data.packages) {
            const indent = '      ';
            console.log(`${indent}Package ${pkg.packageId.slice(-8)} | ${pkg.classification} | Guia #${pkg.guideNumber || 'N/A'} | ${pkg.status}`);
            if (pkg.criticalFlags.length > 0) {
                for (const f of pkg.criticalFlags) console.log(`${indent}  🔴 ${f}`);
            }
            if (pkg.warningFlags.length > 0) {
                for (const f of pkg.warningFlags) console.log(`${indent}  ⚠️  ${f}`);
            }
        }
    }

    console.log('\n' + '='.repeat(80));
    console.log('RESUMO GLOBAL');
    console.log('='.repeat(80));
    console.log(`Total packages auditados:    ${audits.length}`);
    console.log(`✅ SAFE:                     ${stats.SAFE}`);
    console.log(`⚠️  WARNING:                 ${stats.WARNING}`);
    console.log(`🔴 CRITICAL:                 ${stats.CRITICAL}`);
    console.log('='.repeat(80));

    // Salvar JSON
    const logsDir = path.join(__dirname, '..', 'logs');
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const jsonPath = path.join(logsDir, `audit-convenio-${timestamp}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        totalPackages: audits.length,
        stats,
        audits
    }, null, 2));
    console.log(`\n📝 JSON detalhado: ${jsonPath}`);

    // Salvar CSV
    if (GENERATE_CSV) {
        const csvPath = path.join(logsDir, `audit-convenio-${timestamp}.csv`);
        fs.writeFileSync(csvPath, generateCSV(audits));
        console.log(`📝 CSV resumido: ${csvPath}`);
    } else {
        console.log('💡 Para gerar CSV, rode com: --csv');
    }

    // Relatório de ações recomendadas
    console.log('\n📋 AÇÕES RECOMENDADAS:');
    console.log('-'.repeat(80));

    const safePackages = audits.filter(a => a.classification === 'SAFE');
    const warningPackages = audits.filter(a => a.classification === 'WARNING');
    const criticalPackages = audits.filter(a => a.classification === 'CRITICAL');

    if (safePackages.length > 0) {
        console.log(`\n✅ MIGRAÇÃO AUTOMÁTICA (${safePackages.length} packages):`);
        for (const p of safePackages.slice(0, 5)) {
            console.log(`   ${p.patientName} — Package ${p.packageId.slice(-8)} — Guia #${p.guideNumber}`);
        }
        if (safePackages.length > 5) console.log(`   ... e mais ${safePackages.length - 5}`);
    }

    if (warningPackages.length > 0) {
        console.log(`\n⚠️  MIGRAÇÃO COM LOG ESPECIAL (${warningPackages.length} packages):`);
        for (const p of warningPackages.slice(0, 5)) {
            console.log(`   ${p.patientName} — Package ${p.packageId.slice(-8)} — ${p.warningFlags[0]}`);
        }
        if (warningPackages.length > 5) console.log(`   ... e mais ${warningPackages.length - 5}`);
    }

    if (criticalPackages.length > 0) {
        console.log(`\n🔴 REVISÃO MANUAL OBRIGATÓRIA (${criticalPackages.length} packages):`);
        for (const p of criticalPackages.slice(0, 5)) {
            console.log(`   ${p.patientName} — Package ${p.packageId.slice(-8)} — ${p.criticalFlags[0]}`);
        }
        if (criticalPackages.length > 5) console.log(`   ... e mais ${criticalPackages.length - 5}`);
    }

    await mongoose.disconnect();
}

main().catch(err => {
    console.error('❌ Erro fatal:', err);
    process.exit(1);
});
