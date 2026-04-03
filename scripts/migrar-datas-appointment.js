#!/usr/bin/env node
/**
 * MIGRAÇÃO: Converter datas de String para Date nos Appointments
 * 
 * Converte date: "2026-03-30" → date: ISODate("2026-03-30T00:00:00.000Z")
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
    const collection = db.collection('appointments');
    
    console.log('🔍 Verificando datas como string...\n');
    
    // Buscar documentos onde date é string
    const appointments = await collection.find({
      date: { $type: 'string' }
    }).toArray();
    
    console.log(`📊 Total de appointments com date como string: ${appointments.length}\n`);
    
    if (appointments.length === 0) {
      console.log('✅ Nenhuma migração necessária');
      await mongoose.disconnect();
      return;
    }
    
    let sucessos = 0;
    let erros = 0;
    
    for (const app of appointments) {
      try {
        const dateStr = app.date; // "2026-03-30"
        
        // Criar data no timezone Brasil (meio-dia para evitar problemas de timezone)
        const [ano, mes, dia] = dateStr.split('-').map(Number);
        const dataDate = new Date(Date.UTC(ano, mes - 1, dia, 12, 0, 0));
        
        await collection.updateOne(
          { _id: app._id },
          { 
            $set: { 
              date: dataDate,
              migratedAt: new Date()
            }
          }
        );
        
        sucessos++;
        
        if (sucessos % 100 === 0) {
          console.log(`   Progresso: ${sucessos}/${appointments.length}`);
        }
        
      } catch (error) {
        erros++;
        console.error(`   ❌ Erro no appointment ${app._id}:`, error.message);
      }
    }
    
    console.log(`\n${'='.repeat(80)}`);
    console.log('📊 RESUMO DA MIGRAÇÃO:');
    console.log(`   ✅ Sucessos: ${sucessos}`);
    console.log(`   ❌ Erros: ${erros}`);
    console.log(`   📈 Total: ${appointments.length}`);
    console.log(`${'='.repeat(80)}\n`);
    
    console.log('⚠️  IMPORTANTE:');
    console.log('   Após a migração, altere o schema para:');
    console.log('   date: { type: Date, required: true }');
    console.log('   time: { type: String, required: true }');
    console.log();
    
    await mongoose.disconnect();
    
  } catch (error) {
    console.error('❌ Erro:', error);
    process.exit(1);
  }
}

migrar();
