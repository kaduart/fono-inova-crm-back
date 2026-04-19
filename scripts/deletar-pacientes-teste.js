// scripts/deletar-pacientes-teste.js
// ============================================================
// DELETA pacientes de teste (AAAA e abcd) e TODOS os dados
// vinculados: sessions, appointments, payments, packages, ledgers
//
// Uso: node scripts/deletar-pacientes-teste.js [dry-run]
// ============================================================

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import Patient from '../models/Patient.js';
import PatientBalance from '../models/PatientBalance.js';
import FinancialLedger from '../models/FinancialLedger.js';
import Package from '../models/Package.js';

dotenv.config();

const DRY_RUN = process.argv.includes('dry-run');

const PACIENTES_TESTE = ['AAAA', 'abcd'];

async function main() {
    console.log(`[Deletar Pacientes Teste] Iniciando... ${DRY_RUN ? '(DRY-RUN)' : '(EXECUÇÃO REAL)'}`);

    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!mongoUri) throw new Error('MONGO_URI não encontrado no .env');
    await mongoose.connect(mongoUri);
    console.log('[Deletar Pacientes Teste] Conectado ao MongoDB');

    // 1. Buscar IDs dos pacientes
    const patients = await Patient.find({ fullName: { $in: PACIENTES_TESTE } }).select('_id fullName').lean();
    if (patients.length === 0) {
        console.log('Nenhum paciente de teste encontrado.');
        await mongoose.disconnect();
        process.exit(0);
    }

    const patientIds = patients.map(p => p._id.toString());
    console.log(`Pacientes encontrados: ${patients.length}`);
    for (const p of patients) {
        console.log(`  - ${p.fullName} (${p._id})`);
    }

    // 2. Contar o que será deletado
    const sessionsCount = await Session.countDocuments({ patient: { $in: patientIds } });
    const appointmentsCount = await Appointment.countDocuments({ patient: { $in: patientIds } });
    const paymentsCount = await Payment.countDocuments({ patient: { $in: patientIds } });
    const balanceCount = await PatientBalance.countDocuments({ patient: { $in: patientIds } });
    const ledgerCount = await FinancialLedger.countDocuments({ patient: { $in: patientIds } });
    const packageCount = await Package.countDocuments({ patient: { $in: patientIds } });

    console.log('\n📊 Dados vinculados:');
    console.log(`  Sessions:      ${sessionsCount}`);
    console.log(`  Appointments:  ${appointmentsCount}`);
    console.log(`  Payments:      ${paymentsCount}`);
    console.log(`  Balances:      ${balanceCount}`);
    console.log(`  Ledgers:       ${ledgerCount}`);
    console.log(`  Packages:      ${packageCount}`);

    if (DRY_RUN) {
        console.log('\n[DRY-RUN] Nada foi deletado.');
        await mongoose.disconnect();
        process.exit(0);
    }

    // 3. Deletar em ordem segura (filhos primeiro, pais depois)
    console.log('\n🗑️ Deletando...');

    const sessionIds = await Session.find({ patient: { $in: patientIds } }).select('_id').lean();
    const sessionIdList = sessionIds.map(s => s._id);

    // Deletar Payments vinculados a essas sessions (mesmo que patient seja diferente)
    const paymentDel1 = await Payment.deleteMany({ session: { $in: sessionIdList } });
    console.log(`  Payments (por session): ${paymentDel1.deletedCount}`);

    // Deletar Payments vinculados diretamente aos pacientes
    const paymentDel2 = await Payment.deleteMany({ patient: { $in: patientIds } });
    console.log(`  Payments (por patient): ${paymentDel2.deletedCount}`);

    // Deletar Ledgers
    const ledgerDel = await FinancialLedger.deleteMany({ patient: { $in: patientIds } });
    console.log(`  Ledgers: ${ledgerDel.deletedCount}`);

    // Deletar Balances
    const balanceDel = await PatientBalance.deleteMany({ patient: { $in: patientIds } });
    console.log(`  Balances: ${balanceDel.deletedCount}`);

    // Deletar Sessions
    const sessionDel = await Session.deleteMany({ patient: { $in: patientIds } });
    console.log(`  Sessions: ${sessionDel.deletedCount}`);

    // Deletar Appointments
    const appDel = await Appointment.deleteMany({ patient: { $in: patientIds } });
    console.log(`  Appointments: ${appDel.deletedCount}`);

    // Deletar Packages
    const pkgDel = await Package.deleteMany({ patient: { $in: patientIds } });
    console.log(`  Packages: ${pkgDel.deletedCount}`);

    // Deletar Pacientes
    const patientDel = await Patient.deleteMany({ _id: { $in: patientIds } });
    console.log(`  Pacientes: ${patientDel.deletedCount}`);

    console.log('\n✅ Tudo deletado com sucesso.');

    await mongoose.disconnect();
    process.exit(0);
}

main().catch(err => {
    console.error('[Deletar Pacientes Teste] Erro fatal:', err);
    process.exit(1);
});
