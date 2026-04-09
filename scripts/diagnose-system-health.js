// 🔍 Diagnóstico Completo do Sistema
// Verifica inconsistências entre Session, Appointment, Balance e Package

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import PatientBalance from '../models/PatientBalance.js';
import Package from '../models/Package.js';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';

async function diagnose() {
    console.log('========================================');
    console.log('🔍 DIAGNÓSTICO DE SAÚDE DO SISTEMA');
    console.log('========================================\n');

    await mongoose.connect(MONGO_URI);
    console.log('✅ Conectado ao MongoDB\n');

    const issues = [];
    const stats = {};

    // ============================================
    // 1. VERIFICAR SESSIONS SEM APPOINTMENT
    // ============================================
    console.log('📊 1. Verificando Sessions sem Appointment...');
    
    const sessionsWithoutAppointment = await Session.find({
        $or: [
            { appointmentId: { $exists: false } },
            { appointmentId: null }
        ],
        status: { $ne: 'canceled' }
    }).limit(100);

    stats.sessionsWithoutAppointment = sessionsWithoutAppointment.length;
    
    if (sessionsWithoutAppointment.length > 0) {
        issues.push({
            severity: 'HIGH',
            type: 'SESSION_WITHOUT_APPOINTMENT',
            count: sessionsWithoutAppointment.length,
            message: `${sessionsWithoutAppointment.length} sessions ativas sem appointmentId`,
            sample: sessionsWithoutAppointment.slice(0, 3).map(s => ({
                id: s._id,
                date: s.date,
                patient: s.patient,
                status: s.status
            }))
        });
        console.log(`   ❌ ${sessionsWithoutAppointment.length} problemas encontrados`);
    } else {
        console.log('   ✅ Todas as sessions têm appointmentId');
    }

    // ============================================
    // 2. VERIFICAR APPOINTMENTS SEM SESSION
    // ============================================
    console.log('\n📊 2. Verificando Appointments sem Session...');
    
    const appointmentsWithoutSession = await Appointment.find({
        $or: [
            { session: { $exists: false } },
            { session: null }
        ],
        operationalStatus: { $ne: 'canceled' }
    }).limit(100);

    stats.appointmentsWithoutSession = appointmentsWithoutSession.length;

    if (appointmentsWithoutSession.length > 0) {
        issues.push({
            severity: 'HIGH',
            type: 'APPOINTMENT_WITHOUT_SESSION',
            count: appointmentsWithoutSession.length,
            message: `${appointmentsWithoutSession.length} appointments ativos sem session`,
            sample: appointmentsWithoutSession.slice(0, 3).map(a => ({
                id: a._id,
                date: a.date,
                patient: a.patient,
                specialty: a.specialty
            }))
        });
        console.log(`   ❌ ${appointmentsWithoutSession.length} problemas encontrados`);
    } else {
        console.log('   ✅ Todos os appointments têm session');
    }

    // ============================================
    // 3. VERIFICAR INCONSISTÊNCIA DE ESPECIALIDADE
    // ============================================
    console.log('\n📊 3. Verificando inconsistência de specialty...');
    
    const mismatchedSpecialties = await Session.aggregate([
        {
            $lookup: {
                from: 'appointments',
                localField: 'appointmentId',
                foreignField: '_id',
                as: 'appointment'
            }
        },
        {
            $match: {
                'appointment.0': { $exists: true },
                $expr: {
                    $ne: ['$sessionType', { $arrayElemAt: ['$appointment.specialty', 0] }]
                }
            }
        },
        { $limit: 50 }
    ]);

    stats.mismatchedSpecialties = mismatchedSpecialties.length;

    if (mismatchedSpecialties.length > 0) {
        issues.push({
            severity: 'MEDIUM',
            type: 'MISMATCHED_SPECIALTY',
            count: mismatchedSpecialties.length,
            message: `${mismatchedSpecialties.length} sessions com specialty diferente do appointment`,
            sample: mismatchedSpecialties.slice(0, 3).map(s => ({
                sessionId: s._id,
                sessionType: s.sessionType,
                appointmentSpecialty: s.appointment[0]?.specialty
            }))
        });
        console.log(`   ⚠️  ${mismatchedSpecialties.length} inconsistências encontradas`);
    } else {
        console.log('   ✅ Todas as specialties estão consistentes');
    }

    // ============================================
    // 4. VERIFICAR DÉBITOS SEM SPECIALTY
    // ============================================
    console.log('\n📊 4. Verificando débitos sem specialty...');
    
    const debitsWithoutSpecialty = await PatientBalance.aggregate([
        { $unwind: '$transactions' },
        {
            $match: {
                'transactions.type': 'debit',
                $or: [
                    { 'transactions.specialty': { $exists: false } },
                    { 'transactions.specialty': null },
                    { 'transactions.specialty': '' }
                ]
            }
        },
        { $limit: 100 }
    ]);

    stats.debitsWithoutSpecialty = debitsWithoutSpecialty.length;

    if (debitsWithoutSpecialty.length > 0) {
        issues.push({
            severity: 'HIGH',
            type: 'DEBIT_WITHOUT_SPECIALTY',
            count: debitsWithoutSpecialty.length,
            message: `${debitsWithoutSpecialty.length} débitos sem specialty (não aparecem no modal)`,
            sample: debitsWithoutSpecialty.slice(0, 3).map(d => ({
                patientId: d.patient,
                transactionId: d.transactions._id,
                amount: d.transactions.amount
            }))
        });
        console.log(`   ❌ ${debitsWithoutSpecialty.length} problemas encontrados`);
    } else {
        console.log('   ✅ Todos os débitos têm specialty');
    }

    // ============================================
    // 5. VERIFICAR DÉBITOS DUPLICADOS
    // ============================================
    console.log('\n📊 5. Verificando débitos duplicados...');
    
    const duplicateDebits = await PatientBalance.aggregate([
        { $unwind: '$transactions' },
        { $match: { 'transactions.type': 'debit' } },
        {
            $group: {
                _id: '$transactions.appointmentId',
                count: { $sum: 1 },
                transactions: { $push: '$transactions._id' }
            }
        },
        { $match: { _id: { $ne: null }, count: { $gt: 1 } } },
        { $limit: 50 }
    ]);

    stats.duplicateDebits = duplicateDebits.length;

    if (duplicateDebits.length > 0) {
        issues.push({
            severity: 'CRITICAL',
            type: 'DUPLICATE_DEBIT',
            count: duplicateDebits.reduce((sum, d) => sum + d.count - 1, 0),
            message: `${duplicateDebits.length} appointments com débitos duplicados`,
            sample: duplicateDebits.slice(0, 3)
        });
        console.log(`   🔴 ${duplicateDebits.length} duplicidades encontradas`);
    } else {
        console.log('   ✅ Nenhum débito duplicado');
    }

    // ============================================
    // 6. VERIFICAR PACKAGES SEM SESSIONS
    // ============================================
    console.log('\n📊 6. Verificando Packages sem Sessions...');
    
    const packagesWithoutSessions = await Package.find({
        $or: [
            { sessions: { $exists: false } },
            { sessions: { $size: 0 } }
        ],
        status: { $ne: 'canceled' }
    }).limit(50);

    stats.packagesWithoutSessions = packagesWithoutSessions.length;

    if (packagesWithoutSessions.length > 0) {
        issues.push({
            severity: 'MEDIUM',
            type: 'PACKAGE_WITHOUT_SESSIONS',
            count: packagesWithoutSessions.length,
            message: `${packagesWithoutSessions.length} packages sem sessions`,
            sample: packagesWithoutSessions.slice(0, 3).map(p => ({
                id: p._id,
                patient: p.patient,
                totalSessions: p.totalSessions
            }))
        });
        console.log(`   ⚠️  ${packagesWithoutSessions.length} problemas encontrados`);
    } else {
        console.log('   ✅ Todos os packages têm sessions');
    }

    // ============================================
    // 7. ESTATÍSTICAS GERAIS
    // ============================================
    console.log('\n📊 7. Estatísticas Gerais...');
    
    stats.totalSessions = await Session.countDocuments();
    stats.totalAppointments = await Appointment.countDocuments();
    stats.totalPackages = await Package.countDocuments();
    stats.totalBalances = await PatientBalance.countDocuments();
    stats.totalDebitTransactions = await PatientBalance.aggregate([
        { $unwind: '$transactions' },
        { $match: { 'transactions.type': 'debit' } },
        { $count: 'total' }
    ]).then(r => r[0]?.total || 0);

    console.log(`   Sessions: ${stats.totalSessions.toLocaleString()}`);
    console.log(`   Appointments: ${stats.totalAppointments.toLocaleString()}`);
    console.log(`   Packages: ${stats.totalPackages.toLocaleString()}`);
    console.log(`   Balances: ${stats.totalBalances.toLocaleString()}`);
    console.log(`   Débitos: ${stats.totalDebitTransactions.toLocaleString()}`);

    // ============================================
    // RELATÓRIO FINAL
    // ============================================
    console.log('\n========================================');
    console.log('📋 RELATÓRIO DE SAÚDE DO SISTEMA');
    console.log('========================================');

    const critical = issues.filter(i => i.severity === 'CRITICAL');
    const high = issues.filter(i => i.severity === 'HIGH');
    const medium = issues.filter(i => i.severity === 'MEDIUM');

    console.log(`\n🔴 Críticos: ${critical.length}`);
    console.log(`❌ Altos: ${high.length}`);
    console.log(`⚠️  Médios: ${medium.length}`);

    if (issues.length > 0) {
        console.log('\n📋 Detalhes dos Problemas:');
        issues.forEach((issue, idx) => {
            const icon = issue.severity === 'CRITICAL' ? '🔴' : 
                        issue.severity === 'HIGH' ? '❌' : '⚠️';
            console.log(`\n${icon} [${issue.severity}] ${issue.type}`);
            console.log(`   ${issue.message}`);
            if (issue.sample) {
                console.log(`   Amostra:`, JSON.stringify(issue.sample, null, 2));
            }
        });
    }

    console.log('\n========================================');
    console.log('✅ Diagnóstico concluído!');
    console.log('========================================');

    // Salvar relatório
    const report = {
        timestamp: new Date(),
        stats,
        issues,
        summary: {
            totalIssues: issues.length,
            critical: critical.length,
            high: high.length,
            medium: medium.length
        }
    };

    console.log('\n💡 Próximos passos:');
    if (critical.length > 0) {
        console.log('   1. 🔴 CORRIGIR PROBLEMAS CRÍTICOS IMEDIATAMENTE');
    }
    if (high.length > 0) {
        console.log('   2. ❌ Executar script de reconciliação');
    }
    console.log('   3. 🛡️ Adicionar unique indexes');
    console.log('   4. 🧪 Rodar testes E2E');

    await mongoose.disconnect();
    process.exit(0);
}

diagnose().catch(err => {
    console.error('💥 Erro no diagnóstico:', err);
    process.exit(1);
});
