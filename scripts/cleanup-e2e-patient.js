#!/usr/bin/env node
/**
 * 🧹 LIMPEZA PACIENTE E2E V2 1776088177
 * Remove todos os registros de teste para não poluir dashboard/financeiro
 * ORDEM: Payments → Appointments → Sessions → Packages → Patient
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import Payment from '../models/Payment.js';
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import Package from '../models/Package.js';
import Patient from '../models/Patient.js';

const PATIENT_NAME = 'Paciente E2E V2 1776088177';

async function run() {
    const uri = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/fono_inova_prod';
    console.log(`[CLEANUP] Conectando em: ${uri.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')}`);
    await mongoose.connect(uri);
    console.log(`[CLEANUP] Buscando paciente: ${PATIENT_NAME}`);

    const patient = await Patient.findOne({ fullName: PATIENT_NAME }).lean();
    if (!patient) {
        console.log(`[CLEANUP] Paciente não encontrado. Nada a fazer.`);
        await mongoose.disconnect();
        return;
    }

    const patientId = patient._id;
    console.log(`[CLEANUP] Paciente ID: ${patientId}`);

    // 1. Deletar Payments (🚨 mais importante — impacto financeiro)
    const paymentsDelete = await Payment.deleteMany({ patient: patientId });
    console.log(`[CLEANUP] Payments deletados: ${paymentsDelete.deletedCount}`);

    // 2. Deletar Appointments
    const appointmentsDelete = await Appointment.deleteMany({ patient: patientId });
    console.log(`[CLEANUP] Appointments deletados: ${appointmentsDelete.deletedCount}`);

    // 3. Deletar Sessions
    const sessionsDelete = await Session.deleteMany({ patient: patientId });
    console.log(`[CLEANUP] Sessions deletados: ${sessionsDelete.deletedCount}`);

    // 4. Deletar Packages
    const packagesDelete = await Package.deleteMany({ patient: patientId });
    console.log(`[CLEANUP] Packages deletados: ${packagesDelete.deletedCount}`);

    // 5. Deletar Patient
    await Patient.deleteOne({ _id: patientId });
    console.log(`[CLEANUP] Paciente deletado: ${PATIENT_NAME}`);

    // 6. Limpar PatientBalance se existir
    const { default: PatientBalance } = await import('../models/PatientBalance.js');
    const balanceDelete = await PatientBalance.deleteOne({ patient: patientId });
    console.log(`[CLEANUP] PatientBalance deletado: ${balanceDelete.deletedCount}`);

    console.log(`[CLEANUP] ✅ Limpeza completa para ${PATIENT_NAME}`);
    await mongoose.disconnect();
}

run().catch(err => {
    console.error('[CLEANUP] Erro:', err);
    process.exit(1);
});
