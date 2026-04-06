#!/usr/bin/env node
/**
 * Script de Rebuild do PatientsView - VERSÃO SIMPLIFICADA
 * 
 * Uso: node scripts/rebuild-view-now.cjs
 */

const mongoose = require('mongoose');

// Carrega env
require('dotenv').config();

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

if (!MONGO_URI) {
  console.error('❌ MONGO_URI não encontrado no .env');
  process.exit(1);
}

// Schema simplificado da PatientsView
const patientsViewSchema = new mongoose.Schema({
  patientId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true, index: true },
  fullName: { type: String, required: true, index: true },
  normalizedName: { type: String, required: true, index: true },
  dateOfBirth: { type: Date },
  phone: { type: String, index: true },
  phoneDigits: { type: String, index: true },
  email: { type: String, lowercase: true },
  cpf: { type: String, index: true },
  cpfDigits: { type: String, index: true },
  mainComplaint: { type: String },
  healthPlan: { name: String, policyNumber: String },
  doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor' },
  doctorName: { type: String, index: true },
  specialty: { type: String, index: true },
  stats: {
    totalAppointments: { type: Number, default: 0 },
    totalCompleted: { type: Number, default: 0 },
    totalCanceled: { type: Number, default: 0 },
    totalNoShow: { type: Number, default: 0 },
    totalSessions: { type: Number, default: 0 },
    totalPackages: { type: Number, default: 0 },
    totalRevenue: { type: Number, default: 0 },
    totalPending: { type: Number, default: 0 },
    firstAppointmentDate: { type: Date },
    lastAppointmentDate: { type: Date },
    nextAppointmentDate: { type: Date }
  },
  lastAppointment: {
    id: mongoose.Schema.Types.ObjectId,
    date: Date,
    time: String,
    status: String,
    serviceType: String,
    doctorName: String
  },
  nextAppointment: {
    id: mongoose.Schema.Types.ObjectId,
    date: Date,
    time: String,
    status: String,
    serviceType: String,
    doctorName: String
  },
  balance: { current: { type: Number, default: 0 }, lastUpdated: { type: Date } },
  tags: [{ type: String, index: true }],
  status: { type: String, enum: ['active', 'inactive', 'prospect', 'churned'], default: 'active', index: true },
  snapshot: { version: { type: Number, default: 1 }, calculatedAt: { type: Date, default: Date.now }, isStale: { type: Boolean, default: false } }
}, { timestamps: true, collection: 'patients_view' });

const PatientsView = mongoose.model('PatientsView', patientsViewSchema);

// Patient Schema (simplificado)
const patientSchema = new mongoose.Schema({
  fullName: String,
  dateOfBirth: Date,
  phone: String,
  email: String,
  cpf: String,
  rg: String,
  gender: String,
  address: Object,
  healthPlan: Object,
  mainComplaint: String,
  emergencyContact: Object,
  doctor: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor' },
  status: String
}, { timestamps: true });

const Patient = mongoose.model('Patient', patientSchema, 'patients');

// Doctor Schema
const doctorSchema = new mongoose.Schema({
  name: String,
  specialty: String
}, { timestamps: true });

const Doctor = mongoose.model('Doctor', doctorSchema, 'doctors');

// Appointment Schema
const appointmentSchema = new mongoose.Schema({
  patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient' },
  doctor: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor' },
  date: Date,
  time: String,
  status: String,
  serviceType: String,
  doctorName: String
}, { timestamps: true });

const Appointment = mongoose.model('Appointment', appointmentSchema, 'appointments');

