// 🧹 Limpeza de Dados Órfãos com Cascade Delete
// Remove sessions sem appointments e corrige inconsistências
// USO: DRY_RUN=false node cleanup-orphans-cascade.js

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import PatientBalance from '../models/PatientBalance.js';

dotenv.config();

const DRY_RUN = process.env.DRY_RUN !== 'false';
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';

async function cleanupOrphans() {
    console.log('========================================');
    console.log('🧹 LIMPEZA DE ÓRFÃOS COM CASCADE');
    console.log(`📋 MODO: ${DRY_RUN ? 'DRY RUN (visualização)' : 'EXECUÇÃO REAL'}`);
    console.log('========================================\n');

    await mongoose.connect(MONGO_URI);
    console.log('✅ Conectado ao MongoDB\n');

    const stats = {
        sessionsDeleted: 0,
        debitsCancelled: 0,
        errors: []
    };

    // ============================================
    // 1. ENCONTRAR SESSIONS ÓRFÃS (sem appointmentId)
    // ============================================
    console.log('🔍 1. Buscando sessions órfãs...');
    
    const orphanSessions = await Session.find({
        $or: [
            { appointmentId: { $exists: false } },
            { appointmentId: null }
        ],
        isDeleted: { $ne: true }
    });

    console.log(`   ${orphanSessions.length} sessions órfãs encontradas\n`);

    // ============================================
    // 2. PARA CADA SESSION ÓRFÃ, CANCELAR DÉBITOS E DELETAR
    // ============================================
    console.log('🔧 2. Processando sessions órfãs...');

    for (const session of orphanSessions) {
        try {
            console.log(`   Processing: ${session._id} (Patient: ${session.patient})`);

            if (!DRY_RUN) {
                // Usar soft delete em cascata
                await session.softDeleteCascade('orphan-cleanup', null);
                stats.sessionsDeleted++;
            } else {
                // Em dry run, só simular
                console.log(`   [DRY RUN] Seria deletada: ${session._id}`);
                
                // Verificar débitos que seriam cancelados
                if (session.patient) {
                    const balance = await PatientBalance.findOne({ patient: session.patient });
                    if (balance) {
                        const debitsToCancel = balance.transactions.filter(t => 
                            t.sessionId?.toString() === session._id.toString() &&
                            t.type === 'debit' && 
                            !t.isPaid &&
                            !t.isDeleted
                        );
                        stats.debitsCancelled += debitsToCancel.length;
                        debitsToCancel.forEach(d => {
                            console.log(`      [DRY RUN] Débito cancelado: ${d._id} (R$ ${d.amount})`);
                        });
                    }
                }
                stats.sessionsDeleted++;
            }
        } catch (error) {
            console.error(`   ❌ Erro ao processar ${session._id}:`, error.message);
            stats.errors.push({ sessionId: session._id, error: error.message });
        }
    }

    // ============================================
    // 3. VERIFICAR DÉBITOS DUPLICADOS
    // ============================================
    console.log('\n🔍 3. Verificando débitos duplicados...');

    const duplicateDebits = await PatientBalance.aggregate([
        { $unwind: '$transactions' },
        { $match: { 'transactions.type': 'debit' } },
        {
            $group: {
                _id: {
                    patient: '$patient',
                    appointmentId: '$transactions.appointmentId'
                },
                count: { $sum: 1 },
                transactions: { $push: '$transactions._id' }
            }
        },
        { $match: { '_id.appointmentId': { $ne: null }, count: { $gt: 1 } } }
    ]);

    console.log(`   ${duplicateDebits.length} grupos de duplicados encontrados`);

    for (const dup of duplicateDebits) {
        try {
            const balance = await PatientBalance.findOne({ patient: dup._id.patient });
            if (!balance) continue;

            // Manter o primeiro, marcar os outros como duplicados
            const toMark = dup.transactions.slice(1);
            
            for (const txId of toMark) {
                const tx = balance.transactions.id(txId);
                if (tx && !tx.isDeleted) {
                    if (!DRY_RUN) {
                        tx.isDeleted = true;
                        tx.deletedAt = new Date();
                        tx.deleteReason = 'cleanup-duplicate';
                    }
                    console.log(`   ${DRY_RUN ? '[DRY RUN]' : '✅'} Duplicado marcado: ${txId}`);
                    stats.debitsCancelled++;
                }
            }

            if (!DRY_RUN) {
                await balance.save();
            }
        } catch (error) {
            console.error(`   ❌ Erro ao marcar duplicados:`, error.message);
            stats.errors.push({ error: error.message });
        }
    }

    // ============================================
    // 4. RELATÓRIO FINAL
    // ============================================
    console.log('\n========================================');
    console.log('📊 RELATÓRIO DE LIMPEZA');
    console.log('========================================');
    console.log(`Sessions processadas: ${stats.sessionsDeleted}`);
    console.log(`Débitos cancelados: ${stats.debitsCancelled}`);
    console.log(`Erros: ${stats.errors.length}`);

    if (stats.errors.length > 0) {
        console.log('\n❌ Erros encontrados:');
        stats.errors.forEach(e => console.log(`   - ${e.sessionId || 'N/A'}: ${e.error}`));
    }

    if (DRY_RUN) {
        console.log('\n⚠️  DRY RUN - Nenhuma alteração foi salva!');
        console.log('   Para executar de verdade:');
        console.log('   DRY_RUN=false node cleanup-orphans-cascade.js');
    } else {
        console.log('\n💾 Limpeza concluída!');
    }

    await mongoose.disconnect();
    console.log('\n👋 Done!');
    process.exit(0);
}

cleanupOrphans().catch(err => {
    console.error('💥 Erro:', err);
    process.exit(1);
});
