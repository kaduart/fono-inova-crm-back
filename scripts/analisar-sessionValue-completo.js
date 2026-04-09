// 🔍 ANÁLISE COMPLETA: SessionValue em Appointments
// Analisa appointments com valor zerado e mostra os relacionamentos
//
// Uso: node analisar-sessionValue-completo.js

import mongoose from 'mongoose';
import dotenv from 'dotenv';

import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';
import Patient from '../models/Patient.js';
import Package from '../models/Package.js';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';

async function analisar() {
    console.log('========================================');
    console.log('🔍 ANÁLISE: SessionValue - Cenário Real');
    console.log('========================================\n');

    await mongoose.connect(MONGO_URI);
    console.log('✅ Conectado ao MongoDB\n');

    // Buscar appointments com valor zerado (limitado a 20 para análise)
    const appointments = await Appointment.find({
        $or: [
            { sessionValue: { $exists: false } },
            { sessionValue: null },
            { sessionValue: 0 },
            { sessionValue: { $lt: 1 } }
        ],
        isDeleted: { $ne: true }
    }).sort({ date: -1 }).limit(20);

    console.log(`📦 Analisando ${appointments.length} appointments com valor zerado\n`);
    console.log('═'.repeat(80));

    for (let i = 0; i < appointments.length; i++) {
        const apt = appointments[i];
        console.log(`\n${i + 1}. APPOINTMENT: ${apt._id}`);
        console.log('─'.repeat(60));
        console.log(`   Paciente ID: ${apt.patient}`);
        console.log(`   Data: ${apt.date?.toISOString().split('T')[0]} ${apt.time || ''}`);
        console.log(`   Service: ${apt.service || apt.serviceType || 'N/D'}`);
        console.log(`   isPackage: ${apt.isPackage || false}`);
        console.log(`   sessionValue ATUAL: R$ ${apt.sessionValue || 0}`);
        console.log(`   Status: ${apt.operationalStatus}`);

        // Buscar Paciente
        const patient = await Patient.findById(apt.patient);
        if (patient) {
            console.log(`\n   👤 PACIENTE:`);
            console.log(`      Nome: ${patient.fullName}`);
            console.log(`      sessionValue: R$ ${patient.sessionValue || 'N/D'}`);
            console.log(`      evaluationValue: R$ ${patient.evaluationValue || 'N/D'}`);
        } else {
            console.log(`\n   👤 PACIENTE: Não encontrado`);
        }

        // Buscar Session
        const session = await Session.findOne({
            $or: [
                { appointmentId: apt._id },
                { _id: apt.session }
            ]
        });
        if (session) {
            console.log(`\n   📋 SESSION:`);
            console.log(`      ID: ${session._id}`);
            console.log(`      Status: ${session.status}`);
            console.log(`      Valor: R$ ${session.value || session.sessionValue || 'N/D'}`);
            console.log(`      Evolução: ${session.evolution ? 'Tem' : 'Não tem'}`);
        } else {
            console.log(`\n   📋 SESSION: Não encontrada`);
        }

        // Buscar Package
        if (apt.package || apt.isPackage) {
            const packageInfo = await Package.findById(apt.package);
            if (packageInfo) {
                console.log(`\n   📦 PACOTE:`);
                console.log(`      ID: ${packageInfo._id}`);
                console.log(`      Nome: ${packageInfo.name || 'N/D'}`);
                console.log(`      totalValue: R$ ${packageInfo.totalValue || 'N/D'}`);
                console.log(`      totalSessions: ${packageInfo.totalSessions || packageInfo.sessions?.length || 'N/D'}`);
                console.log(`      sessionValue: R$ ${packageInfo.sessionValue || 'N/D'}`);
                
                // Calcular valor unitário
                if (packageInfo.totalValue && packageInfo.totalSessions) {
                    const unitValue = packageInfo.totalValue / packageInfo.totalSessions;
                    console.log(`      Valor calculado por sessão: R$ ${unitValue.toFixed(2)}`);
                }
            } else {
                console.log(`\n   📦 PACOTE: Não encontrado (ID: ${apt.package})`);
            }
        }

        // Buscar Payment
        const payment = await Payment.findOne({
            $or: [
                { appointmentId: apt._id },
                { _id: apt.payment }
            ]
        });
        if (payment) {
            console.log(`\n   💰 PAYMENT:`);
            console.log(`      ID: ${payment._id}`);
            console.log(`      Valor: R$ ${payment.amount}`);
            console.log(`      Status: ${payment.status}`);
        } else {
            console.log(`\n   💰 PAYMENT: Não encontrado`);
        }

        // Onde o valor DEVERIA vir:
        console.log(`\n   🎯 FONTE ESPERADA DO VALOR:`);
        if (apt.isPackage || apt.package) {
            console.log(`      → Deveria vir do PACOTE (sessionValue calculado)`);
        } else if (apt.service === 'evaluation' || apt.serviceType === 'evaluation') {
            console.log(`      → Deveria vir do PACIENTE (evaluationValue)`);
        } else {
            console.log(`      → Deveria vir do PACIENTE (sessionValue)`);
        }

        console.log('\n' + '═'.repeat(80));
    }

    // Contagem geral
    const totalZerados = await Appointment.countDocuments({
        $or: [
            { sessionValue: { $exists: false } },
            { sessionValue: null },
            { sessionValue: 0 }
        ],
        isDeleted: { $ne: true }
    });

    console.log(`\n📊 TOTAL GERAL: ${totalZerados} appointments com sessionValue zerado`);

    await mongoose.disconnect();
    console.log('\n👋 Análise concluída!');
    process.exit(0);
}

analisar().catch(err => {
    console.error('💥 Erro:', err);
    process.exit(1);
});
