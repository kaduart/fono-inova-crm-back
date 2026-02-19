#!/usr/bin/env node
/**
 * Script de Auditoria de Agendamento (Appointment)
 * Verifica integridade após importação do pré-agendamento
 */

import mongoose from 'mongoose';
import Appointment from '../models/Appointment.js';
import Patient from '../models/Patient.js';
import Doctor from '../models/Doctor.js';
import PreAgendamento from '../models/PreAgendamento.js';
import dotenv from 'dotenv';

dotenv.config();

const APPOINTMENT_ID = process.argv[2] || '69976881640dbc8aefa146cc';
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/crm-clinica';

async function auditar() {
  try {
    console.log('🔌 Conectando ao MongoDB...');
    await mongoose.connect(MONGO_URI);
    console.log('✅ Conectado!');
    console.log('='.repeat(70));
    
    console.log(`\n📋 AUDITANDO AGENDAMENTO: ${APPOINTMENT_ID}\n`);
    
    const apt = await Appointment.findById(APPOINTMENT_ID)
      .populate('patient', 'fullName phone email dateOfBirth')
      .populate('doctor', 'name specialty')
      .lean();
    
    if (!apt) {
      console.log('❌ Agendamento NÃO ENCONTRADO!');
      process.exit(1);
    }
    
    console.log('✅ Agendamento encontrado\n');
    
    // Dados básicos
    console.log('📋 CAMPOS BÁSICOS:');
    console.log(`  _id:              ${apt._id}`);
    console.log(`  date:             ${apt.date}`);
    console.log(`  time:             ${apt.time}`);
    console.log(`  status:           ${apt.status}`);
    console.log(`  createdAt:        ${apt.createdAt}`);
    console.log(`  source:           ${apt.source || '(não definido)'}`);
    console.log();
    
    // Paciente
    console.log('👤 PACIENTE:');
    console.log(`  patientId (DBRef): ${apt.patient?._id || apt.patient || '(não vinculado)'}`);
    if (apt.patient?.fullName) {
      console.log(`  ✅ Populado: ${apt.patient.fullName}`);
      console.log(`     Telefone: ${apt.patient.phone || '(não definido)'}`);
      console.log(`     Email: ${apt.patient.email || '(não definido)'}`);
      console.log(`     Nascimento: ${apt.patient.dateOfBirth || '(não definido)'}`);
    } else if (apt.patient) {
      // patient é só o ID
      const patient = await Patient.findById(apt.patient).lean();
      if (patient) {
        console.log(`  ✅ Paciente encontrado: ${patient.fullName}`);
      } else {
        console.log(`  ⚠️  Paciente NÃO ENCONTRADO no banco!`);
      }
    }
    console.log(`  patientInfo.fullName:  ${apt.patientInfo?.fullName || '(não definido)'}`);
    console.log(`  patientInfo.phone:     ${apt.patientInfo?.phone || '(não definido)'}`);
    console.log();
    
    // Doutor
    console.log('👨‍⚕️ DOUTOR:');
    console.log(`  doctorId (DBRef): ${apt.doctor?._id || apt.doctor || '(não vinculado)'}`);
    if (apt.doctor?.name) {
      console.log(`  ✅ Populado: ${apt.doctor.name}`);
      console.log(`     Especialidade: ${apt.doctor.specialty || '(não definida)'}`);
    }
    console.log();
    
    // Serviço
    console.log('💼 SERVIÇO:');
    console.log(`  serviceType:      ${apt.serviceType || '(não definido)'}`);
    console.log(`  sessionValue:     ${apt.sessionValue || 0}`);
    console.log(`  paymentMethod:    ${apt.paymentMethod || '(não definido)'}`);
    console.log(`  notes:            ${apt.notes || '(vazio)'}`);
    console.log();
    
    // Verificar se o pré-agendamento foi atualizado
    console.log('🔗 PRÉ-AGENDAMENTO ORIGINAL:');
    const pre = await PreAgendamento.findOne({ 
      $or: [
        { _id: '699764f4640dbc8aefa13b81' },
        { importedAppointmentId: apt._id }
      ]
    }).lean();
    
    if (pre) {
      console.log(`  _id:              ${pre._id}`);
      console.log(`  status:           ${pre.status}`);
      console.log(`  importedAppointmentId: ${pre.importedAppointmentId || '(não definido)'}`);
      console.log(`  importedAt:       ${pre.importedAt || '(não definido)'}`);
    } else {
      console.log('  ⚠️  Pré-agendamento não encontrado (pode ter sido deletado)');
    }
    console.log();
    
    // Resumo de integridade
    console.log('='.repeat(70));
    console.log('📊 RESUMO DE INTEGRIDADE:\n');
    
    const checks = [];
    checks.push({ ok: !!apt._id, label: 'ID válido' });
    checks.push({ ok: !!apt.date, label: 'Data definida' });
    checks.push({ ok: !!apt.time, label: 'Horário definido' });
    checks.push({ ok: !!apt.patient, label: 'Paciente vinculado (DBRef)' });
    checks.push({ ok: !!apt.doctor, label: 'Doutor vinculado (DBRef)' });
    checks.push({ ok: apt.status === 'scheduled' || apt.status === 'confirmed', label: 'Status válido' });
    checks.push({ ok: apt.source === 'agenda_externa', label: 'Source = agenda_externa' });
    
    let passou = 0;
    let falhou = 0;
    
    checks.forEach(c => {
      if (c.ok) {
        console.log(`  ✅ ${c.label}`);
        passou++;
      } else {
        console.log(`  ❌ ${c.label}`);
        falhou++;
      }
    });
    
    console.log();
    console.log(`Resultado: ${passou}/${checks.length} checks passaram`);
    
    if (falhou === 0) {
      console.log('\n🎉 AUDITORIA APROVADA! Agendamento criado com sucesso!');
    } else {
      console.log(`\n⚠️  AUDITORIA COM ${falhou} PROBLEMA(S)`);
    }
    
    await mongoose.disconnect();
    console.log('\n🔌 Desconectado do MongoDB');
    
  } catch (err) {
    console.error('❌ ERRO:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

auditar();
