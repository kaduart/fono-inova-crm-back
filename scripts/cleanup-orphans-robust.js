// 🧹 Limpeza Robusta de Órfãos - Ignora validações para dados antigos
// USO: DRY_RUN=false node cleanup-orphans-robust.js

import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const DRY_RUN = process.env.DRY_RUN !== 'false';
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';

async function cleanupRobust() {
    console.log('========================================');
    console.log('🧹 LIMPEZA ROBUSTA DE ÓRFÃOS');
    console.log(`📋 MODO: ${DRY_RUN ? 'DRY RUN (visualização)' : 'EXECUÇÃO REAL'}`);
    console.log('========================================\n');

    await mongoose.connect(MONGO_URI);
    console.log('✅ Conectado ao MongoDB\n');

    const db = mongoose.connection.db;
    const stats = {
        sessionsDeleted: 0,
        debitsCancelled: 0,
        errors: []
    };

    // ============================================
    // 1. BUSCAR SESSIONS ÓRFÃS (sem appointmentId)
    // ============================================
    console.log('🔍 1. Buscando sessions órfãs...');
    
    const orphanSessions = await db.collection('sessions').find({
        $or: [
            { appointmentId: { $exists: false } },
            { appointmentId: null }
        ],
        isDeleted: { $ne: true }
    }).toArray();

    console.log(`   ${orphanSessions.length} sessions órfãs encontradas\n`);

    // ============================================
    // 2. MARCAR CADA SESSION COMO DELETADA (direto no MongoDB, sem validação)
    // ============================================
    console.log('🔧 2. Marcando sessions como deletadas...');

    for (const session of orphanSessions) {
        try {
            console.log(`   Processing: ${session._id} (Patient: ${session.patient})`);

            if (!DRY_RUN) {
                // Update direto no MongoDB - ignora validações do Mongoose
                await db.collection('sessions').updateOne(
                    { _id: session._id },
                    { 
                        $set: {
                            isDeleted: true,
                            deletedAt: new Date(),
                            deleteReason: 'cleanup-orphan-robust'
                        }
                    }
                );
                stats.sessionsDeleted++;
                console.log(`   ✅ Marcada como deletada: ${session._id}`);

                // Cancelar débitos no PatientBalance
                if (session.patient) {
                    const balance = await db.collection('patientbalances').findOne({ 
                        patient: session.patient 
                    });
                    
                    if (balance && balance.transactions) {
                        let debitsChanged = 0;
                        const updatedTransactions = balance.transactions.map(t => {
                            if ((t.sessionId?.toString() === session._id.toString() ||
                                 t.appointmentId?.toString() === session.appointmentId?.toString()) &&
                                t.type === 'debit' && !t.isPaid && !t.isDeleted) {
                                debitsChanged++;
                                return {
                                    ...t,
                                    isDeleted: true,
                                    deletedAt: new Date(),
                                    deleteReason: 'cleanup-orphan: session deleted'
                                };
                            }
                            return t;
                        });

                        if (debitsChanged > 0) {
                            await db.collection('patientbalances').updateOne(
                                { _id: balance._id },
                                { $set: { transactions: updatedTransactions } }
                            );
                            stats.debitsCancelled += debitsChanged;
                            console.log(`      💰 ${debitsChanged} débitos cancelados`);
                        }
                    }
                }
            } else {
                console.log(`   [DRY RUN] Seria deletada: ${session._id}`);
                stats.sessionsDeleted++;
            }
        } catch (error) {
            console.error(`   ❌ Erro ao processar ${session._id}:`, error.message);
            stats.errors.push({ sessionId: session._id, error: error.message });
        }
    }

    // ============================================
    // 3. MARCAR DÉBITOS DUPLICADOS
    // ============================================
    console.log('\n🔍 3. Verificando débitos duplicados...');

    const duplicateDebits = await db.collection('patientbalances').aggregate([
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
    ]).toArray();

    console.log(`   ${duplicateDebits.length} grupos de duplicados encontrados`);

    for (const dup of duplicateDebits) {
        try {
            const balance = await db.collection('patientbalances').findOne({ 
                patient: dup._id.patient 
            });
            
            if (!balance) continue;

            // Manter o primeiro, marcar os outros
            const idsToMark = dup.transactions.slice(1);
            
            let changed = false;
            const updatedTransactions = balance.transactions.map(t => {
                if (idsToMark.some(id => id.toString() === t._id.toString()) && !t.isDeleted) {
                    changed = true;
                    stats.debitsCancelled++;
                    console.log(`   ${DRY_RUN ? '[DRY RUN]' : '✅'} Duplicado: ${t._id}`);
                    if (!DRY_RUN) {
                        return {
                            ...t,
                            isDeleted: true,
                            deletedAt: new Date(),
                            deleteReason: 'cleanup-duplicate'
                        };
                    }
                }
                return t;
            });

            if (changed && !DRY_RUN) {
                await db.collection('patientbalances').updateOne(
                    { _id: balance._id },
                    { $set: { transactions: updatedTransactions } }
                );
            }
        } catch (error) {
            console.error(`   ❌ Erro ao marcar duplicados:`, error.message);
            stats.errors.push({ error: error.message });
        }
    }

    // ============================================
    // RELATÓRIO FINAL
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
        console.log('   DRY_RUN=false node cleanup-orphans-robust.js');
    } else {
        console.log('\n💾 Limpeza concluída!');
    }

    await mongoose.disconnect();
    console.log('\n👋 Done!');
    process.exit(0);
}

cleanupRobust().catch(err => {
    console.error('💥 Erro:', err);
    process.exit(1);
});
