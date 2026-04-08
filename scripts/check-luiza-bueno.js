/**
 * Análise da paciente Luiza Bueno Lima - 07/04/2026
 */

import mongoose from 'mongoose';
import moment from 'moment-timezone';
import Patient from '../models/Patient.js';
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';

const TIMEZONE = 'America/Sao_Paulo';

async function analyzeLuiza() {
    try {
        const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/test';
        await mongoose.connect(MONGO_URI);
        console.log('✅ Conectado ao MongoDB\n');

        // Buscar paciente Luiza Bueno Lima
        const patient = await Patient.findOne({
            fullName: { $regex: /luiza.*bueno.*lima/i }
        });

        if (!patient) {
            console.log('❌ Paciente Luiza Bueno Lima não encontrada');
            return;
        }

        console.log('👤 PACIENTE ENCONTRADA:');
        console.log(`   Nome: ${patient.fullName}`);
        console.log(`   ID: ${patient._id}`);
        console.log(`   Telefone: ${patient.phone || 'N/A'}`);
        console.log(`   Email: ${patient.email || 'N/A'}`);
        console.log('='.repeat(60));

        // Período do dia 07/04/2026
        const targetDate = moment.tz('2026-04-07', 'YYYY-MM-DD', TIMEZONE);
        const startOfDay = targetDate.clone().startOf('day').toDate();
        const endOfDay = targetDate.clone().endOf('day').toDate();

        console.log(`\n📅 ANALISANDO DIA: ${targetDate.format('DD/MM/YYYY')}`);
        console.log('-'.repeat(60));

        // 1. Agendamentos do dia
        const appointments = await Appointment.find({
            patient: patient._id,
            date: { $gte: startOfDay, $lte: endOfDay }
        }).populate('doctor').lean();

        console.log(`\n📋 AGENDAMENTOS (${appointments.length}):`);
        appointments.forEach((a, i) => {
            console.log(`\n   #${i+1} ID: ${a._id}`);
            console.log(`   Data/Hora: ${a.date} ${a.time}`);
            console.log(`   Status: ${a.operationalStatus}`);
            console.log(`   Médico: ${a.doctor?.fullName || 'N/A'}`);
            console.log(`   Valor: R$ ${a.value || 0}`);
            console.log(`   PaymentStatus: ${a.paymentStatus || 'N/A'}`);
            console.log(`   Convênio: ${a.billingType || 'particular'}`);
            if (a.insurance?.provider) {
                console.log(`   Plano: ${a.insurance.provider}`);
            }
        });

        // 2. Sessões do dia
        const sessions = await Session.find({
            patient: patient._id,
            date: { $gte: startOfDay, $lte: endOfDay }
        }).populate('doctor package').lean();

        console.log(`\n\n🗓️ SESSÕES (${sessions.length}):`);
        sessions.forEach((s, i) => {
            console.log(`\n   #${i+1} ID: ${s._id}`);
            console.log(`   Data/Hora: ${s.date} ${s.time}`);
            console.log(`   Status: ${s.status}`);
            console.log(`   Médico: ${s.doctor?.fullName || 'N/A'}`);
            console.log(`   Valor Sessão: R$ ${s.sessionValue || 0}`);
            console.log(`   IsPaid: ${s.isPaid}`);
            console.log(`   PaymentStatus: ${s.paymentStatus || 'N/A'}`);
            console.log(`   Package: ${s.package ? 'SIM - ' + s.package._id : 'AVULSA'}`);
        });

        // 3. Pagamentos do dia
        const payments = await Payment.find({
            patient: patient._id,
            paymentDate: { $gte: startOfDay, $lte: endOfDay }
        }).lean();

        console.log(`\n\n💰 PAGAMENTOS (${payments.length}):`);
        payments.forEach((p, i) => {
            console.log(`\n   #${i+1} ID: ${p._id}`);
            console.log(`   Valor: R$ ${p.amount}`);
            console.log(`   Status: ${p.status}`);
            console.log(`   Método: ${p.paymentMethod}`);
            console.log(`   Data: ${p.paymentDate}`);
            console.log(`   Package: ${p.package || 'AVULSO'}`);
        });

        // 4. Histórico recente (últimos 7 dias)
        const last7Days = moment.tz(TIMEZONE).subtract(7, 'days').toDate();
        
        const recentAppointments = await Appointment.find({
            patient: patient._id,
            date: { $gte: last7Days }
        }).sort({ date: -1 }).populate('doctor').lean();

        console.log(`\n\n📅 HISTÓRICO RECENTE (últimos 7 dias):`);
        recentAppointments.forEach((a, i) => {
            const dateStr = moment(a.date).format('DD/MM/YYYY');
            console.log(`   ${dateStr} ${a.time} - ${a.operationalStatus} - ${a.doctor?.fullName || 'N/A'}`);
        });

        // 5. Resumo
        console.log(`\n\n📊 RESUMO DO DIA ${targetDate.format('DD/MM/YYYY')}:`);
        console.log('-'.repeat(60));
        console.log(`   Agendamentos: ${appointments.length}`);
        console.log(`   Sessões: ${sessions.length}`);
        console.log(`   Pagamentos: ${payments.length}`);
        const totalPago = payments.filter(p => p.status === 'paid').reduce((sum, p) => sum + (p.amount || 0), 0);
        console.log(`   Total Pago: R$ ${totalPago.toFixed(2)}`);

    } catch (error) {
        console.error('❌ Erro:', error);
    } finally {
        await mongoose.disconnect();
        console.log('\n👋 Desconectado');
    }
}

analyzeLuiza();
