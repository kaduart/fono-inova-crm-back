#!/usr/bin/env node
/**
 * Buscar TODOS os agendamentos de março/2026
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

async function buscar() {
  try {
    await connectDB();
    
    console.log(`${'='.repeat(80)}`);
    console.log('📅 TODOS OS AGENDAMENTOS DE MARÇO/2026');
    console.log(`${'='.repeat(80)}\n`);
    
    // Março de 2026
    const inicioMarco = new Date('2026-03-01');
    const fimMarco = new Date('2026-04-01');
    
    console.log('🔍 Buscando no período:');
    console.log(`   Início: ${inicioMarco.toISOString()}`);
    console.log(`   Fim: ${fimMarco.toISOString()}\n`);
    
    // Agendamentos de março
    const appointments = await Appointment.find({
      date: { $gte: inicioMarco, $lt: fimMarco }
    }).populate('patient', 'fullName').populate('doctor', 'fullName').lean();
    
    console.log(`📋 Total de agendamentos em março/2026: ${appointments.length}\n`);
    
    // Agrupar por dia
    const porDia = {};
    let totalCancelados = 0;
    let totalConfirmados = 0;
    let totalPendentes = 0;
    
    appointments.forEach(a => {
      const dia = new Date(a.date).toLocaleDateString('pt-BR');
      if (!porDia[dia]) {
        porDia[dia] = [];
      }
      porDia[dia].push(a);
      
      if (a.operationalStatus === 'canceled') totalCancelados++;
      else if (a.operationalStatus === 'scheduled' || a.operationalStatus === 'confirmed') totalConfirmados++;
      else totalPendentes++;
    });
    
    // Mostrar por dia
    const diasOrdenados = Object.keys(porDia).sort((a, b) => {
      const [d1, m1, y1] = a.split('/').map(Number);
      const [d2, m2, y2] = b.split('/').map(Number);
      return new Date(y1, m1-1, d1) - new Date(y2, m2-1, d2);
    });
    
    diasOrdenados.forEach(dia => {
      const agendamentos = porDia[dia];
      console.log(`\n📅 ${dia} (${agendamentos.length} agendamentos):`);
      console.log('-'.repeat(80));
      
      agendamentos.forEach((a, i) => {
        const status = a.operationalStatus === 'canceled' ? '❌ CANCELADO' : 
                      a.operationalStatus === 'scheduled' ? '✅ AGENDADO' : 
                      a.operationalStatus === 'completed' ? '✅ CONCLUÍDO' : a.operationalStatus;
        
        console.log(`   ${i + 1}. ${a.patient?.fullName || 'N/A'}`);
        console.log(`      Horário: ${a.time || 'N/A'}`);
        console.log(`      Profissional: ${a.doctor?.fullName || 'N/A'}`);
        console.log(`      Status: ${status}`);
        console.log(`      Pagamento: ${a.paymentStatus || 'N/A'}`);
        console.log(`      Tipo: ${a.billingType === 'insurance' ? 'Convênio' : 'Particular'}`);
      });
    });
    
    console.log(`\n${'='.repeat(80)}`);
    console.log('📊 RESUMO DE MARÇO/2026:');
    console.log(`   Total: ${appointments.length}`);
    console.log(`   Confirmados/Agendados: ${totalConfirmados}`);
    console.log(`   Cancelados: ${totalCancelados}`);
    console.log(`   Outros: ${totalPendentes}`);
    console.log(`${'='.repeat(80)}\n`);
    
    // Sessões de março
    console.log('🩺 SESSÕES DE MARÇO/2026:\n');
    const sessions = await Session.find({
      date: { $gte: inicioMarco, $lt: fimMarco }
    }).populate('patient', 'fullName').lean();
    
    console.log(`   Total de sessões: ${sessions.length}\n`);
    
    sessions.forEach((s, i) => {
      const dia = new Date(s.date).toLocaleDateString('pt-BR');
      console.log(`   ${i + 1}. ${s.patient?.fullName || 'N/A'}`);
      console.log(`      Data: ${dia} ${s.time}`);
      console.log(`      Status: ${s.status}`);
      console.log(`      Pago: ${s.isPaid ? '✅' : '❌'}`);
      console.log(`      Valor: R$ ${s.sessionValue || 0}`);
      console.log();
    });
    
    await mongoose.disconnect();
    
  } catch (error) {
    console.error('❌ Erro:', error);
    process.exit(1);
  }
}

buscar();
