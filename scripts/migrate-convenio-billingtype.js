/**
 * 🏥 MIGRAÇÃO: Corrige appointments legados com package de convênio
 * mas billingType: particular (criados antes do refactor V2)
 *
 * O que faz:
 * 1. Appointment → billingType: 'convenio', paymentMethod: 'convenio'
 * 2. Session → isPaid: false, paymentStatus: 'pending_receipt', paymentOrigin: 'convenio'
 * 3. Payment → status: 'pending', billingType: 'convenio', paymentMethod: 'convenio'
 *    (remove paidAt/financialDate se foi criado errado como particular pago)
 *
 * DRY-RUN por padrão (não salva nada). Passar --apply para executar.
 */

import mongoose from 'mongoose';
import fs from 'fs';

const DRY_RUN = !process.argv.includes('--apply');

async function migrate() {
    const envContent = fs.readFileSync('.env', 'utf8');
    const match = envContent.match(/MONGO_URI=[\"']?([^\"'\n]+)[\"']?/);
    const uri = match ? match[1] : null;
    if (!uri) {
        console.error('❌ MONGO_URI não encontrado no .env');
        process.exit(1);
    }

    await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000 });
    const db = mongoose.connection.db;

    console.log(DRY_RUN ? '\n🔍 DRY-RUN (nada será salvo)\n' : '\n⚠️  MODO APLICAR\n');

    // 1) Buscar appointments com package convenio mas billingType != convenio
    const pipeline = [
        {
            $lookup: {
                from: 'packages',
                localField: 'package',
                foreignField: '_id',
                as: 'pkg'
            }
        },
        { $unwind: '$pkg' },
        {
            $match: {
                'pkg.type': 'convenio',
                $or: [
                    { billingType: { $ne: 'convenio' } },
                    { billingType: { $exists: false } }
                ]
            }
        }
    ];

    const appointments = await db.collection('appointments').aggregate(pipeline).toArray();
    console.log(`📋 Appointments encontrados: ${appointments.length}\n`);

    let updatedAppointments = 0;
    let updatedSessions = 0;
    let updatedPayments = 0;
    let skipped = 0;

    for (const appt of appointments) {
        const nome = appt.patient?.fullName || appt.patientName || 'N/A';
        const apptId = appt._id;
        const sessionId = appt.session;
        const paymentId = appt.payment;

        console.log(`→ ${nome} | ${appt.date?.toISOString?.().split('T')[0]} ${appt.time} | status: ${appt.operationalStatus}`);
        console.log(`  appointment: ${apptId} | billingType: ${appt.billingType} → convenio`);

        // -------- APPOINTMENT --------
        const apptUpdate = {
            $set: {
                billingType: 'convenio',
                paymentMethod: 'convenio',
                updatedAt: new Date()
            }
        };
        if (!DRY_RUN) {
            await db.collection('appointments').updateOne({ _id: apptId }, apptUpdate);
        }
        updatedAppointments++;

        // -------- SESSION --------
        if (sessionId) {
            const sessionUpdate = {
                $set: {
                    isPaid: false,
                    paymentStatus: 'pending_receipt',
                    paymentOrigin: 'convenio',
                    paymentMethod: 'convenio',
                    updatedAt: new Date()
                },
                $unset: { paidAt: '' }
            };
            if (!DRY_RUN) {
                await db.collection('sessions').updateOne({ _id: sessionId }, sessionUpdate);
            }
            updatedSessions++;
            console.log(`  session: ${sessionId} → isPaid: false, paymentStatus: pending_receipt`);
        }

        // -------- PAYMENT --------
        if (paymentId) {
            const payment = await db.collection('payments').findOne({ _id: paymentId });
            if (payment) {
                const isWronglyPaid = payment.status === 'paid' && payment.billingType !== 'convenio';
                const paymentUpdate = {
                    $set: {
                        billingType: 'convenio',
                        paymentMethod: 'convenio',
                        updatedAt: new Date()
                    }
                };

                if (isWronglyPaid) {
                    paymentUpdate.$set.status = 'pending';
                    paymentUpdate.$set.kind = 'session_payment';
                    paymentUpdate.$set.insurance = {
                        provider: appt.pkg?.insuranceProvider || 'Convênio',
                        status: 'pending_billing',
                        grossAmount: payment.amount || 0
                    };
                    paymentUpdate.$unset = { paidAt: '', financialDate: '' };
                    console.log(`  payment: ${paymentId} → status: pending, billingType: convenio (REMOVIDO paidAt/financialDate)`);
                } else {
                    console.log(`  payment: ${paymentId} → billingType: convenio (já estava correto)`);
                }

                if (!DRY_RUN) {
                    await db.collection('payments').updateOne({ _id: paymentId }, paymentUpdate);
                }
                updatedPayments++;
            }
        }
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log('RESUMO:');
    console.log(`  Appointments atualizados: ${updatedAppointments}`);
    console.log(`  Sessions atualizadas:     ${updatedSessions}`);
    console.log(`  Payments atualizados:     ${updatedPayments}`);
    console.log(`  Total processado:         ${appointments.length}`);
    console.log(`${'='.repeat(60)}`);

    if (DRY_RUN) {
        console.log('\n💡 Para executar de verdade, rode com: node scripts/migrate-convenio-billingtype.js --apply');
    }

    await mongoose.disconnect();
}

migrate().catch(err => {
    console.error('Erro:', err);
    process.exit(1);
});
