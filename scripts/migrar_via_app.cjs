#!/usr/bin/env node
/**
 * Migração via aplicação Node.js
 * Usa a conexão existente do Mongoose para copiar dados
 */

const mongoose = require('mongoose');
const { MongoClient } = require('mongodb');

// URI do MongoDB Atlas
const URI = 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net';
const SOURCE_DB = 'test';
const TARGET_DB = 'crm_development';

// Coleções a migrar
const COLLECTIONS = [
  'patients', 'doctors', 'clinics', 'users', 'sessions',
  'insurances', 'financial_categories', 'payments', 'packages',
  'patient_balances', 'totals_snapshots', 'events'
];

async function migrar() {
  console.log('🚀 Iniciando migração via Node.js...\n');
  
  const client = new MongoClient(URI, {
    serverSelectionTimeoutMS: 30000,
    socketTimeoutMS: 60000,
  });

  try {
    await client.connect();
    console.log('✅ Conectado ao MongoDB Atlas\n');

    const sourceDB = client.db(SOURCE_DB);
    const targetDB = client.db(TARGET_DB);

    // Limpar coleções de destino
    console.log('🧹 Limpando banco de destino...');
    for (const coll of COLLECTIONS) {
      try {
        await targetDB.collection(coll).deleteMany({});
        console.log(`  ✓ ${coll} limpa`);
      } catch (e) {
        // Coleção pode não existir
      }
    }
    console.log('');

    // Migrar cada coleção
    for (const collName of COLLECTIONS) {
      try {
        const sourceColl = sourceDB.collection(collName);
        const docs = await sourceColl.find({}).toArray();
        
        if (docs.length === 0) {
          console.log(`⏭️  ${collName}: vazia, pulando`);
          continue;
        }

        // Inserir no destino
        const targetColl = targetDB.collection(collName);
        const result = await targetColl.insertMany(docs);
        console.log(`✅ ${collName}: ${result.insertedCount} documentos migrados`);

      } catch (err) {
        console.error(`❌ ${collName}: ${err.message}`);
      }
    }

    console.log('\n🎉 Migração concluída!');

  } catch (err) {
    console.error('\n❌ Erro:', err.message);
    if (err.message.includes('ENOTFOUND')) {
      console.log('\n💡 Dica: Tente usar a conexão do seu backend:');
      console.log('   cd back && node scripts/migrar_via_app.js');
    }
  } finally {
    await client.close();
  }
}

// Se executado diretamente
if (require.main === module) {
  migrar();
}

module.exports = { migrar };
