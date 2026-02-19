#!/usr/bin/env node
/**
 * Script de Auditoria de Pré-Agendamento
 * Verifica integridade dos dados após criação
 */

import mongoose from 'mongoose';
import PreAgendamento from '../models/PreAgendamento.js';
import Patient from '../models/Patient.js';
import Doctor from '../models/Doctor.js';
import dotenv from 'dotenv';

// Carregar variáveis de ambiente
dotenv.config();

const PRE_AGENDAMENTO_ID = process.argv[2] || '699764f4640dbc8aefa13b81';
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/crm-clinica';

async function auditar() {
  try {
    console.log('🔌 Conectando ao MongoDB...');
    // Conectar ao MongoDB
    await mongoose.connect(MONGO_URI);
    console.log('✅ Conectado!');
    console.log('='.repeat(60));
    
    // 1) Buscar Pré-Agendamento
    console.log(`\n📋 AUDITANDO PRÉ-AGENDAMENTO: ${PRE_AGENDAMENTO_ID}\n`);
    
    const pre = await PreAgendamento.findById(PRE_AGENDAMENTO_ID).lean();
    
    if (!pre) {
      console.log('❌ Pré-agendamento NÃO ENCONTRADO!');
      process.exit(1);
    }
    
    console.log('✅ Pré-agendamento encontrado\n');
    
    // 2) Validar campos obrigatórios
    console.log('📋 CAMPOS BÁSICOS:');
    console.log(`  _id:           ${pre._id}`);
    console.log(`  externalId:    ${pre.externalId || '(não definido)'}`);
    console.log(`  source:        ${pre.source}`);
    console.log(`  status:        ${pre.status}`);
    console.log(`  urgency:       ${pre.urgency || '(padrão)'}`);
    console.log(`  createdAt:     ${pre.createdAt}`);
    console.log();
    
    // 3) Validar paciente
    console.log('👤 PACIENTE:');
    console.log(`  patientId:     ${pre.patientId || '(não vinculado)'}`);
    
    if (pre.patientId) {
      const patient = await Patient.findById(pre.patientId).lean();
      if (patient) {
        console.log(`  ✅ Paciente encontrado: ${patient.fullName}`);
        console.log(`     Telefone: ${patient.phone}`);
        console.log(`     Email: ${patient.email || '(não definido)'}`);
      } else {
        console.log(`  ⚠️  Paciente NÃO ENCONTRADO no banco (ID inválido?)`);
      }
    }
    
    console.log(`  patientInfo.fullName:  ${pre.patientInfo?.fullName}`);
    console.log(`  patientInfo.phone:     ${pre.patientInfo?.phone}`);
    console.log(`  patientInfo.email:     ${pre.patientInfo?.email || '(não definido)'}`);
    console.log(`  patientInfo.birthDate: ${pre.patientInfo?.birthDate || '(não definido)'}`);
    console.log();
    
    // 4) Validar profissional
    console.log('👨‍⚕️ PROFISSIONAL:');
    console.log(`  professionalName: ${pre.professionalName}`);
    console.log(`  professionalId:   ${pre.professionalId || '(não vinculado)'}`);
    
    if (pre.professionalId) {
      const doctor = await Doctor.findById(pre.professionalId).lean();
      if (doctor) {
        console.log(`  ✅ Doutor encontrado: ${doctor.name}`);
        console.log(`     Especialidade: ${doctor.specialty}`);
      } else {
        console.log(`  ⚠️  Doutor NÃO ENCONTRADO no banco (ID inválido?)`);
      }
    }
    console.log();
    
    // 5) Validar agendamento
    console.log('📅 AGENDAMENTO:');
    console.log(`  preferredDate:   ${pre.preferredDate}`);
    console.log(`  preferredTime:   ${pre.preferredTime}`);
    console.log(`  specialty:       ${pre.specialty}`);
    console.log(`  serviceType:     ${pre.serviceType}`);
    console.log(`  suggestedValue:  ${pre.suggestedValue}`);
    console.log();
    
    // 6) Validar notas
    console.log('📝 NOTAS DA SECRETÁRIA:');
    console.log(`  ${pre.secretaryNotes || '(vazio)'}`);
    console.log();
    
    // 7) Resumo de integridade
    console.log('='.repeat(60));
    console.log('📊 RESUMO DE INTEGRIDADE:\n');
    
    const checks = [];
    checks.push({ ok: !!pre._id, label: 'ID válido' });
    checks.push({ ok: !!pre.patientInfo?.fullName, label: 'Nome do paciente preenchido' });
    checks.push({ ok: !!pre.patientInfo?.phone, label: 'Telefone preenchido' });
    checks.push({ ok: !!pre.patientId, label: 'Paciente vinculado ao CRM' });
    checks.push({ ok: !!pre.professionalName, label: 'Nome do profissional preenchido' });
    checks.push({ ok: !!pre.preferredDate, label: 'Data definida' });
    checks.push({ ok: !!pre.preferredTime, label: 'Horário definido' });
    checks.push({ ok: pre.source === 'agenda_externa', label: 'Source = agenda_externa' });
    checks.push({ ok: pre.status === 'novo', label: 'Status = novo' });
    
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
      console.log('\n🎉 AUDITORIA APROVADA! Tudo certo!');
    } else {
      console.log(`\n⚠️  AUDITORIA COM ${falhou} PROBLEMA(S)`);
    }
    
    await mongoose.disconnect();
    console.log('\n🔌 Desconectado do MongoDB');
    
  } catch (err) {
    console.error('❌ ERRO:', err.message);
    process.exit(1);
  }
}

auditar();
