#!/usr/bin/env node
/**
 * Debug: Verificar appointments que deveriam aparecer no calendário
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import Appointment from '../models/Appointment.js';

async function connectDB() {
  await mongoose.connect(process.env.MONGO_URI, {
    readPreference: 'primary',
    retryWrites: true,
    w: 'majority'
  });
  console.log('✅ Conectado ao MongoDB\n');
}

async function debug() {
  try {
    await connectDB();
    
    // Período atual (março/abril 2026)
    const dataInicio = new Date('2026-03-01');
    const dataFim = new Date('2026-05-01');
    
    console.log(`${'='.repeat(80)}`);
    console.log('🔍 DEBUG: Appointments para o Calendário');
    console.log(`${'='.repeat(80)}\n`);
    
    console.log('📅 Período:');
    console.log(`   Início: ${dataInicio.toISOString()}`);
    console.log(`   Fim: ${dataFim.toISOString()}\n`);
    
    // Buscar appointments do período
    const appointments = await Appointment.find({
      date: { $gte: dataInicio, $lt: dataFim }
    }).populate('patient', 'fullName').populate('doctor', 'fullName').lean();
    
    console.log(`📊 Total encontrado: ${appointments.length}\n`);
    
    // Verificar formato das datas
    console.log('🔍 Verificando formato das datas:\n');
    appointments.slice(0, 5).forEach((appt, i) => {
      console.log(`   ${i + 1}. ID: ${appt._id}`);
      console.log(`      Paciente: ${appt.patient?.fullName || 'N/A'}`);
      console.log(`      date: ${appt.date}`);
      console.log(`      date type: ${typeof appt.date}`);
      console.log(`      time: ${appt.time}`);
      console.log(`      status: ${appt.operationalStatus}`);
      console.log();
    });
    
    // Verificar appointments válidos para o calendário
    console.log('✅ Validação para o calendário:\n');
    
    const validos = appointments.filter(appt => {
      const hasDate = !!appt.date;
      const hasTime = !!appt.time;
      const hasId = !!(appt._id);
      return hasDate && hasTime && hasId;
    });
    
    console.log(`   Total: ${appointments.length}`);
    console.log(`   Válidos: ${validos.length}`);
    console.log(`   Inválidos: ${appointments.length - validos.length}\n`);
    
    // Mostrar alguns válidos
    console.log('📋 Exemplos de válidos:\n');
    validos.slice(0, 5).forEach((appt, i) => {
      const dateStr = appt.date instanceof Date 
        ? appt.date.toISOString().split('T')[0]
        : String(appt.date);
      
      console.log(`   ${i + 1}. ${appt.patient?.fullName || 'N/A'}`);
      console.log(`      Data: ${dateStr} ${appt.time}`);
      console.log(`      Status: ${appt.operationalStatus}`);
      console.log();
    });
    
    // Verificar se há appointments sem patient (erro de populate)
    const semPatient = appointments.filter(appt => !appt.patient);
    console.log(`⚠️  Appointments sem patient (populate falhou): ${semPatient.length}\n`);
    
    await mongoose.disconnect();
    
  } catch (error) {
    console.error('❌ Erro:', error);
    process.exit(1);
  }
}

debug();
