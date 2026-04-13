#!/usr/bin/env node
/**
 * 🔍 Verifica por que appointment não aparece no calendário
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Appointment from './models/Appointment.js';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

async function checkVisibility(appointmentId) {
    console.log(`🔍 Verificando visibilidade no calendário: ${appointmentId}\n`);
    
    await mongoose.connect(MONGO_URI);
    
    const apt = await Appointment.findById(appointmentId).lean();
    
    if (!apt) {
        console.log('❌ Appointment não encontrado');
        process.exit(1);
    }
    
    console.log('📋 CAMPOS CRÍTICOS:');
    console.log(`  _id: ${apt._id}`);
    console.log(`  operationalStatus: ${apt.operationalStatus}`);
    console.log(`  clinicalStatus: ${apt.clinicalStatus}`);
    console.log(`  status: ${apt.status || 'undefined'}`);
    console.log(`  date: ${apt.date}`);
    console.log(`  date (ISO): ${apt.date?.toISOString?.() || apt.date}`);
    console.log(`  time: ${apt.time}`);
    console.log(`  doctor: ${apt.doctor}`);
    console.log(`  doctorId: ${apt.doctorId}`);
    console.log(`  patient: ${apt.patient}`);
    console.log(`  deletedAt: ${apt.deletedAt}`);
    console.log(`  isDeleted: ${apt.isDeleted}`);
    
    // Verificações
    console.log('\n🔍 VERIFICAÇÕES:');
    
    // 1. Status
    const validStatuses = ['scheduled', 'confirmed', 'in_progress', 'completed', 'pre_agendado'];
    if (!validStatuses.includes(apt.operationalStatus)) {
        console.log(`❌ operationalStatus "${apt.operationalStatus}" não está na lista de visíveis`);
    } else {
        console.log(`✅ operationalStatus válido`);
    }
    
    // 2. Data
    const now = new Date();
    const aptDate = new Date(apt.date);
    console.log(`\n  Data do agendamento: ${aptDate.toISOString()}`);
    console.log(`  Data atual: ${now.toISOString()}`);
    console.log(`  Diferença (dias): ${Math.floor((aptDate - now) / (1000 * 60 * 60 * 24))}`);
    
    // 3. Doctor
    if (!apt.doctor && !apt.doctorId) {
        console.log(`\n⚠️  SEM DOCTOR (pode ser aceitável dependendo do filtro)`);
    } else {
        console.log(`\n✅ Tem doctor: ${apt.doctor || apt.doctorId}`);
    }
    
    // 4. Soft delete
    if (apt.deletedAt || apt.isDeleted) {
        console.log(`\n❌ APAGADO (deletedAt: ${apt.deletedAt}, isDeleted: ${apt.isDeleted})`);
    } else {
        console.log(`\n✅ Não está apagado`);
    }
    
    // 5. Simula filtro do calendário
    console.log('\n' + '='.repeat(50));
    console.log('🔍 SIMULANDO FILTRO DO CALENDÁRIO:');
    
    // Range típico do calendário (mês atual)
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    
    console.log(`  Range calendário: ${startOfMonth.toISOString()} a ${endOfMonth.toISOString()}`);
    console.log(`  Data appointment: ${aptDate.toISOString()}`);
    
    const inRange = aptDate >= startOfMonth && aptDate <= endOfMonth;
    console.log(`  ${inRange ? '✅' : '❌'} Data ${inRange ? 'dentro' : 'FORA'} do range`);
    
    if (!inRange) {
        console.log('\n🚨 PROBLEMA: Data fora do range do calendário!');
        console.log('   O calendário só mostra o mês atual.');
    }
    
    await mongoose.disconnect();
}

const id = process.argv[2] || '69d92ca6674d596845d7ced1';
checkVisibility(id).catch(console.error);
