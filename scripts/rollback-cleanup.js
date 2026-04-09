// 🔄 Rollback da Limpeza - Restaura dados marcados como teste
// USO: node rollback-cleanup.js

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import PatientBalance from '../models/PatientBalance.js';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';

async function rollback() {
    console.log('========================================');
    console.log('🔄 ROLLBACK DA LIMPEZA');
    console.log('Restaurando dados marcados como teste');
    console.log('========================================\n');

    await mongoose.connect(MONGO_URI);
    console.log('✅ Conectado ao MongoDB\n');

    let stats = {
        debits: 0,
        sessions: 0,
        appointments: 0
    };

    // ============================================
    // 1. RESTAURAR DÉBITOS MARCADOS
    // ============================================
    console.log('🔄 1. Restaurando débitos marcados...');

    const balances = await PatientBalance.find({
        'transactions.deleteReason': /^cleanup-test-data/
    });

    for (const balance of balances) {
        let changed = false;

        for (const t of balance.transactions) {
            if (t.deleteReason && t.deleteReason.startsWith('cleanup-test-data')) {
                t.isDeleted = false;
                t.deletedAt = null;
                t.deleteReason = null;
                changed = true;
                stats.debits++;
                console.log(`   ✅ Restaurado: ${t._id}`);
            }
        }

        if (changed) {
            await balance.save();
        }
    }

    console.log(`   ${stats.debits} débitos restaurados\n`);

    // ============================================
    // 2. RESTAURAR SESSIONS MARCADAS
    // ============================================
    console.log('🔄 2. Restaurando sessions marcadas...');

    const sessionsResult = await Session.updateMany(
        { deleteReason: /^cleanup-test-data/ },
        {
            $set: { isDeleted: false },
            $unset: { deletedAt: '', deleteReason: '' }
        }
    );

    stats.sessions = sessionsResult.modifiedCount;
    console.log(`   ${stats.sessions} sessions restauradas\n`);

    // ============================================
    // 3. RESTAURAR APPOINTMENTS MARCADOS
    // ============================================
    console.log('🔄 3. Restaurando appointments marcados...');

    const appointmentsResult = await Appointment.updateMany(
        { deleteReason: /^cleanup-test-data/ },
        {
            $set: { isDeleted: false },
            $unset: { deletedAt: '', deleteReason: '' }
        }
    );

    stats.appointments = appointmentsResult.modifiedCount;
    console.log(`   ${stats.appointments} appointments restaurados\n`);

    // ============================================
    // RELATÓRIO FINAL
    // ============================================
    console.log('========================================');
    console.log('📊 RELATÓRIO DE ROLLBACK');
    console.log('========================================');
    console.log(`Débitos restaurados: ${stats.debits}`);
    console.log(`Sessions restauradas: ${stats.sessions}`);
    console.log(`Appointments restaurados: ${stats.appointments}`);
    console.log(`TOTAL: ${stats.debits + stats.sessions + stats.appointments} itens restaurados`);

    await mongoose.disconnect();
    console.log('\n👋 Done!');
    process.exit(0);
}

rollback().catch(err => {
    console.error('💥 Erro:', err);
    process.exit(1);
});
