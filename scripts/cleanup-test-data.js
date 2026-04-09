// 🧹 Script de Limpeza Segura - Remove dados de teste
// USO: DRY_RUN=false node cleanup-test-data.js
// CRITÉRIOS DE TESTE:
// - amount = 0 em débitos
// - sessions sem appointmentId E date < 30 dias
// - appointments sem session E date < 30 dias

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import PatientBalance from '../models/PatientBalance.js';

dotenv.config();

const DRY_RUN = process.env.DRY_RUN !== 'false';
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';

// Critérios para identificar dados de teste
const TEST_CRITERIA = {
    // Débitos com valor zero são considerados teste
    zeroAmountDebits: true,
    // Sessions criadas há mais de X dias sem appointment
    orphanSessionMaxAge: 30, // dias
    // Appointments criados há mais de X dias sem session
    orphanAppointmentMaxAge: 30 // dias
};

async function cleanup() {
    console.log('========================================');
    console.log('🧹 LIMPEZA DE DADOS DE TESTE');
    console.log(`📋 MODO: ${DRY_RUN ? 'DRY RUN (visualização)' : 'EXECUÇÃO REAL'}`);
    console.log('========================================\n');

    await mongoose.connect(MONGO_URI);
    console.log('✅ Conectado ao MongoDB\n');

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - TEST_CRITERIA.orphanSessionMaxAge);

    let stats = {
        zeroDebits: { found: 0, marked: 0 },
        orphanSessions: { found: 0, marked: 0 },
        orphanAppointments: { found: 0, marked: 0 }
    };

    // ============================================
    // 1. MARCAR DÉBITOS COM VALOR ZERO COMO TESTE
    // ============================================
    console.log('🔍 1. Identificando débitos com valor zero...');

    const balancesWithZeroDebits = await PatientBalance.find({
        'transactions.type': 'debit',
        'transactions.amount': 0
    });

    for (const balance of balancesWithZeroDebits) {
        let changed = false;

        for (const t of balance.transactions) {
            if (t.type === 'debit' && t.amount === 0 && !t.isDeleted) {
                stats.zeroDebits.found++;
                console.log(`   [TESTE] Débito R$ 0,00 - Patient: ${balance.patient}, Tx: ${t._id}`);

                if (!DRY_RUN) {
                    t.isDeleted = true;
                    t.deletedAt = new Date();
                    t.deleteReason = 'cleanup-test-data: zero amount';
                    changed = true;
                }
                stats.zeroDebits.marked++;
            }
        }

        if (changed && !DRY_RUN) {
            await balance.save();
        }
    }

    console.log(`   ${stats.zeroDebits.found} débitos R$ 0,00 encontrados\n`);

    // ============================================
    // 2. MARCAR SESSIONS ÓRFÃS ANTIGAS COMO TESTE
    // ============================================
    console.log('🔍 2. Identificando sessions órfãs antigas...');

    const orphanSessions = await Session.find({
        $or: [
            { appointmentId: { $exists: false } },
            { appointmentId: null }
        ],
        createdAt: { $lt: cutoffDate },
        isDeleted: { $ne: true }
    }).limit(1000);

    stats.orphanSessions.found = orphanSessions.length;

    for (const session of orphanSessions) {
        console.log(`   [TESTE] Session órfã - ID: ${session._id}, Date: ${session.date}, Patient: ${session.patient}`);

        if (!DRY_RUN) {
            session.isDeleted = true;
            session.deletedAt = new Date();
            session.deleteReason = 'cleanup-test-data: orphan session';
            await session.save();
        }
        stats.orphanSessions.marked++;
    }

    console.log(`   ${stats.orphanSessions.found} sessions órfãs encontradas\n`);

    // ============================================
    // 3. MARCAR APPOINTMENTS ÓRFÃOS ANTIGOS COMO TESTE
    // ============================================
    console.log('🔍 3. Identificando appointments órfãos antigos...');

    const orphanAppointments = await Appointment.find({
        $or: [
            { session: { $exists: false } },
            { session: null }
        ],
        createdAt: { $lt: cutoffDate },
        isDeleted: { $ne: true }
    }).limit(1000);

    stats.orphanAppointments.found = orphanAppointments.length;

    for (const appt of orphanAppointments) {
        console.log(`   [TESTE] Appointment órfão - ID: ${appt._id}, Date: ${appt.date}, Patient: ${appt.patient}`);

        if (!DRY_RUN) {
            appt.isDeleted = true;
            appt.deletedAt = new Date();
            appt.deleteReason = 'cleanup-test-data: orphan appointment';
            await appt.save();
        }
        stats.orphanAppointments.marked++;
    }

    console.log(`   ${stats.orphanAppointments.found} appointments órfãos encontrados\n`);

    // ============================================
    // RELATÓRIO FINAL
    // ============================================
    console.log('========================================');
    console.log('📊 RELATÓRIO DE LIMPEZA');
    console.log('========================================');
    console.log(`Débitos R$ 0,00: ${stats.zeroDebits.found} encontrados, ${stats.zeroDebits.marked} marcados`);
    console.log(`Sessions órfãs: ${stats.orphanSessions.found} encontradas, ${stats.orphanSessions.marked} marcadas`);
    console.log(`Appointments órfãos: ${stats.orphanAppointments.found} encontrados, ${stats.orphanAppointments.marked} marcados`);
    console.log(`TOTAL: ${stats.zeroDebits.marked + stats.orphanSessions.marked + stats.orphanAppointments.marked} itens marcados como teste`);

    if (DRY_RUN) {
        console.log('\n⚠️  DRY RUN - Nenhuma alteração foi salva!');
        console.log('   Para executar de verdade:');
        console.log('   DRY_RUN=false node cleanup-test-data.js');
    } else {
        console.log('\n💾 Alterações salvas!');
        console.log('\n📝 NOTA: Os dados foram marcados como deleted (soft delete)');
        console.log('   Para restaurar, use o campo isDeleted: false');
    }

    await mongoose.disconnect();
    console.log('\n👋 Done!');
    process.exit(0);
}

cleanup().catch(err => {
    console.error('💥 Erro:', err);
    process.exit(1);
});
