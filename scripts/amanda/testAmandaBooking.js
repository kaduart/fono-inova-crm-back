import dotenv from "dotenv";
import mongoose from "mongoose";
import {
    autoBookAppointment,
    findAvailableSlots,
    formatSlot
} from '../../services/amandaBookingService.js';

dotenv.config();

// Cores para terminal
const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
};

function log(color, symbol, message) {
    console.log(`${color}${symbol}${colors.reset} ${message}`);
}

// ============================================================================
// 🎯 TESTE COMPLETO
// ============================================================================

async function testCompleteFlow() {
    log(colors.cyan, '🧪', 'INICIANDO TESTE DO FLUXO COMPLETO DE AGENDAMENTO\n');

    try {
        // 0️⃣ Conecta ao MongoDB
        log(colors.blue, '📡', 'Conectando ao MongoDB...');
        await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
        log(colors.green, '✅', 'Conectado ao MongoDB\n');

        // ====================================================================
        // 1️⃣ TESTE: BUSCA DE SLOTS DISPONÍVEIS
        // ====================================================================
        log(colors.cyan, '1️⃣', 'TESTANDO: Busca de slots disponíveis');
        log(colors.yellow, '  ', 'Área: Fonoaudiologia | Próximos 7 dias');

        const slots = await findAvailableSlots({
            therapyArea: 'fonoaudiologia',
            preferredPeriod: null,
            daysAhead: 7
        });

        if (!slots) {
            log(colors.red, '❌', 'Nenhum slot encontrado');
            log(colors.yellow, '⚠️', 'Possíveis causas:');
            console.log('   - Nenhum médico ativo de fonoaudiologia');
            console.log('   - Todos os horários estão ocupados');
            console.log('   - Erro na configuração weeklyAvailability');
            process.exit(1);
        }

        log(colors.green, '✅', 'Slots encontrados com sucesso!');
        console.log('\n   📅 SLOT PRINCIPAL:');
        console.log('      ' + formatSlot(slots.primary));

        if (slots.alternativesSamePeriod.length > 0) {
            console.log('\n   📅 ALTERNATIVAS (MESMO PERÍODO):');
            slots.alternativesSamePeriod.slice(0, 2).forEach((s, i) => {
                console.log(`      ${i + 2}) ${formatSlot(s)}`);
            });
        }

        console.log(`\n   📊 Total de slots disponíveis: ${slots.totalFound}`);

        // ====================================================================
        // 2️⃣ TESTE: CRIAÇÃO DE AGENDAMENTO
        // ====================================================================
        log(colors.cyan, '\n2️⃣', 'TESTANDO: Criação de agendamento automático');

        const testPatientInfo = {
            fullName: 'João Silva Teste Amanda',
            birthDate: '2015-03-20',
            phone: '62999887766',
            email: 'joao.teste.amanda@clinicafonoinova.com.br'
        };

        log(colors.yellow, '  ', `Paciente: ${testPatientInfo.fullName}`);
        log(colors.yellow, '  ', `Data escolhida: ${slots.primary.date} às ${slots.primary.time}`);
        log(colors.yellow, '  ', `Profissional: ${slots.primary.doctorName}`);

        const result = await autoBookAppointment({
            lead: { _id: new mongoose.Types.ObjectId() }, // Lead fake para teste
            chosenSlot: slots.primary,
            patientInfo: testPatientInfo
        });

        // ====================================================================
        // 3️⃣ VALIDAÇÃO DOS RESULTADOS
        // ====================================================================
        if (result.success) {
            log(colors.green, '\n✅', 'AGENDAMENTO CRIADO COM SUCESSO!');

            console.log('\n   📋 DETALHES DO AGENDAMENTO:');
            console.log(`      • Patient ID: ${result.patientId}`);
            console.log(`      • Appointment ID: ${result.appointment?._id || 'N/A'}`);
            console.log(`      • Payment ID: ${result.payment?._id || 'N/A'}`);
            console.log(`      • Session ID: ${result.session?._id || 'N/A'}`);
            console.log(`      • Paciente novo? ${result.wasNewPatient ? 'Sim' : 'Não'}`);

            log(colors.green, '\n🎉', 'TESTE PASSOU! Sistema funcionando perfeitamente.');

        } else {
            log(colors.red, '\n❌', 'FALHA AO CRIAR AGENDAMENTO');

            if (result.code === 'TIME_CONFLICT') {
                log(colors.yellow, '⚠️', 'Conflito de horário detectado');
                console.log('   → Isso é esperado se o slot foi ocupado durante o teste');
            } else {
                log(colors.red, '💥', `Erro: ${result.error}`);

                if (result.error.includes('404')) {
                    console.log('\n   ⚠️  Verifique se as rotas estão corretas:');
                    console.log(`      POST ${process.env.INTERNAL_BASE_URL}/api/patients/add`);
                    console.log(`      POST ${process.env.INTERNAL_BASE_URL}/api/appointments`);
                }

                if (result.error.includes('401') || result.error.includes('403')) {
                    console.log('\n   ⚠️  Verifique o ADMIN_API_TOKEN no .env');
                }
            }
        }

    } catch (error) {
        log(colors.red, '\n❌', 'ERRO FATAL NO TESTE');
        console.error('\n   Detalhes:', error.message);
        console.error('\n   Stack:', error.stack);
        process.exit(1);
    } finally {
        // Desconecta do MongoDB
        await mongoose.disconnect();
        log(colors.blue, '\n📡', 'Desconectado do MongoDB');
    }
}