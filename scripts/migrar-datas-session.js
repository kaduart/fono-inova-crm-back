#!/usr/bin/env node
/**
 * MIGRAÇÃO: Converter datas de String para Date nas Sessions
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function connectDB() {
  await mongoose.connect(process.env.MONGO_URI, {
    readPreference: 'primary',
    retryWrites: true,
    w: 'majority'
  });
  console.log('✅ Conectado ao MongoDB\n');
}

async function migrar() {
  try {
    await connectDB();
    
    const db = mongoose.connection.db;
    const collection = db.collection('sessions');
    
    console.log('🔍 Verificando datas como string...\n');
    
    const sessions = await collection.find({
      date: { $type: 'string' }
    }).toArray();
    
    console.log(`📊 Total de sessions com date como string: ${sessions.length}\n`);
    
    if (sessions.length === 0) {
      console.log('✅ Nenhuma migração necessária');
      await mongoose.disconnect();
      return;
    }
    
    let sucessos = 0;
    let erros = 0;
    
    for (const s of sessions) {
      try {
        const dateStr = s.date;
        const [ano, mes, dia] = dateStr.split('-').map(Number);
        const dataDate = new Date(Date.UTC(ano, mes - 1, dia, 12, 0, 0));
        
        await collection.updateOne(
          { _id: s._id },
          { $set: { date: dataDate } }
        );
        
        sucessos++;
        
        if (sucessos % 100 === 0) {
          console.log(`   Progresso: ${sucessos}/${sessions.length}`);
        }
        
      } catch (error) {
        erros++;
        console.error(`   ❌ Erro na session ${s._id}:`, error.message);
      }
    }
    
    console.log(`\n${'='.repeat(80)}`);
    console.log('📊 RESUMO DA MIGRAÇÃO:');
    console.log(`   ✅ Sucessos: ${sucessos}`);
    console.log(`   ❌ Erros: ${erros}`);
    console.log(`${'='.repeat(80)}\n`);
    
    await mongoose.disconnect();
    
  } catch (error) {
    console.error('❌ Erro:', error);
    process.exit(1);
  }
}

migrar();
