import mongoose from 'mongoose';
import PreAgendamento from './models/PreAgendamento.js';
import dotenv from 'dotenv';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/fono_inova';

mongoose.connect(MONGODB_URI)
  .then(async () => {
    console.log('✅ MongoDB conectado');
    
    // Buscar pré-agendamentos do Henre Gabriel
    const preAgendamentos = await PreAgendamento.find({
      'patientInfo.fullName': { $regex: /Henre/i }
    }).lean();
    
    console.log(`\n🔍 Encontrados ${preAgendamentos.length} pré-agendamentos do Henre:\n`);
    
    preAgendamentos.forEach((pre, idx) => {
      console.log(`--- Pré-agendamento ${idx + 1} ---`);
      console.log(`ID: ${pre._id}`);
      console.log(`Nome: ${pre.patientInfo?.fullName}`);
      console.log(`Status: ${pre.status}`);
      console.log(`Data preferida: ${pre.preferredDate}`);
      console.log(`Hora preferida: ${pre.preferredTime}`);
      console.log(`importedToAppointment: ${pre.importedToAppointment}`);
      console.log(`Source: ${pre.source}`);
      console.log(`Criado em: ${pre.createdAt}`);
      console.log('');
    });
    
    // Buscar também por data 2026-03-04
    console.log('\n🔍 Buscando pré-agendamentos para 2026-03-04:\n');
    const preDoDia = await PreAgendamento.find({
      preferredDate: '2026-03-04',
      status: { $nin: ['importado', 'descartado'] }
    }).lean();
    
    console.log(`Encontrados ${preDoDia.length} pré-agendamentos para 04/03:`);
    preDoDia.forEach(pre => {
      console.log(`- ${pre.patientInfo?.fullName} | ${pre.preferredTime} | Status: ${pre.status} | imported: ${pre.importedToAppointment}`);
    });
    
    process.exit(0);
  })
  .catch(err => {
    console.error('❌ Erro:', err);
    process.exit(1);
  });
