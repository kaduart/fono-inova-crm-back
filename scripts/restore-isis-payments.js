/**
 * 🚨 RESTAURAÇÃO DE PAYMENTS APAGADOS — ISIS CALDAS REBELATTO
 *
 * Este script recria os 14 payments que foram removidos incorretamente
 * e restaura as referências nos appointments.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!MONGO_URI) { console.error('❌ MONGODB_URI não configurada'); process.exit(1); }

async function main() {
    await mongoose.connect(MONGO_URI);
    console.log('🔌 Conectado:', mongoose.connection.db.databaseName);

    const Payment = (await import('../models/Payment.js')).default;
    const Appointment = (await import('../models/Appointment.js')).default;

    const patientId = '685b0cfaaec14c7163585b5b';
    const patientOid = new mongoose.Types.ObjectId(patientId);

    // ═══════════════════════════════════════════════════════════
    // 1. RECRIAR PAYMENTS AVULSOS
    // ═══════════════════════════════════════════════════════════
    const avulsos = [
        {
            _id: new mongoose.Types.ObjectId('69ea80a39e96c1a73c8563b3'),
            amount: 160,
            status: 'paid',
            kind: undefined,
            billingType: 'particular',
            description: undefined,
            paymentMethod: undefined,
            paymentDate: new Date('2026-04-23T20:27:15.579Z'),
            paymentMethod: 'dinheiro',
            paidAt: new Date('2026-04-23T20:27:15.579Z'),
            createdAt: new Date('2026-04-23T20:27:15.579Z'),
            patient: patientOid
        },
        {
            _id: new mongoose.Types.ObjectId('69ea80a39e96c1a73c8563b4'),
            amount: 160,
            status: 'paid',
            kind: undefined,
            billingType: 'particular',
            description: undefined,
            paymentDate: new Date('2026-04-23T20:27:15.579Z'),
            paymentMethod: 'dinheiro',
            paidAt: new Date('2026-04-23T20:27:15.579Z'),
            createdAt: new Date('2026-04-23T20:27:15.579Z'),
            patient: patientOid
        },
        {
            _id: new mongoose.Types.ObjectId('69f0a00af069ca360a8563b1'),
            amount: 130,
            status: 'pending',
            kind: 'session_payment',
            billingType: 'particular',
            description: undefined,
            paymentDate: new Date('2026-04-28T11:54:50.470Z'),
            paymentMethod: 'dinheiro',
            createdAt: new Date('2026-04-28T11:54:50.470Z'),
            patient: patientOid
        },
        {
            _id: new mongoose.Types.ObjectId('69f0a00af069ca360a8563b2'),
            amount: 160,
            status: 'pending',
            kind: 'session_payment',
            billingType: 'particular',
            description: undefined,
            paymentDate: new Date('2026-04-28T11:54:50.470Z'),
            paymentMethod: 'dinheiro',
            createdAt: new Date('2026-04-28T11:54:50.470Z'),
            patient: patientOid
        }
    ];

    console.log('\n🔄 Recriando payments avulsos...');
    for (const data of avulsos) {
        const existing = await Payment.findById(data._id).lean();
        if (existing) {
            console.log(`   ✅ Já existe: ${data._id}`);
            continue;
        }
        await Payment.create(data);
        console.log(`   ✅ Recriado: ${data._id} | ${data.status} | R$ ${data.amount.toFixed(2)}`);
    }

    // ═══════════════════════════════════════════════════════════
    // 2. RECRIAR PAYMENTS PENDING DE PACOTE
    // ═══════════════════════════════════════════════════════════
    const packagePayments = [
        {
            _id: new mongoose.Types.ObjectId('69fe3b5a6f9062389047bd4e'),
            amount: 160, status: 'pending', kind: 'session_payment',
            billingType: 'particular', patient: patientOid,
            appointment: new mongoose.Types.ObjectId('69e22ce74e856f552b1aa3ec'),
            paymentDate: new Date('2026-05-08T19:36:58.221Z'),
            paymentMethod: 'dinheiro',
            createdAt: new Date('2026-05-08T19:36:58.221Z')
        },
        {
            _id: new mongoose.Types.ObjectId('69fe3b766f9062389047be41'),
            amount: 160, status: 'pending', kind: 'session_payment',
            billingType: 'particular', patient: patientOid,
            appointment: new mongoose.Types.ObjectId('69e2730d11988055724866f3'),
            paymentDate: new Date('2026-05-08T19:37:26.643Z'),
            paymentMethod: 'dinheiro',
            createdAt: new Date('2026-05-08T19:37:26.643Z')
        },
        {
            _id: new mongoose.Types.ObjectId('6a022d13c574de6da0bacdf0'),
            amount: 160, status: 'pending', kind: 'session_payment',
            billingType: 'particular', patient: patientOid,
            appointment: new mongoose.Types.ObjectId('69e2730d11988055724866f4'),
            paymentDate: new Date('2026-05-11T19:25:07.140Z'),
            paymentMethod: 'dinheiro',
            createdAt: new Date('2026-05-11T19:25:07.140Z')
        },
        {
            _id: new mongoose.Types.ObjectId('6a022d7dc574de6da0bad0ab'),
            amount: 130, status: 'pending', kind: 'session_payment',
            billingType: 'particular', patient: patientOid,
            appointment: new mongoose.Types.ObjectId('69e2724d119880557248659c'),
            paymentDate: new Date('2026-05-11T19:26:53.934Z'),
            paymentMethod: 'dinheiro',
            createdAt: new Date('2026-05-11T19:26:53.934Z')
        },
        {
            _id: new mongoose.Types.ObjectId('6a075d3014259ec2e37d7404'),
            amount: 160, status: 'pending', kind: 'session_payment',
            billingType: 'particular', patient: patientOid,
            appointment: new mongoose.Types.ObjectId('69e22ce74e856f552b1aa3ed'),
            paymentDate: new Date('2026-05-15T17:51:44.697Z'),
            paymentMethod: 'dinheiro',
            createdAt: new Date('2026-05-15T17:51:44.697Z')
        },
        {
            _id: new mongoose.Types.ObjectId('6a076962d49a855f4a46c241'),
            amount: 160, status: 'pending', kind: 'session_payment',
            billingType: 'particular', patient: patientOid,
            appointment: new mongoose.Types.ObjectId('69e2730d11988055724866f5'),
            paymentDate: new Date('2026-05-15T18:43:46.584Z'),
            paymentMethod: 'dinheiro',
            createdAt: new Date('2026-05-15T18:43:46.584Z')
        },
        {
            _id: new mongoose.Types.ObjectId('6a0b64da80cc438aa0b626a6'),
            amount: 160, status: 'pending', kind: 'session_payment',
            billingType: 'particular', patient: patientOid,
            appointment: new mongoose.Types.ObjectId('69e2730d11988055724866f6'),
            paymentDate: new Date('2026-05-18T19:13:30.582Z'),
            paymentMethod: 'dinheiro',
            createdAt: new Date('2026-05-18T19:13:30.582Z')
        },
        {
            _id: new mongoose.Types.ObjectId('6a0b655380cc438aa0b62a41'),
            amount: 130, status: 'pending', kind: 'session_payment',
            billingType: 'particular', patient: patientOid,
            appointment: new mongoose.Types.ObjectId('69e2724d119880557248659d'),
            paymentDate: new Date('2026-05-18T19:15:31.057Z'),
            paymentMethod: 'dinheiro',
            createdAt: new Date('2026-05-18T19:15:31.057Z')
        },
        {
            _id: new mongoose.Types.ObjectId('6a10a41e5686e616627bed43'),
            amount: 160, status: 'pending', kind: 'session_payment',
            billingType: 'particular', patient: patientOid,
            appointment: new mongoose.Types.ObjectId('69e22ce74e856f552b1aa3ee'),
            paymentDate: new Date('2026-05-22T18:44:46.171Z'),
            paymentMethod: 'dinheiro',
            createdAt: new Date('2026-05-22T18:44:46.171Z')
        },
        {
            _id: new mongoose.Types.ObjectId('6a10a4675686e616627befb3'),
            amount: 160, status: 'pending', kind: 'session_payment',
            billingType: 'particular', patient: patientOid,
            appointment: new mongoose.Types.ObjectId('69e2730d11988055724866f7'),
            paymentDate: new Date('2026-05-22T18:45:59.675Z'),
            paymentMethod: 'dinheiro',
            createdAt: new Date('2026-05-22T18:45:59.675Z')
        }
    ];

    console.log('\n🔄 Recriando payments pending de pacote...');
    for (const data of packagePayments) {
        const existing = await Payment.findById(data._id).lean();
        if (existing) {
            console.log(`   ✅ Já existe: ${data._id}`);
            continue;
        }
        await Payment.create(data);
        console.log(`   ✅ Recriado: ${data._id} | R$ ${data.amount.toFixed(2)} | appt: ${data.appointment}`);
    }

    // ═══════════════════════════════════════════════════════════
    // 3. RESTAURAR REFERÊNCIAS NOS APPOINTMENTS
    // ═══════════════════════════════════════════════════════════
    console.log('\n🔄 Restaurando appointment.payment...');
    for (const data of packagePayments) {
        await Appointment.updateOne(
            { _id: data.appointment },
            { $set: { payment: data._id } }
        );
        console.log(`   ✅ Appointment ${data.appointment} → Payment ${data._id}`);
    }

    console.log('\n══════════════════════════════════════════════════════════');
    console.log('  ✅ RESTAURAÇÃO CONCLUÍDA');
    console.log('══════════════════════════════════════════════════════════');

    await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
