/**
 * Script para migrar pré-agendamentos com status 'importado' para 'agendado'
 * 
 * Contexto: O status 'importado' foi renomeado para 'agendado' no código,
 * mas documentos antigos no BD ainda têm o status 'importado'.
 * 
 * Uso: node scripts/migrar-importado-para-agendado.js
 */

const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/agenda-clinica';

async function migrar() {
  try {
    console.log('🔌 Conectando ao MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Conectado!\n');

    const db = mongoose.connection.db;
    const collection = db.collection('preagendamentos');

    // Contar quantos têm status 'importado'
    const totalImportados = await collection.countDocuments({ status: 'importado' });
    console.log(`📊 Pré-agendamentos com status 'importado': ${totalImportados}`);

    if (totalImportados === 0) {
      console.log('✅ Nada a migrar');
      await mongoose.disconnect();
      return;
    }

    // Mostrar alguns exemplos
    const exemplos = await collection
      .find({ status: 'importado' })
      .limit(5)
      .toArray();
    
    console.log('\n📋 Exemplos:');
    exemplos.forEach((doc, i) => {
      console.log(`  ${i + 1}. ${doc.patientInfo?.fullName || 'Sem nome'} (${doc._id})`);
    });

    // Fazer a migração
    console.log('\n🔄 Migrando...');
    const resultado = await collection.updateMany(
      { status: 'importado' },
      { $set: { status: 'agendado' } }
    );

    console.log('\n✅ Migração concluída!');
    console.log(`   Documentos encontrados: ${resultado.matchedCount}`);
    console.log(`   Documentos modificados: ${resultado.modifiedCount}`);

    // Verificar se ficou algum
    const restantes = await collection.countDocuments({ status: 'importado' });
    if (restantes > 0) {
      console.log(`\n⚠️  Atenção: ${restantes} documento(s) ainda têm status 'importado'`);
    } else {
      console.log('\n✅ Todos os documentos foram migrados!');
    }

    await mongoose.disconnect();
    console.log('\n🔌 Desconectado');
    process.exit(0);

  } catch (error) {
    console.error('❌ Erro:', error.message);
    process.exit(1);
  }
}

migrar();
