#!/usr/bin/env node
/**
 * Investigação detalhada - Dias 30 e 31/03/2026
 * Busca TODOS os agendamentos, sessões e verifica status
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import Patient from '../models/Patient.js';

async function connectDB() {
  await mongoose.connect(process.env.MONGO_URI, {
    readPreference: 'primary',
    retryWrites: true,
    w: 'majority'
  });
  console.log('✅ Conectado ao MongoDB\n');
}

async function investigar() {
  try {
    await connectDB();
    
    const data30 = new Date('2026-03-30');
    const data31 = new Date('2026-03-31');
    const data1 = new Date('2026-04-01');
    
    console.log(`${'='.repeat(80)}`);
    console.log('🔍 INVESTIGAÇÃO: 30 e 31/03/2026');
    console.log(`${'='.repeat(80)}\n`);
    
    // 1. TODOS os agendamentos da coleção (sem filtro de data)
    console.log('📋 TODOS OS AGENDAMENTOS (últimos 20):\n');
    const allAppointments = await Appointment.find({})
      .sort({ date: -1 })
      .limit(20)
      .populate('patient', 'fullName')
      .lean();
    
    allAppointments.forEach((a, i) => {
      const date = a.date ? new Date(a.date).toLocaleDateString('pt-BR') : 'N/A';
      console.log(`${i + 1}. ${a.patient?.fullName || 'N/A'}`);
      console.log(`   Data: ${date} ${a.time || ''}`);
      console.log(`   Status Operacional: ${a.operationalStatus || 'N/A'}`);
      console.log(`   Status Pagamento: ${a.paymentStatus || 'N/A'}`);
      console.log(`   Tipo: ${a.billingType || 'N/A'}`);
      console.log();
    });
    
    // 2. Agendamentos específicos de 30 e 31/03 (verificar timezone)
    console.log('\n📅 AGENDAMENTOS 30/03 (comparando datas):\n');
    
    const start30 = new Date('2026-03-30T00:00:00.000Z');
    const end30 = new Date('2026-03-30T23:59:59.999Z');
    
    const apps30 = await Appointment.find({
      date: { $gte: start30, $lte: end30 }
    }).populate('patient', 'fullName').lean();
    
    console.log(`   Encontrados: ${apps30.length}`);
    apps30.forEach((a, i) => {
      console.log(`   ${i + 1}. ${a.patient?.fullName || 'N/A'} - ${a.time} - ${a.operationalStatus}`);
    });
    
    console.log('\n📅 AGENDAMENTOS 31/03 (comparando datas):\n');
    
    const start31 = new Date('2026-03-31T00:00:00.000Z');
    const end31 = new Date('2026-03-31T23:59:59.999Z');
    
    const apps31 = await Appointment.find({
      date: { $gte: start31, $lte: end31 }
    }).populate('patient', 'fullName').lean();
    
    console.log(`   Encontrados: ${apps31.length}`);
    apps31.forEach((a, i) => {
      console.log(`   ${i + 1}. ${a.patient?.fullName || 'N/A'} - ${a.time} - ${a.operationalStatus}`);
    });
    
    // 3. Buscar Helena especificamente
    console.log('\n👤 BUSCANDO HELENA:\n');
    const helena = await Patient.findOne({ fullName: { $regex: /helena/i } });
    
    if (helena) {
      console.log(`   Helena encontrada: ${helena._id}`);
      console.log(`   Nome: ${helena.fullName}`);
      
      const appsHelena = await Appointment.find({
        patient: helena._id,
        date: { $gte: start30, $lte: end31 }
      }).lean();
      
      console.log(`   Agendamentos 30-31/03: ${appsHelena.length}`);
      appsHelena.forEach((a, i) => {
        const date = new Date(a.date).toLocaleDateString('pt-BR');
        console.log(`   ${i + 1}. Data: ${date} ${a.time} | Status: ${a.operationalStatus} | Pago: ${a.paymentStatus}`);
      });
      
      // Sessões da Helena
      const sessoesHelena = await Session.find({
        patient: helena._id,
        date: { $gte: start30, $lte: end31 }
      }).lean();
      
      console.log(`   Sessões 30-31/03: ${sessoesHelena.length}`);
      sessoesHelena.forEach((s, i) => {
        const date = new Date(s.date).toLocaleDateString('pt-BR');
        console.log(`   ${i + 1}. Data: ${date} ${s.time} | Status: ${s.status} | Pago: ${s.isPaid}`);
      });
    } else {
      console.log('   ❌ Helena não encontrada');
    }
    
    // 4. Todas as sessões do período
    console.log('\n🩺 TODAS AS SESSÕES 30-31/03:\n');
    const sessions = await Session.find({
      date: { $gte: start30, $lte: end31 }
    }).populate('patient', 'fullName').lean();
    
    console.log(`   Total: ${sessions.length}`);
    sessions.forEach((s, i) => {
      const date = new Date(s.date).toLocaleDateString('pt-BR');
      console.log(`   ${i + 1}. ${s.patient?.fullName || 'N/A'}`);
      console.log(`      Data: ${date} ${s.time}`);
      console.log(`      Status: ${s.status}`);
      console.log(`      Pago: ${s.isPaid}`);
      console.log(`      Valor: R$ ${s.sessionValue || 0}`);
      console.log();
    });
    
    await mongoose.disconnect();
    
  } catch (error) {
    console.error('❌ Erro:', error);
    process.exit(1);
  }
}

investigar();
