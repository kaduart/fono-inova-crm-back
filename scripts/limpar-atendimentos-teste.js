// Script para limpar atendimentos de teste do paciente "Teste"
// Estes são os atendimentos com valores residuais (R$ 0,33, R$ 0,22, etc.)
// 
// MODO DE USO:
// 1. Primeiro execute sem argumentos para ver o que será alterado (dry-run)
// 2. Execute com --confirm para aplicar as mudanças
//
// OPÇÕES:
// --confirm    : Confirma a exclusão (padrão é só simular)
// --patient    : Nome do paciente (padrão: "Teste")

import mongoose from 'mongoose';
import moment from 'moment-timezone';

const uri = process.env.MONGODB_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';
const TIMEZONE = 'America/Sao_Paulo';

const args = process.argv.slice(2);
const CONFIRM = args.includes('--confirm');
const PATIENT_NAME = args.find((_, i) => args[i - 1] === '--patient') || 'Teste';

async function limparAtendimentosTeste() {
    try {
        await mongoose.connect(uri);
        console.log('🔌 Conectado ao MongoDB\n');

        const Payment = mongoose.model('Payment', new mongoose.Schema({}, { strict: false }));
        const Appointment = mongoose.model('Appointment', new mongoose.Schema({}, { strict: false }));
        const Patient = mongoose.model('Patient', new mongoose.Schema({}, { strict: false }));
        const Session = mongoose.model('Session', new mongoose.Schema({}, { strict: false }));

        console.log('='.repeat(80));
        console.log('🧹 LIMPEZA DE ATENDIMENTOS DE TESTE');
        console.log('📅 Data:', moment().tz(TIMEZONE).format('DD/MM/YYYY HH:mm:ss'));
        console.log('🔍 Paciente:', PATIENT_NAME);
        console.log('⚙️  Modo:', CONFIRM ? '🗑️  EXCLUSÃO REAL' : '👁️  SIMULAÇÃO (dry-run)');
        console.log('='.repeat(80));

        // 1. Buscar o paciente
        const patient = await Patient.findOne({
            fullName: { $regex: PATIENT_NAME, $options: 'i' }
        }).lean();

        if (!patient) {
            console.log('\n❌ Paciente não encontrado com o nome:', PATIENT_NAME);
            console.log('💡 Tente especificar outro nome com: --patient "Nome do Paciente"');
            return;
        }

        console.log(`\n✅ Paciente encontrado:`);
        console.log(`   ID: ${patient._id}`);
        console.log(`   Nome: ${patient.fullName}`);
        console.log(`   Telefone: ${patient.phone || 'N/A'}`);

        // 2. Buscar pagamentos do paciente com valores pequenos (teste)
        // Filtro: valores menores que R$ 1,00 (provavelmente testes)
        const payments = await Payment.find({
            $or: [
                { patientId: patient._id },
                { patient: patient._id }
            ],
            amount: { $lt: 1.00 }  // Valores menores que R$ 1,00
        }).sort({ paymentDate: -1 }).lean();

        console.log(`\n💰 Pagamentos encontrados: ${payments.length}`);
        console.log('   (valores menores que R$ 1,00)\n');

        if (payments.length === 0) {
            console.log('✅ Nenhum pagamento de teste encontrado.');
            return;
        }

        // 3. Listar pagamentos e buscar appointments relacionados
        const idsPagamentos = [];
        const idsAppointments = [];
        const idsSessions = [];
        let totalValor = 0;

        for (const p of payments) {
            totalValor += p.amount || 0;
            idsPagamentos.push(p._id.toString());

            console.log(`📌 Pagamento: ${p._id}`);
            console.log(`   💵 Valor: R$ ${(p.amount || 0).toFixed(2)}`);
            console.log(`   📅 Data: ${p.paymentDate ? moment(p.paymentDate).format('DD/MM/YYYY HH:mm') : 'N/A'}`);
            console.log(`   📝 Descrição: ${p.description || 'N/A'}`);
            console.log(`   💳 Método: ${p.paymentMethod || 'N/A'}`);
            console.log(`   📊 Status: ${p.status || 'N/A'}`);

            // Buscar appointment relacionado
            const aptId = p.appointmentId || p.appointment;
            if (aptId) {
                const apt = await Appointment.findById(aptId).lean();
                if (apt) {
                    idsAppointments.push(apt._id.toString());
                    console.log(`   📋 Appointment: ${apt._id}`);
                    console.log(`      Data: ${apt.date || 'N/A'} ${apt.time || ''}`);
                    console.log(`      Status: ${apt.operationalStatus || 'N/A'}`);
                } else {
                    console.log(`   ⚠️  Appointment órfão: ${aptId}`);
                }
            }

            // Buscar session relacionada
            const sessId = p.sessionId || p.session;
            if (sessId) {
                const sess = await Session.findById(sessId).lean();
                if (sess) {
                    idsSessions.push(sess._id.toString());
                    console.log(`   🗓️  Session: ${sess._id}`);
                }
            }

            console.log('');
        }

        console.log('='.repeat(80));
        console.log('📊 RESUMO:');
        console.log(`   💵 Valor total a limpar: R$ ${totalValor.toFixed(2)}`);
        console.log(`   💰 Pagamentos: ${idsPagamentos.length}`);
        console.log(`   📋 Appointments: ${idsAppointments.length}`);
        console.log(`   🗓️  Sessions: ${idsSessions.length}`);
        console.log('='.repeat(80));

        if (!CONFIRM) {
            console.log('\n⚠️  MODO SIMULAÇÃO - Nada foi alterado!');
            console.log('\n💡 Para DELETAR definitivamente, execute com: --confirm');
            console.log(`   node scripts/limpar-atendimentos-teste.js --confirm`);
            return;
        }

        // CONFIRMADO - Deletar tudo
        console.log('\n🗑️  DELETANDO REGISTROS...\n');

        // Deletar payments
        if (idsPagamentos.length > 0) {
            const resultPay = await Payment.deleteMany({
                _id: { $in: idsPagamentos }
            });
            console.log(`✅ Payments deletados: ${resultPay.deletedCount}`);
        }

        // Deletar appointments
        if (idsAppointments.length > 0) {
            const resultApt = await Appointment.deleteMany({
                _id: { $in: idsAppointments }
            });
            console.log(`✅ Appointments deletados: ${resultApt.deletedCount}`);
        }

        // Deletar sessions
        if (idsSessions.length > 0) {
            const resultSess = await Session.deleteMany({
                _id: { $in: idsSessions }
            });
            console.log(`✅ Sessions deletadas: ${resultSess.deletedCount}`);
        }

        console.log('\n' + '='.repeat(80));
        console.log('🎉 LIMPEZA CONCLUÍDA!');
        console.log('='.repeat(80));

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
Uso: node limpar-atendimentos-teste.js [opções]

Opções:
  --confirm          Confirma a exclusão (padrão é só simular)
  --patient <nome>   Nome do paciente (padrão: "Teste")
  --help, -h         Mostra esta ajuda

Exemplos:
  # Ver o que será deletado (dry-run)
  node limpar-atendimentos-teste.js

  # Deletar atendimentos do paciente "Teste"
  node limpar-atendimentos-teste.js --confirm

  # Deletar atendimentos de outro paciente
  node limpar-atendimentos-teste.js --confirm --patient "Pacote Teste"
`);
    process.exit(0);
}

limparAtendimentosTeste();
