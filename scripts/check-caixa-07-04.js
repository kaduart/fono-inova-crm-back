/**
 * Análise do Caixa - 07/04/2026
 * Verifica pagamentos e agendamentos do dia
 */

import mongoose from 'mongoose';
import moment from 'moment-timezone';
import Payment from '../models/Payment.js';
import Appointment from '../models/Appointment.js';

const TIMEZONE = 'America/Sao_Paulo';

async function analyzeCaixa() {
    try {
        const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/test';
        await mongoose.connect(MONGO_URI);
        console.log('✅ Conectado ao MongoDB\n');

        // Período do dia 07/04/2026
        const targetDate = moment.tz('2026-04-07', 'YYYY-MM-DD', TIMEZONE);
        const startOfDay = targetDate.clone().startOf('day').toDate();
        const endOfDay = targetDate.clone().endOf('day').toDate();
        
        console.log('📅 Analisando dia:', targetDate.format('DD/MM/YYYY'));
        console.log('🕐 Período:', startOfDay.toISOString(), 'até', endOfDay.toISOString());
        console.log('=' .repeat(60));

        // 1. Buscar pagamentos do dia
        const payments = await Payment.find({
            paymentDate: { $gte: startOfDay, $lte: endOfDay }
        }).populate('patient doctor appointment').lean();

        console.log(`\n💰 PAGAMENTOS ENCONTRADOS: ${payments.length}`);
        console.log('-'.repeat(60));
        
        let totalReceived = 0;
        payments.forEach((p, i) => {
            totalReceived += p.amount || 0;
            console.log(`\n#${i+1} ID: ${p._id}`);
            console.log(`   Paciente: ${p.patient?.fullName || 'N/A'}`);
            console.log(`   Valor: R$ ${p.amount}`);
            console.log(`   Status: ${p.status}`);
            console.log(`   Método: ${p.paymentMethod}`);
            console.log(`   Data pagamento: ${p.paymentDate}`);
            console.log(`   Appointment: ${p.appointment?._id || 'N/A'}`);
            console.log(`   Package: ${p.package || 'AVULSO'}`);
        });

        console.log(`\n💵 Total em pagamentos: R$ ${totalReceived.toFixed(2)}`);

        // 2. Buscar agendamentos concluídos do dia
        const appointments = await Appointment.find({
            date: { $gte: startOfDay, $lte: endOfDay },
            operationalStatus: { $in: ['completed', 'concluded'] }
        }).populate('patient doctor').lean();

        console.log(`\n\n📋 AGENDAMENTOS CONCLUÍDOS: ${appointments.length}`);
        console.log('-'.repeat(60));
        
        appointments.forEach((a, i) => {
            console.log(`\n#${i+1} ID: ${a._id}`);
            console.log(`   Paciente: ${a.patient?.fullName || 'N/A'}`);
            console.log(`   Data: ${a.date}`);
            console.log(`   Hora: ${a.time}`);
            console.log(`   Status: ${a.operationalStatus}`);
            console.log(`   Valor: R$ ${a.value || 0}`);
            console.log(`   PaymentStatus: ${a.paymentStatus || 'N/A'}`);
        });

        // 3. Verificar agendamentos com pagamento pendente
        const pendingPayments = await Appointment.find({
            date: { $gte: startOfDay, $lte: endOfDay },
            operationalStatus: { $in: ['completed', 'concluded'] },
            $or: [
                { paymentStatus: { $exists: false } },
                { paymentStatus: 'pending' }
            ]
        }).populate('patient').lean();

        console.log(`\n\n⚠️  CONCLUÍDOS SEM PAGAMENTO: ${pendingPayments.length}`);
        console.log('-'.repeat(60));
        
        pendingPayments.forEach((a, i) => {
            console.log(`\n#${i+1} ID: ${a._id}`);
            console.log(`   Paciente: ${a.patient?.fullName || 'N/A'}`);
            console.log(`   Data: ${a.date} ${a.time}`);
            console.log(`   Valor: R$ ${a.value || 0}`);
        });

        // 4. Resumo por método de pagamento
        const byMethod = {};
        payments.forEach(p => {
            const method = p.paymentMethod || 'unknown';
            byMethod[method] = (byMethod[method] || 0) + (p.amount || 0);
        });

        console.log(`\n\n📊 RESUMO POR MÉTODO:`);
        console.log('-'.repeat(60));
        Object.entries(byMethod).forEach(([method, total]) => {
            console.log(`   ${method}: R$ ${total.toFixed(2)}`);
        });

        console.log(`\n   TOTAL GERAL: R$ ${totalReceived.toFixed(2)}`);

    } catch (error) {
        console.error('❌ Erro:', error);
    } finally {
        await mongoose.disconnect();
        console.log('\n👋 Desconectado');
    }
}

analyzeCaixa();
