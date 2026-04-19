#!/usr/bin/env node
/**
 * 🔍 AUDITORIA: Isis Caldas Rebelatto
 * Valida consistência entre Payments (fonte de verdade) e Appointments/Sessions
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import Patient from '../models/Patient.js';
import Payment from '../models/Payment.js';
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';

const PATIENT_NAME = 'Isis Caldas Rebelatto';

async function run() {
    const uri = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/fono_inova_prod';
    await mongoose.connect(uri);
    console.log(`[AUDIT] Conectado. Auditando ${PATIENT_NAME}...\n`);

    const patient = await Patient.findOne({ fullName: PATIENT_NAME }).lean();
    if (!patient) {
        console.log(`[AUDIT] Paciente não encontrado.`);
        await mongoose.disconnect();
        return;
    }

    const patientId = patient._id;

    // 1. BUSCAR PAYMENTS (fonte de verdade)
    const payments = await Payment.find({ patient: patientId })
        .populate('appointment', 'date time serviceType sessionValue paymentStatus')
        .populate('doctor', 'fullName specialty')
        .sort({ paymentDate: -1 })
        .lean();

    console.log(`=== 💰 PAYMENTS (Fonte de Verdade) — ${payments.length} encontrados ===\n`);
    
    const pendingPayments = payments.filter(p => p.status === 'pending');
    const paidPayments = payments.filter(p => ['paid', 'completed', 'confirmed'].includes(p.status));

    console.log(`Total: ${payments.length}`);
    console.log(`Pendentes: ${pendingPayments.length} (R$ ${pendingPayments.reduce((s, p) => s + (p.amount || 0), 0)})`);
    console.log(`Pagos: ${paidPayments.length} (R$ ${paidPayments.reduce((s, p) => s + (p.amount || 0), 0)})\n`);

    console.log('--- PENDENTES ---');
    pendingPayments.forEach((p, i) => {
        console.log(`  ${i + 1}. R$ ${p.amount} | ${p.specialty || 'N/A'} | ${p.appointment?.date || 'sem data'} | PaymentID: ${p._id}`);
        console.log(`     appointment.paymentStatus: ${p.appointment?.paymentStatus || 'N/A'}`);
        console.log(`     appointment.sessionValue: ${p.appointment?.sessionValue || 0}`);
    });

    console.log('\n--- PAGOS (últimos 5) ---');
    paidPayments.slice(0, 5).forEach((p, i) => {
        console.log(`  ${i + 1}. R$ ${p.amount} | ${p.specialty || 'N/A'} | ${p.appointment?.date || 'sem data'}`);
    });

    // 2. BUSCAR APPOINTMENTS com paymentStatus "paid" mas sem payment pago no V2
    console.log('\n\n=== 📅 APPOINTMENTS com inconsistência ===\n');
    
    const appointments = await Appointment.find({ patient: patientId })
        .populate('doctor', 'fullName specialty')
        .populate('payment', 'amount status')
        .sort({ date: -1 })
        .lean();

    let inconsistentCount = 0;
    appointments.forEach(a => {
        const paymentStatus = a.paymentStatus;
        const paymentReal = a.payment;
        const hasRealPayment = paymentReal && ['paid', 'completed', 'confirmed'].includes(paymentReal.status);
        const isMarkedPaid = ['paid', 'package_paid'].includes(paymentStatus);

        // Inconsistência: appointment diz "paid" mas payment não está pago
        if (isMarkedPaid && !hasRealPayment) {
            inconsistentCount++;
            console.log(`  ❌ INCONSISTENTE:`);
            console.log(`     Data: ${a.date} ${a.time}`);
            console.log(`     appointment.paymentStatus: "${paymentStatus}"`);
            console.log(`     payment.status: "${paymentReal?.status || 'N/A'}"`);
            console.log(`     payment.amount: ${paymentReal?.amount || 'N/A'}`);
            console.log(`     sessionValue: ${a.sessionValue}`);
            console.log(`     serviceType: ${a.serviceType}`);
            console.log(`     Especialidade: ${a.doctor?.specialty || 'N/A'}`);
            console.log(`     AppointmentID: ${a._id}`);
            console.log();
        }
    });

    if (inconsistentCount === 0) {
        console.log('  ✅ Nenhuma inconsistência encontrada entre appointment e payment');
    } else {
        console.log(`  ⚠️  Total de inconsistências: ${inconsistentCount}`);
    }

    await mongoose.disconnect();
}

run().catch(err => {
    console.error('[AUDIT] Erro:', err);
    process.exit(1);
});
