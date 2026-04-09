// 🔧 Script específico: Adiciona specialty nos débitos da paciente Isis
// Busca appointments e infere a especialidade

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import PatientBalance from '../models/PatientBalance.js';
import Appointment from '../models/Appointment.js';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';
const ISIS_PATIENT_ID = '685b0cfaaec14c7163585b5b';

async function fixIsisBalance() {
    console.log('========================================');
    console.log('🔧 CORREÇÃO: Débitos da Isis');
    console.log(`👤 Patient ID: ${ISIS_PATIENT_ID}`);
    console.log('========================================\n');

    await mongoose.connect(MONGO_URI);
    console.log('✅ Conectado ao MongoDB\n');

    // Buscar balance da Isis
    const balance = await PatientBalance.findOne({ patient: ISIS_PATIENT_ID });
    
    if (!balance) {
        console.log('❌ Balance não encontrado para Isis');
        process.exit(1);
    }

    console.log(`📊 Balance encontrado:`);
    console.log(`   Saldo atual: R$ ${balance.currentBalance}`);
    console.log(`   Total transações: ${balance.transactions.length}\n`);

    let fixed = 0;
    let alreadyOk = 0;
    let unknown = 0;

    for (const t of balance.transactions) {
        // Só processa débitos sem specialty
        if (t.type === 'debit' && !t.specialty) {
            let specialty = 'unknown';

            // Tenta buscar do appointment
            if (t.appointmentId) {
                try {
                    const appt = await Appointment.findById(t.appointmentId).select('specialty').lean();
                    if (appt?.specialty) {
                        specialty = appt.specialty.toString().toLowerCase().trim().replace(/_/g, ' ').replace(/\s+/g, ' ');
                        console.log(`✅ ${t._id}: ${specialty} (do appointment ${t.appointmentId})`);
                    } else {
                        console.log(`⚠️  ${t._id}: appointment sem specialty`);
                        unknown++;
                    }
                } catch (err) {
                    console.log(`❌ ${t._id}: erro ao buscar appointment`);
                    unknown++;
                }
            } else {
                console.log(`⚠️  ${t._id}: sem appointmentId`);
                unknown++;
            }

            t.specialty = specialty;
            fixed++;
        } else if (t.specialty) {
            alreadyOk++;
        }
    }

    // Salvar alterações
    if (fixed > 0) {
        await balance.save();
        console.log(`\n💾 Balance salvo (${fixed} correções)`);
    }

    console.log('\n========================================');
    console.log('📊 RESUMO:');
    console.log(`   Corrigidos: ${fixed}`);
    console.log(`   Já OK: ${alreadyOk}`);
    console.log(`   Unknown: ${unknown}`);
    console.log('========================================');

    // Mostrar transações finais
    console.log('\n📋 Transações finais da Isis:');
    const debits = balance.transactions.filter(t => t.type === 'debit');
    
    const bySpecialty = {};
    for (const t of debits) {
        const esp = t.specialty || 'sem especialidade';
        if (!bySpecialty[esp]) bySpecialty[esp] = { count: 0, amount: 0 };
        bySpecialty[esp].count++;
        bySpecialty[esp].amount += t.amount;
    }

    for (const [esp, data] of Object.entries(bySpecialty)) {
        console.log(`   ${esp}: ${data.count} débitos, R$ ${data.amount}`);
    }

    await mongoose.disconnect();
    console.log('\n👋 Done!');
    process.exit(0);
}

fixIsisBalance().catch(err => {
    console.error('💥 Erro:', err);
    process.exit(1);
});
