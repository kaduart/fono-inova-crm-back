// Script para listar atendimentos pendentes que estão contaminando o dashboard
// Execute: node back/scripts/listar-atendimentos-pendentes.js

import mongoose from 'mongoose';
import moment from 'moment-timezone';

const uri = process.env.MONGODB_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';
const TIMEZONE = 'America/Sao_Paulo';

async function listarPendentes() {
    try {
        await mongoose.connect(uri);
        console.log('🔌 Conectado ao MongoDB\n');

        // Schema dinâmico para consulta
        const Payment = mongoose.model('Payment', new mongoose.Schema({}, { strict: false }));
        const Appointment = mongoose.model('Appointment', new mongoose.Schema({}, { strict: false }));
        const Patient = mongoose.model('Patient', new mongoose.Schema({}, { strict: false }));

        // Período: Abril/2026 (baseado no JSON que você mostrou: "date": "2026-04-06")
        const targetDate = moment.tz('2026-04-06', TIMEZONE);
        const startOfMonth = targetDate.clone().startOf('month');
        const endOfMonth = targetDate.clone().endOf('month');

        console.log('📅 Período:', startOfMonth.format('DD/MM/YYYY'), 'até', endOfMonth.format('DD/MM/YYYY'));
        console.log('=' .repeat(80));

        // Buscar pagamentos pendentes
        const pendentes = await Payment.find({
            status: 'pending',
            paymentDate: {
                $gte: startOfMonth.toDate(),
                $lte: endOfMonth.toDate()
            }
        }).sort({ paymentDate: 1, amount: -1 }).lean();

        console.log(`\n🚨 TOTAL DE PAGAMENTOS PENDENTES: ${pendentes.length}\n`);

        let totalValor = 0;

        for (let i = 0; i < pendentes.length; i++) {
            const p = pendentes[i];
            totalValor += p.amount || 0;

            // Buscar dados relacionados
            const appointment = p.appointmentId || p.appointment 
                ? await Appointment.findById(p.appointmentId || p.appointment).lean()
                : null;
            
            const patient = p.patientId || p.patient
                ? await Patient.findById(p.patientId || p.patient).lean()
                : null;

            console.log(`\n#${i + 1} - ID: ${p._id}`);
            console.log('  💰 Valor:', `R$ ${(p.amount || 0).toFixed(2)}`);
            console.log('  📅 Data Pagamento:', p.paymentDate ? moment(p.paymentDate).format('DD/MM/YYYY') : 'N/A');
            console.log('  📊 Status:', p.status);
            console.log('  📝 Descrição:', p.description || 'N/A');
            console.log('  🔗 Source:', p.source || 'N/A');
            console.log('  💳 Billing Type:', p.billingType || 'N/A');
            console.log('  📦 Package ID:', p.packageId || p.package || 'N/A');
            
            if (patient) {
                console.log('  👤 Paciente:', patient.fullName || patient.name || 'N/A');
                console.log('  📱 Telefone:', patient.phone || 'N/A');
            }
            
            if (appointment) {
                console.log('  📋 Appointment Status:', appointment.operationalStatus || 'N/A');
                console.log('  🗓️  Appointment Data:', appointment.date || 'N/A');
                console.log('  ⏰ Appointment Hora:', appointment.time || 'N/A');
            }
            
            // Verificar se tem appointmentId mas o appointment não existe (órfão)
            if ((p.appointmentId || p.appointment) && !appointment) {
                console.log('  ⚠️  ALERTA: Payment órfão - Appointment não existe!');
            }
            
            // Verificar se tem packageId
            if (p.packageId || p.package) {
                console.log('  📦 É de PACOTE: Sim');
            }

            console.log('-'.repeat(80));
        }

        console.log('\n' + '='.repeat(80));
        console.log('💵 VALOR TOTAL PENDENTE:', `R$ ${totalValor.toFixed(2)}`);
        console.log('📝 RESUMO:');
        console.log(`   - ${pendentes.filter(p => p.packageId || p.package).length} pagamentos de PACOTE`);
        console.log(`   - ${pendentes.filter(p => !p.packageId && !p.package).length} pagamentos avulsos`);
        console.log(`   - ${pendentes.filter(p => (p.appointmentId || p.appointment) && !Appointment.findById(p.appointmentId || p.appointment)).length} payments órfãos (appointment deletado)`);

    } catch (err) {
        console.error('❌ Erro:', err.message);
    } finally {
        await mongoose.disconnect();
        console.log('\n🔌 Desconectado do MongoDB');
    }
}

listarPendentes();
