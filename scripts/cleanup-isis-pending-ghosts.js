/**
 * Limpeza de payments fantasmas da Isis Caldas Rebelatto
 *
 * Problema: payments pending foram criados para sessões de pacotes per-session,
 * mas a dívida real vive em Package.balance. Além disso, existem payments
 * avulsos sem appointment que são lixo.
 *
 * O que este script faz:
 * 1. Remove payments avulsos (sem appointment, sem package) que são fantasmas
 * 2. Remove payments pending vinculados a appointments de pacotes per-session
 * 3. Limpa o campo appointment.payment desses appointments
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

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
    await mongoose.connect(MONGO_URI);
    console.log(`🔌 Conectado: ${mongoose.connection.db.databaseName}`);
    console.log(`🧪 DRY_RUN: ${DRY_RUN}\n`);

    const Payment = (await import('../models/Payment.js')).default;
    const Appointment = (await import('../models/Appointment.js')).default;

    const patientId = '685b0cfaaec14c7163585b5b';
    const patientOid = new mongoose.Types.ObjectId(patientId);

    // ═══════════════════════════════════════════════════════════
    // 1. PAYMENTS AVULSOS FANTASMAS (sem appointment, sem package)
    // ═══════════════════════════════════════════════════════════
    const ghostAvulsos = await Payment.find({
        patient: patientOid,
        appointment: { $exists: false },
        package: { $exists: false },
        // MANTÉM o payment legítimo de quitação (R$ 2280, kind: debt_settlement)
        kind: { $ne: 'debt_settlement' }
    }).lean();

    console.log('👻 PAYMENTS AVULSOS FANTASMAS:', ghostAvulsos.length);
    for (const p of ghostAvulsos) {
        console.log(`   → ${p._id} | ${p.status} | R$ ${(p.amount || 0).toFixed(2)} | ${p.createdAt}`);
        if (!DRY_RUN) {
            await Payment.deleteOne({ _id: p._id });
            console.log('      ✅ Removido');
        }
    }
    if (ghostAvulsos.length === 0) console.log('   (nenhum encontrado)');

    // ═══════════════════════════════════════════════════════════
    // 2. PAYMENTS PENDING EM APPOINTMENTS DE PACOTE PER-SESSION
    // ═══════════════════════════════════════════════════════════
    const appointmentsWithPackage = await Appointment.find({
        patient: patientId,
        package: { $exists: true, $ne: null }
    }).distinct('_id');

    const pendingPackagePayments = await Payment.find({
        patient: patientOid,
        status: 'pending',
        appointment: { $in: appointmentsWithPackage }
    }).lean();

    console.log(`\n📦 PAYMENTS PENDING DE PACOTE: ${pendingPackagePayments.length}`);
    let totalLixo = 0;
    for (const p of pendingPackagePayments) {
        totalLixo += p.amount || 0;
        console.log(`   → ${p._id} | R$ ${(p.amount || 0).toFixed(2)} | appt: ${p.appointment?.toString()} | ${p.createdAt}`);

        if (!DRY_RUN) {
            // Limpa referência no appointment
            await Appointment.updateOne(
                { _id: p.appointment },
                { $unset: { payment: 1 } }
            );
            // Remove o payment
            await Payment.deleteOne({ _id: p._id });
            console.log('      ✅ Removido + appointment.payment limpo');
        }
    }
    if (pendingPackagePayments.length === 0) console.log('   (nenhum encontrado)');

    // ═══════════════════════════════════════════════════════════
    // RESUMO
    // ═══════════════════════════════════════════════════════════
    console.log('\n══════════════════════════════════════════════════════════');
    console.log('  RESUMO DA LIMPEZA');
    console.log('══════════════════════════════════════════════════════════');
    console.log(`   Payments avulsos fantasmas: ${ghostAvulsos.length}`);
    console.log(`   Payments pending de pacote: ${pendingPackagePayments.length}`);
    console.log(`   Valor total de lixo removido: R$ ${(
        ghostAvulsos.reduce((s, p) => s + (p.amount || 0), 0) +
        pendingPackagePayments.reduce((s, p) => s + (p.amount || 0), 0)
    ).toFixed(2)}`);
    if (DRY_RUN) {
        console.log('\n   ⚠️  MODO DRY-RUN — nenhuma alteração foi feita.');
        console.log('   Rode sem --dry-run para aplicar.');
    } else {
        console.log('\n   ✅ Limpeza aplicada com sucesso.');
    }
    console.log('══════════════════════════════════════════════════════════');

    await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
