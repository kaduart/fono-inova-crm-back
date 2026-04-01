#!/usr/bin/env node
/**
 * Script para clonar banco de produção para testes
 * 
 * Uso:
 *   node scripts/clone-db-for-testing.js
 * 
 * Cria:
 *   - crm_test (banco limpo para testes 4.0)
 *   - Mantém crm (produção intacto)
 */

import mongoose from 'mongoose';
import { exec } from 'child_process';
import { promisify } from 'util';
import dotenv from 'dotenv';

dotenv.config();

const execAsync = promisify(exec);

const SOURCE_DB = process.env.MONGO_DB_NAME || 'crm';
const TARGET_DB = `${SOURCE_DB}_test`;
const MONGO_URI = process.env.MONGO_URI;

async function cloneDatabase() {
  console.log('🔄 CLONAGEM DE BANCO PARA TESTES\n');
  console.log(`Origem: ${SOURCE_DB}`);
  console.log(`Destino: ${TARGET_DB}\n`);
  
  // Extrai URI base (sem nome do banco)
  const baseUri = MONGO_URI.replace(/\/[^/]*$/, '');
  
  try {
    // 1. Verifica conexão
    console.log('1️⃣ Verificando conexão...');
    await mongoose.connect(MONGO_URI);
    console.log('   ✅ Conectado\n');
    
    // 2. Lista coleções
    console.log('2️⃣ Listando coleções...');
    const collections = await mongoose.connection.db.listCollections().toArray();
    console.log(`   ${collections.length} coleções encontradas:\n`);
    
    // 3. Cria banco de teste
    console.log('3️⃣ Criando banco de teste...');
    const testConnection = await mongoose.createConnection(`${baseUri}/${TARGET_DB}`);
    console.log('   ✅ Banco de teste criado\n');
    
    // 4. Copia coleções (só estrutura + alguns dados)
    console.log('4️⃣ Copiando dados (pacientes, médicos, config)...');
    
    const collectionsToClone = [
      'patients',      // Dados essenciais
      'doctors',       // Dados essenciais
      'packages',      // Para testar pacotes
      'insuranceguides', // Para testar convênio
      'users',         // Autenticação
    ];
    
    const collectionsToSkip = [
      'appointments',   // Não copia agendamentos (limpo)
      'sessions',       // Não copia sessões (limpo)
      'payments',       // Não copia payments (limpo)
      'followups',      // Não copia
      'logs',           // Não copia
      'outboxes',       // Não copia
    ];
    
    for (const collName of collectionsToClone) {
      const sourceColl = mongoose.connection.db.collection(collName);
      const targetColl = testConnection.db.collection(collName);
      
      // Limpa destino
      await targetColl.deleteMany({});
      
      // Copia dados (limita para não ficar gigante)
      const docs = await sourceColl.find({}).limit(1000).toArray();
      if (docs.length > 0) {
        await targetColl.insertMany(docs);
        console.log(`   ✅ ${collName}: ${docs.length} documentos`);
      } else {
        console.log(`   ⚠️  ${collName}: vazio`);
      }
    }
    
    console.log('\n5️⃣ Coleções IGNORADAS (banco de testes limpo):');
    for (const collName of collectionsToSkip) {
      console.log(`   🚫 ${collName} (não copiado)`);
    }
    
    // 6. Cria índices essenciais
    console.log('\n6️⃣ Criando índices...');
    await testConnection.db.collection('appointments').createIndex({ patient: 1 });
    await testConnection.db.collection('appointments').createIndex({ doctor: 1 });
    await testConnection.db.collection('appointments').createIndex({ date: 1 });
    await testConnection.db.collection('sessions').createIndex({ appointment: 1 });
    await testConnection.db.collection('payments').createIndex({ appointmentId: 1 });
    console.log('   ✅ Índices criados\n');
    
    // 7. Cria usuário de teste admin
    console.log('7️⃣ Criando usuário de teste...');
    const usersColl = testConnection.db.collection('users');
    const existingAdmin = await usersColl.findOne({ email: 'teste@admin.com' });
    
    if (!existingAdmin) {
      await usersColl.insertOne({
        fullName: 'Usuário Teste Admin',
        email: 'teste@admin.com',
        password: '$2b$10$testeHashAqui', // Troque por hash real
        role: 'admin',
        isActive: true,
        createdAt: new Date()
      });
      console.log('   ✅ Usuário teste@admin.com criado');
    } else {
      console.log('   ℹ️  Usuário teste já existe');
    }
    
    // Fecha conexões
    await testConnection.close();
    await mongoose.disconnect();
    
    console.log('\n' + '='.repeat(50));
    console.log('✅ CLONAGEM CONCLUÍDA!');
    console.log('='.repeat(50));
    console.log(`\nBanco de testes: ${TARGET_DB}`);
    console.log(`URI: ${baseUri}/${TARGET_DB}`);
    console.log('\nPara usar:');
    console.log(`  MONGO_URI=${baseUri}/${TARGET_DB} npm run dev`);
    console.log('\nOu crie um .env.test:');
    console.log(`  cp .env .env.test`);
    console.log(`  # Edite MONGO_URI para apontar para ${TARGET_DB}`);
    
  } catch (error) {
    console.error('\n❌ ERRO:', error.message);
    process.exit(1);
  }
}

// Confirmação
console.log('⚠️  ATENÇÃO!');
console.log('Este script vai criar um banco PARALELO para testes.');
console.log('O banco de PRODUÇÃO não será alterado.\n');
console.log('Pressione ENTER para continuar ou CTRL+C para cancelar...');

process.stdin.once('data', () => {
  cloneDatabase();
});
