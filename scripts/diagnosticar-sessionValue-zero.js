// 🔍 DIAGNÓSTICO: SessionValue zerado no fechamento diário
// Analisa appointments com sessionValue = 0 ou muito baixo
//
// Uso: node diagnosticar-sessionValue-zero.js <data>
// Exemplo: node diagnosticar-sessionValue-zero.js 2026-04-09

import mongoose from 'mongoose';
import dotenv from 'dotenv';

import Appointment from '../models/Appointment.js';
import Patient from '../models/Patient.js';
import Package from '../models/Package.js';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';
const DATA_ALVO = process.argv[2] || '2026-04-09';

async function diagnosticar() {
    console.log('========================================');
    console.log(`🔍 DIAGNÓSTICO: SessionValue - ${DATA_ALVO}`);
    console.log('========================================\n');

    await mongoose.connect(MONGO_URI);
    console.log('✅ Conectado ao MongoDB\n');

    // Buscar appointments da data
    const dataInicio = new Date(DATA_ALVO + 'T00:00:00.000Z');
    const dataFim = new Date(DATA_ALVO + 'T23:59:59.999Z');

    const appointments = await Appointment.find({
        date: {
            $gte: dataInicio,
            $lte: dataFim
        },
        isDeleted: { $ne: true }
    }).sort({ time: 1 });

    console.log(`📅 ${appointments.length} appointments em ${DATA_ALVO}\n`);

    const problemas = [];
    const corretos = [];

    for (const apt of appointments) {
        const aptId = apt._id.toString();
        const sessionValue = apt.sessionValue || 0;
        
        // Buscar paciente para ver o valor da sessão
        const patient = await Patient.findById(apt.patient);
        
        // Buscar pacote se for sessão de pacote
        let packageInfo = null;
        if (apt.package || apt.isPackage) {
            packageInfo = await Package.findById(apt.package);
        }

        // Determinar valor esperado
        let valorEsperado = 0;
        let fonteValor = '';

        if (apt.isPackage && packageInfo) {
            // Sessão de pacote - calcular valor unitário
            const totalSessions = packageInfo.totalSessions || packageInfo.sessions?.length || 1;
            valorEsperado = packageInfo.totalValue / totalSessions;
            fonteValor = `Pacote (${packageInfo.totalValue}/${totalSessions})`;
        } else if (apt.serviceType === 'evaluation' || apt.service === 'evaluation') {
            // Avaliação - pegar valor do paciente ou padrão
            valorEsperado = patient?.evaluationValue || patient?.sessionValue || 200;
            fonteValor = 'Avaliação (padrão ou paciente)';
        } else {
            // Sessão regular
            valorEsperado = patient?.sessionValue || 150;
            fonteValor = 'Sessão (padrão ou paciente)';
        }

        // Verificar se há problema
        const temProblema = sessionValue === 0 || sessionValue < 1 || sessionValue < (valorEsperado * 0.5);

        const info = {
            aptId,
            patient: apt.patient?.toString(),
            patientName: patient?.fullName || 'N/D',
            service: apt.service || apt.serviceType,
            isPackage: apt.isPackage,
            sessionValue,
            valorEsperado: Math.round(valorEsperado * 100) / 100,
            fonteValor,
            packageId: apt.package?.toString(),
            operationalStatus: apt.operationalStatus
        };

        if (temProblema) {
            problemas.push(info);
        } else {
            corretos.push(info);
        }
    }

    // RELATÓRIO
    console.log('========================================');
    console.log('📊 RELATÓRIO');
    console.log('========================================');
    console.log(`\n✅ Com valor correto: ${corretos.length}`);
    console.log(`❌ Com problema: ${problemas.length}`);

    if (problemas.length > 0) {
        console.log('\n❌ PROBLEMAS ENCONTRADOS:\n');
        problemas.forEach((p, i) => {
            console.log(`${i + 1}. ${p.aptId}`);
            console.log(`   Paciente: ${p.patientName}`);
            console.log(`   Serviço: ${p.service} ${p.isPackage ? '(PACOTE)' : ''}`);
            console.log(`   Valor atual: R$ ${p.sessionValue}`);
            console.log(`   Valor esperado: R$ ${p.valorEsperado}`);
            console.log(`   Fonte: ${p.fonteValor}`);
            console.log(`   Status: ${p.operationalStatus}`);
            console.log('');
        });

        // Comando para corrigir
        console.log('\n// Comando para corrigir via MongoDB:\n');
        console.log('// Exemplo de correção manual:');
        console.log('db.appointments.updateOne(');
        console.log('  { _id: ObjectId("ID_AQUI") },');
        console.log('  { $set: { sessionValue: VALOR_CORRETO } }');
        console.log(');');
    }

    await mongoose.disconnect();
    console.log('\n👋 Done!');
    process.exit(0);
}

diagnosticar().catch(err => {
    console.error('💥 Erro:', err);
    process.exit(1);
});
