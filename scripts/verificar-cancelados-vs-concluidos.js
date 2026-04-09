// 🔍 Verifica appointments "cancelados" que deveriam ser "concluídos"
// USO: node verificar-cancelados-vs-concluidos.js
//
// Este script identifica appointments marcados como 'canceled' 
// mas que têm Session completed ou Payment pago (deveriam ser 'completed')

import mongoose from 'mongoose';
import dotenv from 'dotenv';

import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';

async function verificarCancelados() {
    console.log('========================================');
    console.log('🔍 VERIFICAÇÃO: Cancelados vs Concluídos');
    console.log('========================================\n');

    await mongoose.connect(MONGO_URI);
    console.log('✅ Conectado ao MongoDB\n');

    const problemas = [];
    const stats = {
        canceladosTotal: 0,
        comSessionCompleted: 0,
        comPaymentPaid: 0,
        semVinculo: 0
    };

    // ============================================
    // 1. BUSCAR APPOINTMENTS CANCELADOS
    // ============================================
    console.log('🔍 Buscando appointments cancelados...\n');

    const cancelados = await Appointment.find({
        operationalStatus: { $in: ['canceled', 'cancelado'] },
        isDeleted: { $ne: true }
    }).sort({ date: -1 }).limit(2000);

    console.log(`📦 ${cancelados.length} appointments cancelados encontrados\n`);
    stats.canceladosTotal = cancelados.length;

    // ============================================
    // 2. VERIFICAR CADA UM
    // ============================================
    for (const apt of cancelados) {
        const aptId = apt._id.toString();
        
        // Buscar Session
        const session = await Session.findOne({
            $or: [
                { appointmentId: apt._id },
                { _id: apt.session }
            ],
            isDeleted: { $ne: true }
        });

        // Buscar Payment
        const payment = await Payment.findOne({
            $or: [
                { appointmentId: apt._id },
                { _id: apt.payment }
            ]
        });

        const temSessionCompleted = session && ['completed', 'finished', 'done'].includes(session.status);
        const temPaymentPago = payment && ['paid', 'completed'].includes(payment.status);

        // Se tem indício de que foi concluído
        if (temSessionCompleted || temPaymentPago) {
            const motivo = [];
            if (temSessionCompleted) motivo.push(`Session: ${session.status}`);
            if (temPaymentPago) motivo.push(`Payment: ${payment.status}`);

            console.log(`⚠️  PROBLEMA ENCONTRADO:`);
            console.log(`   Appointment: ${aptId}`);
            console.log(`   Paciente: ${apt.patient || 'N/D'}`);
            console.log(`   Data: ${apt.date?.toISOString().split('T')[0]} ${apt.time || ''}`);
            console.log(`   Status atual: ${apt.operationalStatus}`);
            console.log(`   Deveria ser: COMPLETED`);
            console.log(`   Motivo: ${motivo.join(' + ')}`);
            console.log(`   Session: ${session?._id || 'N/A'} (${session?.status || 'N/A'})`);
            console.log(`   Payment: ${payment?._id || 'N/A'} (${payment?.status || 'N/A'})`);
            console.log('');

            problemas.push({
                appointmentId: aptId,
                patient: apt.patient?.toString(),
                date: apt.date,
                time: apt.time,
                sessionId: session?._id?.toString(),
                sessionStatus: session?.status,
                paymentId: payment?._id?.toString(),
                paymentStatus: payment?.status,
                motivo: motivo.join(', ')
            });

            if (temSessionCompleted) stats.comSessionCompleted++;
            if (temPaymentPago) stats.comPaymentPaid++;
        } else {
            stats.semVinculo++;
        }
    }

    // ============================================
    // 3. RELATÓRIO
    // ============================================
    console.log('========================================');
    console.log('📊 RELATÓRIO');
    console.log('========================================');
    console.log(`Total cancelados analisados: ${stats.canceladosTotal}`);
    console.log(`Problemas encontrados: ${problemas.length}`);
    console.log(`  → Com Session completed: ${stats.comSessionCompleted}`);
    console.log(`  → Com Payment pago: ${stats.comPaymentPaid}`);
    console.log(`Cancelados válidos (sem vínculo): ${stats.semVinculo}`);

    if (problemas.length > 0) {
        console.log('\n========================================');
        console.log('📝 LISTA PARA CORREÇÃO');
        console.log('========================================');
        
        // Gerar comando MongoDB para correção
        console.log('\n// Comando MongoDB para corrigir esses appointments:\n');
        console.log('const idsParaCorrigir = [');
        problemas.forEach(p => {
            console.log(`  ObjectId("${p.appointmentId}"), // ${p.motivo}`);
        });
        console.log('];\n');
        console.log('db.appointments.updateMany(');
        console.log('  { _id: { $in: idsParaCorrigir } },');
        console.log('  { $set: { operationalStatus: "completed" } }');
        console.log(');');

        // Também salvar em arquivo JSON
        const fs = await import('fs');
        const arquivoSaida = `cancelados-para-corrigir-${Date.now()}.json`;
        fs.writeFileSync(arquivoSaida, JSON.stringify(problemas, null, 2));
        console.log(`\n💾 Lista detalhada salva em: ${arquivoSaida}`);
    }

    await mongoose.disconnect();
    console.log('\n👋 Done!');
    process.exit(0);
}

verificarCancelados().catch(err => {
    console.error('💥 Erro:', err);
    process.exit(1);
});
