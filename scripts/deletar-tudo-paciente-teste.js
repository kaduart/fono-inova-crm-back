// Script para DELETAR TUDO do paciente de teste
// Apaga: Payments, Appointments, Sessions - TUDO relacionado ao paciente
//
// USO: node deletar-tudo-paciente-teste.js --confirm
//
// OPÇÕES:
// --confirm    : OBRIGATÓRIO para confirmar a exclusão
// --patient    : Nome ou parte do nome do paciente (padrão: "Teste")

import mongoose from 'mongoose';
import moment from 'moment-timezone';

const uri = process.env.MONGODB_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';
const TIMEZONE = 'America/Sao_Paulo';

const args = process.argv.slice(2);
const CONFIRM = args.includes('--confirm');
const PATIENT_NAME = args.find((_, i) => args[i - 1] === '--patient') || 'Teste';

async function deletarTudo() {
    try {
        await mongoose.connect(uri);
        console.log('🔌 Conectado ao MongoDB\n');

        const Payment = mongoose.model('Payment', new mongoose.Schema({}, { strict: false }));
        const Appointment = mongoose.model('Appointment', new mongoose.Schema({}, { strict: false }));
        const Patient = mongoose.model('Patient', new mongoose.Schema({}, { strict: false }));
        const Session = mongoose.model('Session', new mongoose.Schema({}, { strict: false }));
        const Package = mongoose.model('Package', new mongoose.Schema({}, { strict: false }));

        console.log('🧨'.repeat(40));
        console.log('⚠️  EXCLUSÃO TOTAL DO PACIENTE E TODOS OS SEUS DADOS');
        console.log('🧨'.repeat(40));
        console.log('\n📅 Data:', moment().tz(TIMEZONE).format('DD/MM/YYYY HH:mm:ss'));
        console.log('👤 Paciente buscado:', PATIENT_NAME);
        console.log('⚙️  Modo:', CONFIRM ? '🔴 EXCLUSÃO REAL' : '🟡 SIMULAÇÃO (dry-run)');
        console.log('');

        // Buscar pacientes que correspondam ao nome
        const patients = await Patient.find({
            fullName: { $regex: PATIENT_NAME, $options: 'i' }
        }).lean();

        if (patients.length === 0) {
            console.log('❌ Nenhum paciente encontrado com o nome:', PATIENT_NAME);
            console.log('\n💡 Tente especificar outro nome:');
            console.log('   node deletar-tudo-paciente-teste.js --confirm --patient "Davi Felipe"');
            return;
        }

        console.log(`👥 Pacientes encontrados: ${patients.length}\n`);
        
        for (const patient of patients) {
            console.log('─'.repeat(80));
            console.log(`👤 ${patient.fullName}`);
            console.log(`   ID: ${patient._id}`);
            console.log(`   Telefone: ${patient.phone || 'N/A'}`);
            console.log('─'.repeat(80));

            const patientId = patient._id.toString();

            // 1. Buscar Payments do paciente
            const payments = await Payment.find({
                $or: [
                    { patientId: patient._id },
                    { patient: patient._id }
                ]
            }).lean();

            // 2. Buscar Appointments do paciente
            const appointments = await Appointment.find({
                patient: patient._id
            }).lean();

            // 3. Buscar Sessions do paciente
            const sessions = await Session.find({
                $or: [
                    { patient: patient._id },
                    { patientId: patient._id }
                ]
            }).lean();

            // 4. Buscar Packages do paciente
            const packages = await Package.find({
                $or: [
                    { patient: patient._id },
                    { patientId: patient._id }
                ]
            }).lean();

            // Resumo
            console.log('\n📊 DADOS ENCONTRADOS:');
            console.log(`   💰 Payments:     ${payments.length}`);
            console.log(`   📋 Appointments: ${appointments.length}`);
            console.log(`   🗓️  Sessions:     ${sessions.length}`);
            console.log(`   📦 Packages:     ${packages.length}`);

            // Calcular valor total
            const totalPayments = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
            const totalReceived = payments
                .filter(p => p.status === 'paid' || p.status === 'completed')
                .reduce((sum, p) => sum + (p.amount || 0), 0);
            const totalPending = payments
                .filter(p => p.status === 'pending')
                .reduce((sum, p) => sum + (p.amount || 0), 0);

            console.log(`\n💵 VALORES:`);
            console.log(`   💰 Total em pagamentos: R$ ${totalPayments.toFixed(2)}`);
            console.log(`   ✅ Recebido: R$ ${totalReceived.toFixed(2)}`);
            console.log(`   ⏳ Pendente: R$ ${totalPending.toFixed(2)}`);

            // Listar detalhes
            if (payments.length > 0) {
                console.log('\n💰 DETALHES DOS PAYMENTS:');
                payments.forEach((p, i) => {
                    console.log(`   ${i + 1}. R$ ${(p.amount || 0).toFixed(2)} - ${p.status} - ${p.description?.substring(0, 40) || 'N/A'}`);
                });
            }

            if (appointments.length > 0) {
                console.log('\n📋 DETALHES DOS APPOINTMENTS:');
                appointments.forEach((a, i) => {
                    console.log(`   ${i + 1}. ${a.date} ${a.time} - ${a.operationalStatus} - R$ ${(a.value || 0).toFixed(2)}`);
                });
            }

            if (!CONFIRM) {
                console.log('\n⚠️  MODO SIMULAÇÃO - Nada será deletado!');
                console.log('\n🚨 Para DELETAR TUDO DEFINITIVAMENTE, execute:');
                console.log(`   node deletar-tudo-paciente-teste.js --confirm --patient "${PATIENT_NAME}"`);
                console.log('\n❌ Encerrando sem alterações...');
                continue;
            }

            // CONFIRMADO - DELETAR TUDO
            console.log('\n🔴 DELETANDO TUDO...\n');

            // Deletar Payments
            if (payments.length > 0) {
                const ids = payments.map(p => p._id.toString());
                const result = await Payment.deleteMany({ _id: { $in: ids } });
                console.log(`   ✅ Payments deletados: ${result.deletedCount}/${payments.length}`);
            }

            // Deletar Appointments
            if (appointments.length > 0) {
                const ids = appointments.map(a => a._id.toString());
                const result = await Appointment.deleteMany({ _id: { $in: ids } });
                console.log(`   ✅ Appointments deletados: ${result.deletedCount}/${appointments.length}`);
            }

            // Deletar Sessions
            if (sessions.length > 0) {
                const ids = sessions.map(s => s._id.toString());
                const result = await Session.deleteMany({ _id: { $in: ids } });
                console.log(`   ✅ Sessions deletadas: ${result.deletedCount}/${sessions.length}`);
            }

            // Deletar Packages
            if (packages.length > 0) {
                const ids = packages.map(p => p._id.toString());
                const result = await Package.deleteMany({ _id: { $in: ids } });
                console.log(`   ✅ Packages deletados: ${result.deletedCount}/${packages.length}`);
            }

            // Deletar o próprio paciente
            const resultPatient = await Patient.deleteOne({ _id: patient._id });
            console.log(`   ✅ Paciente deletado: ${resultPatient.deletedCount === 1 ? 'SIM' : 'NÃO'}`);

            console.log('\n✅ TODOS OS DADOS DO PACIENTE FORAM REMOVIDOS!');
        }

        console.log('\n' + '🎉'.repeat(40));
        console.log('🧹 LIMPEZA CONCLUÍDA!');
        console.log('🎉'.repeat(40));

        if (CONFIRM) {
            console.log('\n💡 Agora acione o recálculo do dashboard:');
            console.log('   POST /api/v2/totals/recalculate');
            console.log('\n📊 Ou os totais serão recalculados automaticamente em breve.');
        }

    } catch (err) {
        console.error('\n❌ Erro:', err.message);
        console.error(err.stack);
    } finally {
        await mongoose.disconnect();
        console.log('\n🔌 Desconectado do MongoDB');
    }
}

