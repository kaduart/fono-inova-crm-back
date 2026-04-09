// 🔧 Script de migração: Adiciona specialty nas transações antigas do PatientBalance
// Busca o appointment para inferir a especialidade
//
// USO:
//   DRY_RUN=true node migrate-balance-specialty.js    (só visualiza)
//   DRY_RUN=false node migrate-balance-specialty.js   (executa de verdade)

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import PatientBalance from '../models/PatientBalance.js';
import Appointment from '../models/Appointment.js';

dotenv.config();

const DRY_RUN = process.env.DRY_RUN !== 'false'; // default: true
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';

async function run() {
    console.log('========================================');
    console.log(`🔧 MIGRAÇÃO: PatientBalance.specialty`);
    console.log(`📋 MODO: ${DRY_RUN ? 'DRY RUN (só visualiza)' : 'EXECUÇÃO REAL'}`);
    console.log('========================================\n');

    console.log('🔗 Conectando ao MongoDB...');
    await mongoose.connect(MONGO_URI);
    console.log('✅ Conectado!\n');

    // Buscar balances que têm transações SEM specialty
    const balances = await PatientBalance.find({
        "transactions.specialty": { $exists: false }
    });

    console.log(`📊 Balances com transações antigas: ${balances.length}`);

    let updatedBalances = 0;
    let updatedTransactions = 0;
    let unknownCount = 0;

    for (const balance of balances) {
        let changed = false;

        for (const t of balance.transactions) {
            // Só processa se não tem specialty
            if (!t.specialty && t.type === 'debit') {
                let specialty = 'unknown';

                // Tenta buscar do appointment
                if (t.appointmentId) {
                    try {
                        const appt = await Appointment.findById(t.appointmentId).select('specialty').lean();
                        if (appt?.specialty) {
                            specialty = appt.specialty.toString().toLowerCase().trim().replace(/_/g, ' ').replace(/\s+/g, ' ');
                            console.log(`   ✅ ${balance.patient} / ${t._id}: ${specialty}`);
                        } else {
                            console.log(`   ⚠️  ${balance.patient} / ${t._id}: appointment sem specialty`);
                            unknownCount++;
                        }
                    } catch (err) {
                        console.log(`   ❌ ${balance.patient} / ${t._id}: erro ao buscar appointment`);
                        unknownCount++;
                    }
                } else {
                    console.log(`   ⚠️  ${balance.patient} / ${t._id}: sem appointmentId`);
                    unknownCount++;
                }

                t.specialty = specialty;
                changed = true;
                updatedTransactions++;
            }
        }

        if (changed) {
            if (!DRY_RUN) {
                await balance.save();
                console.log(`   💾 Balance ${balance.patient} salvo`);
            }
            updatedBalances++;
        }
    }

    console.log('\n========================================');
    console.log('📊 RESUMO:');
    console.log(`   Balances afetados: ${updatedBalances}`);
    console.log(`   Transações atualizadas: ${updatedTransactions}`);
    console.log(`   Sem especialidade (unknown): ${unknownCount}`);
    console.log('========================================');

    if (DRY_RUN) {
        console.log('\n🛑 DRY RUN — Nenhuma alteração foi feita!');
        console.log('Para executar de verdade:');
        console.log('   DRY_RUN=false node migrate-balance-specialty.js');
    } else {
        console.log('\n✅ MIGRAÇÃO CONCLUÍDA!');
    }

    await mongoose.disconnect();
    console.log('\n👋 Done!');
    process.exit(0);
}

run().catch(err => {
    console.error('💥 Erro fatal:', err);
    process.exit(1);
});
