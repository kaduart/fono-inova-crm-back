// scripts/deletar-pacientes-teste-2026-08-05.mjs
// ============================================================
// DELETA os 42 pacientes com "teste" no nome (contaminação de
// dados de teste em produção) e tudo vinculado a eles:
// InsuranceCommunication, CommunicationPackage, CommunicationEmailLog,
// e (por segurança) sessions/appointments/payments/packages/
// documents/guides/balances/ledgers, embora o levantamento prévio
// tenha confirmado que nenhum desses 42 pacientes tem esses vínculos.
//
// Uso: node scripts/deletar-pacientes-teste-2026-08-05.mjs [dry-run]
// ============================================================

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Patient from '../models/Patient.js';
import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import Payment from '../models/Payment.js';
import Package from '../models/Package.js';
import PatientBalance from '../models/PatientBalance.js';
import FinancialLedger from '../models/FinancialLedger.js';
import PatientDocument from '../models/PatientDocument.js';
import InsuranceGuide from '../models/InsuranceGuide.js';
import InsuranceCommunication from '../models/InsuranceCommunication.js';
import CommunicationPackage from '../models/CommunicationPackage.js';
import CommunicationEmailLog from '../models/CommunicationEmailLog.js';

dotenv.config();

const DRY_RUN = process.argv.includes('dry-run');

async function main() {
    console.log(`[Deletar Pacientes Teste 2026-08-05] Iniciando... ${DRY_RUN ? '(DRY-RUN)' : '(EXECUÇÃO REAL)'}`);

    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!mongoUri) throw new Error('MONGO_URI não encontrado no .env');
    await mongoose.connect(mongoUri);
    console.log('Conectado ao MongoDB');

    const patients = await Patient.find({ fullName: { $regex: /teste/i } }).select('_id fullName').lean();
    if (patients.length === 0) {
        console.log('Nenhum paciente de teste encontrado.');
        await mongoose.disconnect();
        process.exit(0);
    }

    const patientIds = patients.map(p => p._id);
    console.log(`\nPacientes encontrados: ${patients.length}`);
    for (const p of patients) console.log(`  - ${p.fullName} (${p._id})`);

    const comms = await InsuranceCommunication.find({ patientId: { $in: patientIds } }).select('_id').lean();
    const commIds = comms.map(c => c._id);

    const [
        sessionsCount, appointmentsCount, paymentsCount, packageCount,
        balanceCount, ledgerCount, documentsCount, guidesCount,
        commPkgCount, emailLogCount
    ] = await Promise.all([
        Session.countDocuments({ patient: { $in: patientIds } }),
        Appointment.countDocuments({ patient: { $in: patientIds } }),
        Payment.countDocuments({ patient: { $in: patientIds } }),
        Package.countDocuments({ patient: { $in: patientIds } }),
        PatientBalance.countDocuments({ patient: { $in: patientIds } }),
        FinancialLedger.countDocuments({ patient: { $in: patientIds } }),
        PatientDocument.countDocuments({ patient: { $in: patientIds } }),
        InsuranceGuide.countDocuments({ patient: { $in: patientIds } }),
        CommunicationPackage.countDocuments({ communication: { $in: commIds } }),
        CommunicationEmailLog.countDocuments({ communicationId: { $in: commIds } }),
    ]);

    console.log('\n📊 Dados vinculados:');
    console.log(`  InsuranceCommunication: ${comms.length}`);
    console.log(`  CommunicationPackage:   ${commPkgCount}`);
    console.log(`  CommunicationEmailLog:  ${emailLogCount}`);
    console.log(`  Sessions:               ${sessionsCount}`);
    console.log(`  Appointments:           ${appointmentsCount}`);
    console.log(`  Payments:               ${paymentsCount}`);
    console.log(`  Packages:               ${packageCount}`);
    console.log(`  Balances:               ${balanceCount}`);
    console.log(`  Ledgers:                ${ledgerCount}`);
    console.log(`  PatientDocuments:       ${documentsCount}`);
    console.log(`  InsuranceGuides:        ${guidesCount}`);

    if (DRY_RUN) {
        console.log('\n[DRY-RUN] Nada foi deletado.');
        await mongoose.disconnect();
        process.exit(0);
    }

    console.log('\n🗑️ Deletando...');

    const emailLogDel = await CommunicationEmailLog.deleteMany({ communicationId: { $in: commIds } });
    console.log(`  CommunicationEmailLog: ${emailLogDel.deletedCount}`);

    const commPkgDel = await CommunicationPackage.deleteMany({ communication: { $in: commIds } });
    console.log(`  CommunicationPackage: ${commPkgDel.deletedCount}`);

    const commDel = await InsuranceCommunication.deleteMany({ _id: { $in: commIds } });
    console.log(`  InsuranceCommunication: ${commDel.deletedCount}`);

    const sessionIds = await Session.find({ patient: { $in: patientIds } }).select('_id').lean();
    const sessionIdList = sessionIds.map(s => s._id);

    const paymentDel1 = await Payment.deleteMany({ session: { $in: sessionIdList } });
    console.log(`  Payments (por session): ${paymentDel1.deletedCount}`);

    const paymentDel2 = await Payment.deleteMany({ patient: { $in: patientIds } });
    console.log(`  Payments (por patient): ${paymentDel2.deletedCount}`);

    // FinancialLedger é imutável por design (guard no próprio model bloqueia
    // deleteMany) — os registros ligados a esses pacientes ficam órfãos,
    // mesmo comportamento já validado no caso "ana teste 2" (ver memória
    // project_liminar_ana_teste_contaminacao). Não afeta KPIs do dashboard.
    console.log(`  Ledgers: 0 (imutável por design, ${ledgerCount} ficam órfãos intencionalmente)`);

    const balanceDel = await PatientBalance.deleteMany({ patient: { $in: patientIds } });
    console.log(`  Balances: ${balanceDel.deletedCount}`);

    const sessionDel = await Session.deleteMany({ patient: { $in: patientIds } });
    console.log(`  Sessions: ${sessionDel.deletedCount}`);

    const appDel = await Appointment.deleteMany({ patient: { $in: patientIds } });
    console.log(`  Appointments: ${appDel.deletedCount}`);

    const pkgDel = await Package.deleteMany({ patient: { $in: patientIds } });
    console.log(`  Packages: ${pkgDel.deletedCount}`);

    const docDel = await PatientDocument.deleteMany({ patient: { $in: patientIds } });
    console.log(`  PatientDocuments: ${docDel.deletedCount}`);

    const guideDel = await InsuranceGuide.deleteMany({ patient: { $in: patientIds } });
    console.log(`  InsuranceGuides: ${guideDel.deletedCount}`);

    const patientDel = await Patient.deleteMany({ _id: { $in: patientIds } });
    console.log(`  Pacientes: ${patientDel.deletedCount}`);

    console.log('\n✅ Tudo deletado com sucesso.');

    await mongoose.disconnect();
    process.exit(0);
}

main().catch(err => {
    console.error('[Deletar Pacientes Teste 2026-08-05] Erro fatal:', err);
    process.exit(1);
});
