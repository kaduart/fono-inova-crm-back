#!/usr/bin/env node
/**
 * Verificar formato das datas nos agendamentos
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

async function verificar() {
  try {
    await connectDB();
    
    console.log('🔍 Verificando formato das datas\n');
    
    // Pegar alguns agendamentos
    const apps = await Appointment.find({}).limit(5).lean();
    
    apps.forEach((a, i) => {
      console.log(`Agendamento ${i + 1}:`);
      console.log(`  date: ${a.date}`);
      console.log(`  date type: ${typeof a.date}`);
      console.log(`  time: ${a.time}`);
      console.log(`  createdAt: ${a.createdAt}`);
      console.log();
    });
    
    // Buscar por string "2026-03-30" ou "30/03"
    console.log('\n🔍 Buscando por padrão de data em string...\n');
    
    const apps30 = await Appointment.find({
      $or: [
        { date: { $regex: /2026-03-30/ } },
        { date: { $regex: /30\/03/ } },
        { date: { $regex: /30-03/ } }
      ]
    }).lean();
    
    console.log(`Encontrados com padrão de string: ${apps30.length}`);
    
    // Contar total de agendamentos
    const total = await Appointment.countDocuments();
    console.log(`\n📊 Total de agendamentos no banco: ${total}`);
    
    // Verificar range de datas
    const primeiro = await Appointment.findOne().sort({ date: 1 });
    const ultimo = await Appointment.findOne().sort({ date: -1 });
    
    console.log(`\n📅 Primeiro agendamento: ${primeiro?.date}`);
    console.log(`📅 Último agendamento: ${ultimo?.date}`);
    
    await mongoose.disconnect();
    
  } catch (error) {
    console.error('❌ Erro:', error);
    process.exit(1);
  }
}

verificar();