async function rebuildViews() {
  console.log('🔌 Conectando ao MongoDB...');
  await mongoose.connect(MONGO_URI);
  console.log('✅ Conectado!');

  try {
    // Limpa views existentes
    console.log('🗑️ Limpando views antigas...');
    const clearResult = await PatientsView.deleteMany({});
    console.log(`✅ ${clearResult.deletedCount} views removidas`);

    // Conta pacientes
    const totalPatients = await Patient.countDocuments();
    console.log(`📊 Total de pacientes: ${totalPatients}`);

    if (totalPatients === 0) {
      console.log('⚠️ Nenhum paciente encontrado');
      return;
    }

    // Busca todos os pacientes
    const patients = await Patient.find({}).lean();
    const doctors = await Doctor.find({}).lean();
    const doctorMap = new Map(doctors.map(d => [d._id.toString(), d]));

    // Busca agendamentos para stats
    const appointments = await Appointment.find({}).lean();
    const appointmentsByPatient = new Map();
    
    for (const apt of appointments) {
      const pid = apt.patient?.toString();
      if (!pid) continue;
      if (!appointmentsByPatient.has(pid)) {
        appointmentsByPatient.set(pid, []);
      }
      appointmentsByPatient.get(pid).push(apt);
    }

    // Rebuild em batch
    const BATCH_SIZE = 100;
    let processed = 0;
    let success = 0;
    let errors = 0;

    for (let i = 0; i < patients.length; i += BATCH_SIZE) {
      const batch = patients.slice(i, i + BATCH_SIZE);
      const views = [];

      for (const p of batch) {
        try {
          const doctor = p.doctor ? doctorMap.get(p.doctor.toString()) : null;
          const pAppointments = appointmentsByPatient.get(p._id.toString()) || [];
          
          // Calcula stats
          const completed = pAppointments.filter(a => a.status === 'completed' || a.status === 'Concluído').length;
          const canceled = pAppointments.filter(a => a.status === 'canceled' || a.status === 'Cancelado').length;
          const noShow = pAppointments.filter(a => a.status === 'no_show' || a.status === 'Não Compareceu').length;
          const sorted = pAppointments.sort((a, b) => new Date(b.date) - new Date(a.date));
          const lastApt = sorted[0];
          const nextApt = pAppointments.filter(a => new Date(a.date) >= new Date() && a.status !== 'canceled').sort((a, b) => new Date(a.date) - new Date(b.date))[0];

          const view = {
            patientId: p._id,
            fullName: p.fullName || 'Sem Nome',
            normalizedName: (p.fullName || 'Sem Nome').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(),
            dateOfBirth: p.dateOfBirth,
            phone: p.phone,
            phoneDigits: p.phone ? p.phone.replace(/\D/g, '') : null,
            email: p.email?.toLowerCase(),
            cpf: p.cpf,
            cpfDigits: p.cpf ? p.cpf.replace(/\D/g, '') : null,
            mainComplaint: p.mainComplaint,
            healthPlan: p.healthPlan,
            doctorId: p.doctor,
            doctorName: doctor?.name || 'Sem Médico',
            specialty: doctor?.specialty,
            stats: {
              totalAppointments: pAppointments.length,
              totalCompleted: completed,
              totalCanceled: canceled,
              totalNoShow: noShow,
              firstAppointmentDate: sorted.length > 0 ? sorted[sorted.length - 1].date : null,
              lastAppointmentDate: lastApt?.date || null,
              nextAppointmentDate: nextApt?.date || null
            },
            lastAppointment: lastApt ? {
              id: lastApt._id,
              date: lastApt.date,
              time: lastApt.time,
              status: lastApt.status,
              serviceType: lastApt.serviceType,
              doctorName: lastApt.doctorName || doctor?.name
            } : null,
            nextAppointment: nextApt ? {
              id: nextApt._id,
              date: nextApt.date,
              time: nextApt.time,
              status: nextApt.status,
              serviceType: nextApt.serviceType,
              doctorName: nextApt.doctorName || doctor?.name
            } : null,
            balance: { current: 0, lastUpdated: new Date() },
            status: p.status || 'active',
            snapshot: { version: 1, calculatedAt: new Date(), isStale: false }
          };
          
          views.push(view);
          success++;
        } catch (err) {
          console.error(`❌ Erro em ${p._id}: ${err.message}`);
          errors++;
        }
      }

      // Insere batch
      if (views.length > 0) {
        await PatientsView.insertMany(views, { ordered: false });
      }

      processed += batch.length;
      const progress = ((processed / totalPatients) * 100).toFixed(1);
      console.log(`⏳ ${progress}% (${processed}/${totalPatients}) | ✅ ${success} | ❌ ${errors}`);
    }

    // Verificação final
    const finalCount = await PatientsView.countDocuments();
    console.log('\n📊 RESUMO:');
    console.log(`   Total pacientes: ${totalPatients}`);
    console.log(`   Views criadas: ${finalCount}`);
    console.log(`   Sucessos: ${success}`);
    console.log(`   Erros: ${errors}`);
    
    if (finalCount !== totalPatients) {
      console.log(`⚠️ Atenção: ${totalPatients - finalCount} pacientes sem view`);
    } else {
      console.log('✅ View sincronizada com sucesso!');
    }

  } catch (error) {
    console.error('💥 Erro:', error.message);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Desconectado do MongoDB');
  }
}

rebuildViews();
