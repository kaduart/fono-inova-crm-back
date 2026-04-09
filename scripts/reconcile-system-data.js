// 🧹 Script de Reconciliação - Corrige inconsistências do sistema
// USO: DRY_RUN=false node reconcile-system-data.js

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import PatientBalance from '../models/PatientBalance.js';
import Package from '../models/Package.js';

dotenv.config();

const DRY_RUN = process.env.DRY_RUN !== 'false';
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';

async function reconcile() {
    console.log('========================================');
    console.log(`🧹 RECONCILIAÇÃO DE DADOS`);
    console.log(`📋 MODO: ${DRY_RUN ? 'DRY RUN (só visualiza)' : 'EXECUÇÃO REAL'}`);
    console.log('========================================\n');

    await mongoose.connect(MONGO_URI);
    console.log('✅ Conectado ao MongoDB\n');

    let fixed = 0;
    let skipped = 0;
    let errors = 0;

    // ============================================
    // 1. CORRIGIR SESSIONS SEM APPOINTMENT
    // ============================================
    console.log('🔧 1. Corrigindo Sessions sem Appointment...');
    
    const sessionsWithoutAppt = await Session.find({
        $or: [
            { appointmentId: { $exists: false } },
            { appointmentId: null }
        ],
        status: { $ne: 'canceled' }
    }).limit(100);

    for (const session of sessionsWithoutAppt) {
        try {
            // Buscar appointment pelo package + date + time
            const appointment = await Appointment.findOne({
                session: session._id
            });

            if (appointment) {
                if (!DRY_RUN) {
                    session.appointmentId = appointment._id;
                    await session.save();
                }
                console.log(`   ✅ ${session._id} → vinculado a ${appointment._id}`);
                fixed++;
            } else {
                // Criar appointment se não existir
                const newAppt = new Appointment({
                    patient: session.patient,
                    doctor: session.doctor,
                    date: session.date,
                    time: session.time,
                    specialty: session.specialty || session.sessionType,
                    session: session._id,
                    package: session.package,
                    serviceType: 'package_session',
                    operationalStatus: session.status === 'completed' ? 'confirmed' : 'scheduled',
                    clinicalStatus: session.status === 'completed' ? 'completed' : 'pending'
                });

                if (!DRY_RUN) {
                    await newAppt.save();
                    session.appointmentId = newAppt._id;
                    await session.save();
                }
                console.log(`   ✅ ${session._id} → appointment criado ${newAppt._id}`);
                fixed++;
            }
        } catch (err) {
            console.log(`   ❌ ${session._id} → erro: ${err.message}`);
            errors++;
        }
    }

    // ============================================
    // 2. CORRIGIR DÉBITOS SEM SPECIALTY
    // ============================================
    console.log('\n🔧 2. Corrigindo débitos sem specialty...');

    const balances = await PatientBalance.find({
        'transactions.specialty': { $in: [null, '', undefined] }
    });

    for (const balance of balances) {
        let changed = false;

        for (const t of balance.transactions) {
            if (t.type === 'debit' && !t.specialty && t.appointmentId) {
                try {
                    const appt = await Appointment.findById(t.appointmentId).lean();
                    if (appt?.specialty) {
                        // Mapear specialty
                        let specialty = appt.specialty.toLowerCase().trim();
                        const specialtyMap = {
                            'tongue_tie_test': 'fonoaudiologia',
                            'neuropsych_evaluation': 'psicologia',
                            'evaluation': appt.specialty || 'fonoaudiologia'
                        };
                        
                        if (appt.serviceType && specialtyMap[appt.serviceType]) {
                            specialty = specialtyMap[appt.serviceType];
                        }

                        if (!DRY_RUN) {
                            t.specialty = specialty;
                        }
                        console.log(`   ✅ ${t._id} → ${specialty}`);
                        changed = true;
                        fixed++;
                    } else {
                        // Default para fonoaudiologia se não encontrar
                        if (!DRY_RUN) {
                            t.specialty = 'fonoaudiologia';
                        }
                        console.log(`   ⚠️  ${t._id} → fonoaudiologia (default)`);
                        changed = true;
                        fixed++;
                    }
                } catch (err) {
                    console.log(`   ❌ ${t._id} → erro: ${err.message}`);
                    errors++;
                }
            }
        }

        if (changed && !DRY_RUN) {
            await balance.save();
        }
    }

    // ============================================
    // 3. REMOVER DÉBITOS DUPLICADOS
    // ============================================
    console.log('\n🔧 3. Removendo débitos duplicados...');

    const duplicateBalances = await PatientBalance.aggregate([
        { $unwind: '$transactions' },
        { $match: { 'transactions.type': 'debit' } },
        {
            $group: {
                _id: {
                    patient: '$patient',
                    appointmentId: '$transactions.appointmentId'
                },
                count: { $sum: 1 },
                transactions: { $push: '$transactions._id' },
                balanceId: { $first: '$_id' }
            }
        },
        { $match: { '_id.appointmentId': { $ne: null }, count: { $gt: 1 } } }
    ]);

    for (const dup of duplicateBalances) {
        try {
            const balance = await PatientBalance.findById(dup.balanceId);
            if (!balance) continue;

            // Manter apenas o primeiro, marcar os outros como deleted
            const toRemove = dup.transactions.slice(1);
            
            for (const txId of toRemove) {
                const tx = balance.transactions.id(txId);
                if (tx) {
                    if (!DRY_RUN) {
                        tx.isDeleted = true;
                        tx.deletedAt = new Date();
                        tx.deleteReason = 'Duplicate detected by reconciliation script';
                    }
                    console.log(`   ✅ Marcado duplicado: ${txId}`);
                    fixed++;
                }
            }

            if (!DRY_RUN) {
                await balance.save();
            }
        } catch (err) {
            console.log(`   ❌ Erro ao processar duplicados: ${err.message}`);
            errors++;
        }
    }

    // ============================================
    // 4. SINCRONIZAR SPECIALTY SESSION ↔ APPOINTMENT
    // ============================================
    console.log('\n🔧 4. Sincronizando specialty Session ↔ Appointment...');

    const mismatched = await Session.aggregate([
        {
            $lookup: {
                from: 'appointments',
                localField: 'appointmentId',
                foreignField: '_id',
                as: 'appt'
            }
        },
        {
            $match: {
                'appt.0': { $exists: true },
                $expr: {
                    $and: [
                        { $ne: ['$sessionType', null] },
                        { $ne: [{ $arrayElemAt: ['$appt.specialty', 0] }, null] },
                        { $ne: ['$sessionType', { $arrayElemAt: ['$appt.specialty', 0] }] }
                    ]
                }
            }
        },
        { $limit: 100 }
    ]);

    for (const session of mismatched) {
        try {
            const sessionDoc = await Session.findById(session._id);
            const apptSpecialty = session.appt[0].specialty;

            if (!DRY_RUN) {
                sessionDoc.sessionType = apptSpecialty;
                await sessionDoc.save();
            }
            console.log(`   ✅ ${session._id} → ${apptSpecialty}`);
            fixed++;
        } catch (err) {
            console.log(`   ❌ ${session._id} → erro: ${err.message}`);
            errors++;
        }
    }

    // ============================================
    // RELATÓRIO FINAL
    // ============================================
    console.log('\n========================================');
    console.log('📊 RELATÓRIO DE RECONCILIAÇÃO');
    console.log('========================================');
    console.log(`✅ Corrigidos: ${fixed}`);
    console.log(`⏭️  Pulados: ${skipped}`);
    console.log(`❌ Erros: ${errors}`);

    if (DRY_RUN) {
        console.log('\n⚠️  DRY RUN - Nenhuma alteração foi salva!');
        console.log('   Para executar de verdade:');
        console.log('   DRY_RUN=false node reconcile-system-data.js');
    } else {
        console.log('\n💾 Alterações salvas no banco!');
    }

    await mongoose.disconnect();
    console.log('\n👋 Done!');
    process.exit(0);
}

reconcile().catch(err => {
    console.error('💥 Erro:', err);
    process.exit(1);
});
