#!/usr/bin/env node
/**
 * 🔍 Verifica status do appointment para complete
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Appointment from './models/Appointment.js';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

async function checkAppointment(appointmentId) {
    console.log(`🔍 Verificando appointment: ${appointmentId}\n`);
    
    await mongoose.connect(MONGO_URI);
    
    const apt = await Appointment.findById(appointmentId)
        .populate('session')
        .populate('package')
        .populate('payment')
        .lean();
    
    if (!apt) {
        console.log('❌ Appointment não encontrado');
        process.exit(1);
    }
    
    console.log('📋 ESTADO ATUAL:');
    console.log(`  _id: ${apt._id}`);
    console.log(`  clinicalStatus: ${apt.clinicalStatus}`);
    console.log(`  operationalStatus: ${apt.operationalStatus}`);
    console.log(`  paymentStatus: ${apt.paymentStatus}`);
    console.log(`  specialty: ${apt.specialty}`);
    console.log(`  serviceType: ${apt.serviceType}`);
    console.log(`  sessionType: ${apt.sessionType}`);
    console.log(`  billingType: ${apt.billingType}`);
    console.log(`  sessionValue: ${apt.sessionValue}`);
    console.log(`  has session: ${!!apt.session}`);
    console.log(`  has payment: ${!!apt.payment}`);
    console.log(`  has package: ${!!apt.package}`);
    
    console.log('\n✅ CHECKLIST PARA COMPLETE:');
    
    const checks = [
        { ok: apt.clinicalStatus !== 'completed', msg: 'Não está completed (pode completar)' },
        { ok: apt.operationalStatus === 'scheduled', msg: 'Status scheduled (pronto)' },
        { ok: ['particular', 'convenio', 'insurance'].includes(apt.billingType), msg: 'BillingType válido' },
        { ok: !!apt.specialty, msg: 'Tem specialty definida' },
        { ok: apt.sessionValue > 0 || apt.billingType !== 'particular', msg: 'Tem valor ou é convenio' }
    ];
    
    let allOk = true;
    checks.forEach(c => {
        const icon = c.ok ? '✅' : '❌';
        console.log(`  ${icon} ${c.msg}`);
        if (!c.ok) allOk = false;
    });
    
    console.log('\n' + '='.repeat(50));
    if (allOk) {
        console.log('✅ APPOINTMENT PRONTO PARA COMPLETE');
        console.log('\nExecute:');
        console.log(`  PATCH /api/v2/appointments/${appointmentId}/complete`);
    } else {
        console.log('⚠️  VERIFICAR ANTES DE COMPLETAR');
    }
    
    await mongoose.disconnect();
}

const id = process.argv[2] || '69d92ca6674d596845d7ced1';
checkAppointment(id).catch(console.error);
