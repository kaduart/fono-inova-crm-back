#!/usr/bin/env node
/**
 * 🔍 Script para verificar pré-agendamento no MongoDB
 * 
 * Uso: node scripts/checkPreAgendamento.js [ID_DO_PRE_AGENDAMENTO]
 */

import dotenv from 'dotenv';
dotenv.config();

const preAgendamentoId = process.argv[2];

// Cores
const c = {
  g: '\x1b[32m',
  r: '\x1b[31m',
  y: '\x1b[33m',
  b: '\x1b[34m',
  reset: '\x1b[0m'
};

async function main() {
  try {
    const { MongoClient, ObjectId } = await import('mongodb');
    const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/fono-inova';
    
    const client = new MongoClient(uri);
    await client.connect();
    console.log(`${c.g}✅ Conectado ao MongoDB${c.reset}\n`);
    
    const db = client.db();
    
    // Buscar pré-agendamento
    if (preAgendamentoId) {
      console.log(`${c.b}🔍 Buscando pré-agendamento: ${preAgendamentoId}${c.reset}`);
      
      try {
        const pre = await db.collection('preagendamentos').findOne({ 
          _id: new ObjectId(preAgendamentoId) 
        });
        
        if (pre) {
          console.log(`\n${c.g}✅ PRÉ-AGENDAMENTO ENCONTRADO:${c.reset}`);
          console.log(`  ID: ${pre._id}`);
          console.log(`  Paciente: ${pre.patientInfo?.fullName}`);
          console.log(`  Status: ${c.y}${pre.status}${c.reset}`);
          console.log(`  External ID: ${pre.externalId}`);
          console.log(`  Especialidade: ${pre.specialty}`);
          console.log(`  Data preferida: ${pre.preferredDate} ${pre.preferredTime}`);
          console.log(`  Criado em: ${pre.createdAt}`);
          
          if (pre.status === 'importado') {
            console.log(`\n${c.g}✅ JÁ FOI IMPORTADO:${c.reset}`);
            console.log(`  Appointment ID: ${pre.importedToAppointment}`);
            console.log(`  Importado em: ${pre.importedAt}`);
            
            // Buscar appointment
            const app = await db.collection('appointments').findOne({
              _id: pre.importedToAppointment
            });
            
            if (app) {
              console.log(`\n${c.g}✅ APPOINTMENT ENCONTRADO:${c.reset}`);
              console.log(`  Status: ${app.status}`);
              console.log(`  Data: ${app.date} ${app.time}`);
              console.log(`  Profissional: ${app.doctorId}`);
            }
          }
          
        } else {
          console.log(`${c.r}❌ Pré-agendamento não encontrado${c.reset}`);
        }
      } catch (e) {
        console.log(`${c.r}❌ Erro: ID inválido${c.reset}`);
      }
      
    } else {
      // Listar últimos
      console.log(`${c.b}📋 Últimos pré-agendamentos:${c.reset}\n`);
      
      const pres = await db.collection('preagendamentos')
        .find()
        .sort({ createdAt: -1 })
        .limit(10)
        .toArray();
      
      if (pres.length === 0) {
        console.log(`${c.y}⚠️ Nenhum pré-agendamento encontrado${c.reset}`);
      } else {
        pres.forEach((p, i) => {
          const statusColor = p.status === 'importado' ? c.g : 
                             p.status === 'novo' ? c.y : c.r;
          console.log(`${i+1}. ${p.patientInfo?.fullName || 'N/A'}`);
          console.log(`   ID: ${p._id}`);
          console.log(`   Status: ${statusColor}${p.status}${c.reset}`);
          console.log(`   Data: ${p.preferredDate} ${p.preferredTime}`);
          console.log(`   External: ${p.externalId}`);
          console.log('');
        });
      }
      
      // Resumo
      const stats = await db.collection('preagendamentos').aggregate([
        { $group: { _id: "$status", count: { $sum: 1 } } }
      ]).toArray();
      
      console.log(`${c.b}📊 Total por status:${c.reset}`);
      stats.forEach(s => {
        console.log(`  ${s._id || 'null'}: ${s.count}`);
      });
    }
    
    await client.close();
    
  } catch (error) {
    console.error(`${c.r}❌ Erro:${c.reset}`, error.message);
  }
}

main();
