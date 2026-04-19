// scripts/listar-sessoes-convenio-detalhes.js
// Lista detalhes das sessões de convênio com valor zerado em MARÇO/2026
// para identificação manual do convênio (Anápolis vs Campinas)

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import moment from 'moment-timezone';
import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import Patient from '../models/Patient.js';
import Doctor from '../models/Doctor.js';
import Payment from '../models/Payment.js';

dotenv.config();

const TIMEZONE = 'America/Sao_Paulo';
const MARCO_START = moment.tz('2026-03-01', TIMEZONE).startOf('day').toDate();
const MARCO_END = moment.tz('2026-03-31', TIMEZONE).endOf('day').toDate();

const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
await mongoose.connect(mongoUri);

const sessions = await Session.find({
    status: 'completed',
    date: { $gte: MARCO_START, $lte: MARCO_END },
    $or: [
        { paymentMethod: 'convenio' },
        { insuranceGuide: { $exists: true, $ne: null } }
    ]
}).sort({ date: 1 }).lean();

console.log('=== SESSÕES DE CONVÊNIO — MARÇO/2026 ===\n');

const resultado = [];

for (const s of sessions) {
    const [appointment, patient, doctor, payment] = await Promise.all([
        Appointment.findById(s.appointmentId || s.appointment).select('insuranceProvider insurance insuranceGuide').lean(),
        Patient.findById(s.patient).select('fullName').lean(),
        Doctor.findById(s.doctor).select('fullName specialty').lean(),
        Payment.findOne({ $or: [{ session: s._id }, { sessionId: s._id.toString() }] }).select('amount insurance.provider').lean()
    ]);

    const precisaAtencao = (!payment || payment.amount === 0 || s.sessionValue === 0);
    const marker = precisaAtencao ? '🔴' : '🟢';

    resultado.push({
        marker,
        data: moment(s.date).tz(TIMEZONE).format('DD/MM/YYYY'),
        paciente: patient?.fullName || 'N/A',
        profissional: doctor?.fullName || 'N/A',
        especialidade: doctor?.specialty || 'N/A',
        tipoSessao: s.sessionType || s.serviceType || 'N/A',
        sessionValue: s.sessionValue || 0,
        paymentAmount: payment?.amount || 0,
        providerSessao: s.insuranceProvider || 'N/A',
        providerAppointment: appointment?.insuranceProvider || appointment?.insurance?.provider || 'N/A',
        providerPayment: payment?.insurance?.provider || 'N/A',
        sessionId: s._id.toString(),
        paymentId: payment?._id?.toString() || 'SEM'
    });
}

console.table(resultado.map(r => ({
    '': r.marker,
    'Data': r.data,
    'Paciente': r.paciente.substring(0, 25),
    'Profissional': r.profissional.substring(0, 20),
    'Especialidade': r.especialidade.substring(0, 15),
    'Tipo': r.tipoSessao.substring(0, 15),
    'Session$': r.sessionValue,
    'Payment$': r.paymentAmount,
    'Provider': r.providerPayment !== 'N/A' ? r.providerPayment.substring(0, 15) : r.providerAppointment.substring(0, 15)
})));

console.log('\n🔴 = Precisa de atenção (valor zerado ou sem Payment)');
console.log('🟢 = Já OK\n');

await mongoose.disconnect();
process.exit(0);
