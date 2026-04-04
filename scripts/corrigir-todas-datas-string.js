#!/usr/bin/env node
/**
 * CORREÇÃO GERAL: Converte todos os campos de data de String para Date
 * 
 * Schemas afetados:
 * - Payment: serviceDate, paymentDate, insurance.receivedAt, insurance.expectedReceiptDate
 * - DailyClosingSnapshot: date
 * - Expense: endDate
 * - PatientsView: date
 * - Reminder: dueDate
 * - TotalsSnapshot: date
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

// Função para converter string YYYY-MM-DD para Date
function stringToDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  if (!dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) return null;
  
  const [ano, mes, dia] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(ano, mes - 1, dia, 12, 0, 0));
}

async function migrarPayments() {
  console.log('\n' + '='.repeat(80));
  console.log('💰 MIGRANDO PAYMENTS...');
  console.log('='.repeat(80));
  
  const db = mongoose.connection.db;
  const collection = db.collection('payments');
  
  // Buscar payments com serviceDate ou paymentDate como string
  const payments = await collection.find({
    $or: [
      { serviceDate: { $type: 'string' } },
      { paymentDate: { $type: 'string' } },
      { 'insurance.receivedAt': { $type: 'string' } },
      { 'insurance.expectedReceiptDate': { $type: 'string' } }
    ]
  }).toArray();
  
  console.log(`📊 Total de payments para migrar: ${payments.length}\n`);
  
  let sucessos = 0;
  let erros = 0;
  
  for (const pay of payments) {
    try {
      const updateData = {};
      
      // Converter serviceDate
      if (pay.serviceDate && typeof pay.serviceDate === 'string') {
        const date = stringToDate(pay.serviceDate);
        if (date) updateData.serviceDate = date;
      }
      
      // Converter paymentDate
      if (pay.paymentDate && typeof pay.paymentDate === 'string') {
        const date = stringToDate(pay.paymentDate);
        if (date) updateData.paymentDate = date;
      }
      
      // Converter insurance.receivedAt
      if (pay.insurance?.receivedAt && typeof pay.insurance.receivedAt === 'string') {
        const date = stringToDate(pay.insurance.receivedAt);
        if (date) updateData['insurance.receivedAt'] = date;
      }
      
      // Converter insurance.expectedReceiptDate
      if (pay.insurance?.expectedReceiptDate && typeof pay.insurance.expectedReceiptDate === 'string') {
        const date = stringToDate(pay.insurance.expectedReceiptDate);
        if (date) updateData['insurance.expectedReceiptDate'] = date;
      }
      
      if (Object.keys(updateData).length > 0) {
        await collection.updateOne(
          { _id: pay._id },
          { $set: updateData }
        );
        sucessos++;
        
        if (sucessos % 100 === 0) {
          console.log(`   Progresso: ${sucessos}/${payments.length}`);
        }
      }
    } catch (error) {
      erros++;
      console.error(`   ❌ Erro no payment ${pay._id}:`, error.message);
    }
  }
  
  console.log(`\n✅ Sucessos: ${sucessos} | ❌ Erros: ${erros}`);
  return { sucessos, erros, total: payments.length };
}

async function migrarDailyClosingSnapshots() {
  console.log('\n' + '='.repeat(80));
  console.log('📊 MIGRANDO DAILY CLOSING SNAPSHOTS...');
  console.log('='.repeat(80));
  
  const db = mongoose.connection.db;
  const collection = db.collection('dailyclosingsnapshots');
  
  const docs = await collection.find({ date: { $type: 'string' } }).toArray();
  console.log(`📊 Total para migrar: ${docs.length}\n`);
  
  let sucessos = 0;
  
  for (const doc of docs) {
    try {
      const date = stringToDate(doc.date);
      if (date) {
        await collection.updateOne(
          { _id: doc._id },
          { $set: { date } }
        );
        sucessos++;
      }
    } catch (error) {
      console.error(`   ❌ Erro:`, error.message);
    }
  }
  
  console.log(`✅ Sucessos: ${sucessos}`);
  return { sucessos, total: docs.length };
}

async function migrarExpenses() {
  console.log('\n' + '='.repeat(80));
  console.log('💸 MIGRANDO EXPENSES...');
  console.log('='.repeat(80));
  
  const db = mongoose.connection.db;
  const collection = db.collection('expenses');
  
  const docs = await collection.find({ 
    endDate: { $type: 'string' } 
  }).toArray();
  
  console.log(`📊 Total para migrar: ${docs.length}\n`);
  
  let sucessos = 0;
  
  for (const doc of docs) {
    try {
      const date = stringToDate(doc.endDate);
      if (date) {
        await collection.updateOne(
          { _id: doc._id },
          { $set: { endDate: date } }
        );
        sucessos++;
      }
    } catch (error) {
      console.error(`   ❌ Erro:`, error.message);
    }
  }
  
  console.log(`✅ Sucessos: ${sucessos}`);
  return { sucessos, total: docs.length };
}

async function migrarPatientsViews() {
  console.log('\n' + '='.repeat(80));
  console.log('👥 MIGRANDO PATIENTS VIEWS...');
  console.log('='.repeat(80));
  
  const db = mongoose.connection.db;
  const collection = db.collection('patientsviews');
  
  const docs = await collection.find({ 
    $or: [
      { date: { $type: 'string' } },
      { 'appointments.date': { $type: 'string' } }
    ]
  }).toArray();
  
  console.log(`📊 Total para migrar: ${docs.length}\n`);
  
  let sucessos = 0;
  
  for (const doc of docs) {
    try {
      const updateData = {};
      
      if (doc.date && typeof doc.date === 'string') {
        const date = stringToDate(doc.date);
        if (date) updateData.date = date;
      }
      
      // Atualizar appointments internos se existirem
      if (doc.appointments && Array.isArray(doc.appointments)) {
        const newAppointments = doc.appointments.map(app => {
          if (app.date && typeof app.date === 'string') {
            return { ...app, date: stringToDate(app.date) };
          }
          return app;
        });
        updateData.appointments = newAppointments;
      }
      
      if (Object.keys(updateData).length > 0) {
        await collection.updateOne(
          { _id: doc._id },
          { $set: updateData }
        );
        sucessos++;
      }
    } catch (error) {
      console.error(`   ❌ Erro:`, error.message);
    }
  }
  
  console.log(`✅ Sucessos: ${sucessos}`);
  return { sucessos, total: docs.length };
}

async function migrarReminders() {
  console.log('\n' + '='.repeat(80));
  console.log('⏰ MIGRANDO REMINDERS...');
  console.log('='.repeat(80));
  
  const db = mongoose.connection.db;
  const collection = db.collection('reminders');
  
  const docs = await collection.find({ dueDate: { $type: 'string' } }).toArray();
  console.log(`📊 Total para migrar: ${docs.length}\n`);
  
  let sucessos = 0;
  
  for (const doc of docs) {
    try {
      const date = stringToDate(doc.dueDate);
      if (date) {
        await collection.updateOne(
          { _id: doc._id },
          { $set: { dueDate: date } }
        );
        sucessos++;
      }
    } catch (error) {
      console.error(`   ❌ Erro:`, error.message);
    }
  }
  
  console.log(`✅ Sucessos: ${sucessos}`);
  return { sucessos, total: docs.length };
}

async function migrarTotalsSnapshots() {
  console.log('\n' + '='.repeat(80));
  console.log('📈 MIGRANDO TOTALS SNAPSHOTS...');
  console.log('='.repeat(80));
  
  const db = mongoose.connection.db;
  const collection = db.collection('totalssnapshots');
  
  const docs = await collection.find({ date: { $type: 'string' } }).toArray();
  console.log(`📊 Total para migrar: ${docs.length}\n`);
  
  let sucessos = 0;
  
  for (const doc of docs) {
    try {
      const date = stringToDate(doc.date);
      if (date) {
        await collection.updateOne(
          { _id: doc._id },
          { $set: { date } }
        );
        sucessos++;
      }
    } catch (error) {
      console.error(`   ❌ Erro:`, error.message);
    }
  }
  
  console.log(`✅ Sucessos: ${sucessos}`);
  return { sucessos, total: docs.length };
}

async function main() {
  try {
    await connectDB();
    
    console.log('\n' + '🔄'.repeat(40));
    console.log('INICIANDO MIGRAÇÃO GERAL DE DATAS');
    console.log('🔄'.repeat(40));
    
    const resultados = {
      payments: await migrarPayments(),
      dailyClosing: await migrarDailyClosingSnapshots(),
      expenses: await migrarExpenses(),
      patientsViews: await migrarPatientsViews(),
      reminders: await migrarReminders(),
      totalsSnapshots: await migrarTotalsSnapshots()
    };
    
    console.log('\n' + '='.repeat(80));
    console.log('📊 RESUMO GERAL');
    console.log('='.repeat(80));
    
    let totalSucessos = 0;
    let totalDocs = 0;
    
    Object.entries(resultados).forEach(([nome, res]) => {
      console.log(`   ${nome}: ${res.sucessos}/${res.total} ✅`);
      totalSucessos += res.sucessos;
      totalDocs += res.total;
    });
    
    console.log(`\n   TOTAL: ${totalSucessos}/${totalDocs} documentos migrados`);
    console.log('='.repeat(80));
    
    await mongoose.disconnect();
    console.log('\n✅ Migração concluída!');
    
  } catch (error) {
    console.error('\n❌ Erro:', error);
    process.exit(1);
  }
}

main();