// Help
if (args.includes('--help') || args.includes('-h')) {
    console.log(`
═══════════════════════════════════════════════════════════════════════════════
  DELETAR TUDO DO PACIENTE DE TESTE
═══════════════════════════════════════════════════════════════════════════════

Uso: node deletar-tudo-paciente-teste.js --confirm [--patient "Nome"]

⚠️  ATENÇÃO: Isso vai deletar TUDO relacionado ao paciente:
   - Pagamentos (Payments)
   - Agendamentos (Appointments)
   - Sessões (Sessions)
   - Pacotes (Packages)
   - O próprio cadastro do paciente

OPÇÕES:
  --confirm          OBRIGATÓRIO para confirmar a exclusão
  --patient <nome>   Nome ou parte do nome (padrão: "Teste")
  --help, -h         Mostra esta ajuda

EXEMPLOS:

  # Simular (ver o que será deletado)
  node deletar-tudo-paciente-teste.js

  # Deletar paciente chamado "Teste"
  node deletar-tudo-paciente-teste.js --confirm

  # Deletar paciente específico
  node deletar-tudo-paciente-teste.js --confirm --patient "Davi Felipe"

  # Deletar vários pacientes que contenham "Teste" no nome
  node deletar-tudo-paciente-teste.js --confirm --patient "Teste"
`);
    process.exit(0);
}

deletarTudo();
