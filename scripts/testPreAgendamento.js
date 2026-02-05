#!/usr/bin/env node
/**
 * Script para testar o fluxo de Pré-Agendamento
 * 
 * Uso: node scripts/testPreAgendamento.js
 */

import dotenv from 'dotenv';
dotenv.config();

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:5000';
const EXPORT_TOKEN = process.env.AGENDA_EXPORT_TOKEN || 'agenda_export_token_fono_inova_2025_secure_abc123';

// Cores para console
const c = {
  g: '\x1b[32m',
  r: '\x1b[31m',
  y: '\x1b[33m',
  reset: '\x1b[0m'
};

console.log('🧪 Testando Pré-Agendamento\n');

async function testWebhook() {
  const payload = {
    externalId: `test_${Date.now()}`,
    patientName: 'Paciente Teste',
    patientPhone: '11999998888',
    patientEmail: 'teste@email.com',
    patientBirthDate: '1990-05-15',
    specialty: 'fonoaudiologia',
    preferredDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    preferredTime: '14:00',
    professionalName: 'Dra. Teste',
    source: 'teste_manual'
  };

  console.log('📤 Enviando webhook...');
  console.log('URL:', `${BACKEND_URL}/api/pre-agendamento/webhook`);
  console.log('Token:', EXPORT_TOKEN.substring(0, 20) + '...\n');

  try {
    const res = await fetch(`${BACKEND_URL}/api/pre-agendamento/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${EXPORT_TOKEN}`
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    
    if (res.ok) {
      console.log(`${c.g}✅ Webhook OK!${c.reset}`);
      console.log('Resposta:', JSON.stringify(data, null, 2));
      return data.id;
    } else {
      console.log(`${c.r}❌ Webhook falhou:${c.reset}`);
      console.log('Status:', res.status);
      console.log('Resposta:', data);
      return null;
    }
  } catch (error) {
    console.log(`${c.r}❌ Erro na requisição:${c.reset}`, error.message);
    return null;
  }
}

async function listPreAgendamentos() {
  console.log('\n📋 Listando últimos pré-agendamentos...\n');
  
  try {
    const { MongoClient } = await import('mongodb');
    const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/fono-inova';
    
    const client = new MongoClient(uri);
    await client.connect();
    
    const db = client.db();
    const collection = db.collection('preagendamentos');
    
    const docs = await collection
      .find({})
      .sort({ createdAt: -1 })
      .limit(5)
      .toArray();
    
    if (docs.length === 0) {
      console.log(`${c.y}⚠️ Nenhum pré-agendamento encontrado${c.reset}`);
    } else {
      console.log(`${c.g}✅ Encontrados ${docs.length} pré-agendamentos:${c.reset}\n`);
      
      docs.forEach((doc, i) => {
        console.log(`[${i + 1}] ${doc.patientInfo?.fullName || 'N/A'}`);
        console.log(`    ID: ${doc._id}`);
        console.log(`    Status: ${doc.status}`);
        console.log(`    Especialidade: ${doc.specialty}`);
        console.log(`    Data preferida: ${doc.preferredDate}`);
        console.log(`    Urgência: ${doc.urgency}`);
        console.log(`    Criado em: ${doc.createdAt}`);
        console.log(`    Origem: ${doc.source}`);
        console.log('');
      });
    }
    
    const total = await collection.countDocuments();
    console.log(`📊 Total de pré-agendamentos: ${total}`);
    
    // Resumo por status
    const porStatus = await collection.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]).toArray();
    
    console.log('\n📈 Por status:');
    porStatus.forEach(s => {
      console.log(`   ${s._id || 'null'}: ${s.count}`);
    });
    
    await client.close();
    
  } catch (error) {
    console.log(`${c.r}❌ Erro MongoDB:${c.reset}`, error.message);
    console.log('Verifique se o MongoDB está rodando');
  }
}

async function main() {
  // Pergunta qual teste fazer
  const args = process.argv.slice(2);
  
  if (args.includes('--webhook')) {
    await testWebhook();
  } else if (args.includes('--list')) {
    await listPreAgendamentos();
  } else {
    // Faz ambos
    await testWebhook();
    await listPreAgendamentos();
  }
}

main().catch(console.error);
