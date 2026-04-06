#!/usr/bin/env node
/**
 * Script para limpar dados de teste do MongoDB
 * Remove: paciente ANA TESTE, doutor DOUTOR TEST e todos os registros relacionados
 */

const { MongoClient } = require('mongodb');

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/test';
const DB_NAME = 'test';

async function cleanupTestData() {
  console.log('🔌 Conectando ao MongoDB...');
  const client = new MongoClient(MONGO_URI);
  
  try {
    await client.connect();
    console.log('✅ Conectado ao MongoDB');
    
    const db = client.db(DB_NAME);
    
    // ==========================================
    // 1. BUSCAR PACIENTE "ANA TESTE"
    // ==========================================
    console.log('\n📋 Buscando paciente "ANA TESTE"...');
    const patientsCollection = db.collection('patients');
    
    const testPatient = await patientsCollection.findOne({
      $or: [
        { fullName: { $regex: /ANA TESTE/i } },
        { name: { $regex: /ANA TESTE/i } },
        { fullName: 'ANA TESTE' },
        { name: 'ANA TESTE' }
      ]
    });
    
    const patientId = testPatient?._id?.toString();
    console.log(patientId 
      ? `✅ Paciente encontrado: ${patientId} - ${testPatient.fullName || testPatient.name}`
      : '⚠️ Paciente ANA TESTE não encontrado'
    );
    
    // ==========================================
    // 2. BUSCAR DOUTOR "DOUTOR TEST"
    // ==========================================
    console.log('\n📋 Buscando doutor "DOUTOR TEST"...');
    const doctorsCollection = db.collection('doctors');
    
    const testDoctor = await doctorsCollection.findOne({
      $or: [
        { fullName: { $regex: /DOUTOR TEST/i } },
        { name: { $regex: /DOUTOR TEST/i } },
        { fullName: 'DOUTOR TEST' },
        { name: 'DOUTOR TEST' }
      ]
    });
    
    const doctorId = testDoctor?._id?.toString();
    console.log(doctorId
      ? `✅ Doutor encontrado: ${doctorId} - ${testDoctor.fullName || testDoctor.name}`
      : '⚠️ Doutor DOUTOR TEST não encontrado'
    );
    
    if (!patientId && !doctorId) {
      console.log('\n⚠️ Nenhum registro de teste encontrado. Nada a limpar.');
      return;
    }
    
    // ==========================================
    // 3. LISTAR COLLECTIONS
    // ==========================================
    console.log('\n📊 Collections encontradas:');
    const collections = await db.listCollections().toArray();
    collections.forEach(c => console.log(`  - ${c.name}`));
    
    const results = {
      deleted: {},
      errors: []
    };
    
    // ==========================================
    // 4. LIMPAR AGENDAMENTOS (appointments)
    // ==========================================
    console.log('\n🗑️ Limpando agendamentos...');
    try {
      const appointmentsCollection = db.collection('appointments');
      const aptQuery = {
        $or: [
          ...(patientId ? [{ patientId: patientId }, { 'patient._id': patientId }] : []),
          ...(doctorId ? [{ doctorId: doctorId }, { 'doctor._id': doctorId }] : [])
        ]
      };
      
      if (aptQuery.$or.length > 0) {
        const aptCount = await appointmentsCollection.countDocuments(aptQuery);
        const aptResult = await appointmentsCollection.deleteMany(aptQuery);
        results.deleted.appointments = aptResult.deletedCount;
        console.log(`  ✅ ${aptResult.deletedCount} agendamentos removidos`);
      }
    } catch (err) {
      results.errors.push({ collection: 'appointments', error: err.message });
      console.log(`  ⚠️ Erro: ${err.message}`);
    }
    
    // ==========================================
    // 5. LIMPAR SESSÕES (therapysessions)
    // ==========================================
    console.log('\n🗑️ Limpando sessões...');
    try {
      const sessionsCollection = db.collection('therapysessions');
      const sessionQuery = {
        $or: [
          ...(patientId ? [{ patientId: patientId }, { 'patient._id': patientId }] : []),
          ...(doctorId ? [{ doctorId: doctorId }, { 'doctor._id': doctorId }] : [])
        ]
      };
      
      if (sessionQuery.$or.length > 0) {
        const sessionResult = await sessionsCollection.deleteMany(sessionQuery);
        results.deleted.therapysessions = sessionResult.deletedCount;
        console.log(`  ✅ ${sessionResult.deletedCount} sessões removidas`);
      }
    } catch (err) {
      results.errors.push({ collection: 'therapysessions', error: err.message });
      console.log(`  ⚠️ Erro: ${err.message}`);
    }
    
    // ==========================================
    // 6. LIMPAR PAGAMENTOS (payments)
    // ==========================================
    console.log('\n🗑️ Limpando pagamentos...');
    try {
      const paymentsCollection = db.collection('payments');
      const paymentQuery = {
        $or: [
          ...(patientId ? [{ patientId: patientId }, { 'patient._id': patientId }] : []),
          ...(doctorId ? [{ doctorId: doctorId }, { 'doctor._id': doctorId }] : [])
        ]
      };
      
      if (paymentQuery.$or.length > 0) {
        const paymentResult = await paymentsCollection.deleteMany(paymentQuery);
        results.deleted.payments = paymentResult.deletedCount;
        console.log(`  ✅ ${paymentResult.deletedCount} pagamentos removidos`);
      }
    } catch (err) {
      results.errors.push({ collection: 'payments', error: err.message });
      console.log(`  ⚠️ Erro: ${err.message}`);
    }
    
    // ==========================================
    // 7. LIMPAR CONVÊNIOS (insurances)
    // ==========================================
    console.log('\n🗑️ Limpando convênios...');
    try {
      const insurancesCollection = db.collection('insurances');
      const insuranceQuery = {
        $or: [
          ...(patientId ? [{ patientId: patientId }, { 'patient._id': patientId }] : []),
          ...(doctorId ? [{ doctorId: doctorId }, { 'doctor._id': doctorId }] : [])
        ]
      };
      
      if (insuranceQuery.$or.length > 0) {
        const insuranceResult = await insurancesCollection.deleteMany(insuranceQuery);
        results.deleted.insurances = insuranceResult.deletedCount;
        console.log(`  ✅ ${insuranceResult.deletedCount} convênios removidos`);
      }
    } catch (err) {
      results.errors.push({ collection: 'insurances', error: err.message });
      console.log(`  ⚠️ Erro: ${err.message}`);
    }
    
    // ==========================================
    // 8. LIMPAR GUIAS (guides)
    // ==========================================
    console.log('\n🗑️ Limpando guias...');
    try {
      const guidesCollection = db.collection('guides');
      const guideQuery = {
        $or: [
          ...(patientId ? [{ patientId: patientId }] : []),
          ...(doctorId ? [{ doctorId: doctorId }] : [])
        ]
      };
      
      if (guideQuery.$or.length > 0) {
        const guideResult = await guidesCollection.deleteMany(guideQuery);
        results.deleted.guides = guideResult.deletedCount;
        console.log(`  ✅ ${guideResult.deletedCount} guias removidas`);
      }
    } catch (err) {
      results.errors.push({ collection: 'guides', error: err.message });
      console.log(`  ⚠️ Erro: ${err.message}`);
    }
    
    // ==========================================
    // 9. LIMPAR EVENTOS (eventstore)
    // ==========================================
    console.log('\n🗑️ Limpando eventos...');
    try {
      const eventsCollection = db.collection('eventstore');
      const eventQuery = {
        $or: [
          ...(patientId ? [{ 'payload.patientId': patientId }, { 'payload.patient._id': patientId }] : []),
          ...(doctorId ? [{ 'payload.doctorId': doctorId }, { 'payload.doctor._id': doctorId }] : [])
        ]
      };
      
      if (eventQuery.$or.length > 0) {
        const eventResult = await eventsCollection.deleteMany(eventQuery);
        results.deleted.eventstore = eventResult.deletedCount;
        console.log(`  ✅ ${eventResult.deletedCount} eventos removidos`);
      }
    } catch (err) {
      results.errors.push({ collection: 'eventstore', error: err.message });
      console.log(`  ⚠️ Erro: ${err.message}`);
    }
    
    // ==========================================
    // 10. LIMPAR PACOTES (packages)
    // ==========================================
    console.log('\n🗑️ Limpando pacotes...');
    try {
      const packagesCollection = db.collection('packages');
      const packageQuery = {
        $or: [
          ...(patientId ? [{ patientId: patientId }, { 'patient._id': patientId }] : []),
          ...(doctorId ? [{ doctorId: doctorId }, { 'doctor._id': doctorId }] : [])
        ]
      };
      
      if (packageQuery.$or.length > 0) {
        const packageResult = await packagesCollection.deleteMany(packageQuery);
        results.deleted.packages = packageResult.deletedCount;
        console.log(`  ✅ ${packageResult.deletedCount} pacotes removidos`);
      }
    } catch (err) {
      results.errors.push({ collection: 'packages', error: err.message });
      console.log(`  ⚠️ Erro: ${err.message}`);
    }
    
    // ==========================================
    // 11. LIMPAR VIEWS (patientsview)
    // ==========================================
    console.log('\n🗑️ Limpando projections/views...');
    try {
      const patientsViewCollection = db.collection('patientsview');
      const viewQuery = {
        $or: [
          ...(patientId ? [{ patientId: patientId }] : []),
          ...(doctorId ? [{ doctorId: doctorId }] : [])
        ]
      };
      
      if (viewQuery.$or.length > 0) {
        const viewResult = await patientsViewCollection.deleteMany(viewQuery);
        results.deleted.patientsview = viewResult.deletedCount;
        console.log(`  ✅ ${viewResult.deletedCount} registros da view removidos`);
      }
    } catch (err) {
      results.errors.push({ collection: 'patientsview', error: err.message });
      console.log(`  ⚠️ Erro: ${err.message}`);
    }
    
    // ==========================================
    // 12. REMOVER PACIENTE
    // ==========================================
    if (patientId) {
      console.log('\n🗑️ Removendo paciente...');
      try {
        const patientResult = await patientsCollection.deleteOne({ _id: testPatient._id });
        results.deleted.patient = patientResult.deletedCount;
        console.log(`  ✅ Paciente ANA TESTE removido`);
      } catch (err) {
        results.errors.push({ collection: 'patients', error: err.message });
        console.log(`  ⚠️ Erro: ${err.message}`);
      }
    }
    
    // ==========================================
    // 13. REMOVER DOUTOR
    // ==========================================
    if (doctorId) {
      console.log('\n🗑️ Removendo doutor...');
      try {
        const doctorResult = await doctorsCollection.deleteOne({ _id: testDoctor._id });
        results.deleted.doctor = doctorResult.deletedCount;
        console.log(`  ✅ Doutor DOUTOR TEST removido`);
      } catch (err) {
        results.errors.push({ collection: 'doctors', error: err.message });
        console.log(`  ⚠️ Erro: ${err.message}`);
      }
    }
    
    // ==========================================
    // RESUMO
    // ==========================================
    console.log('\n' + '='.repeat(50));
    console.log('📊 RESUMO DA LIMPEZA');
    console.log('='.repeat(50));
    
    const totalDeleted = Object.values(results.deleted).reduce((a, b) => a + (b || 0), 0);
    console.log(`\n✅ Total de registros removidos: ${totalDeleted}`);
    
    Object.entries(results.deleted).forEach(([collection, count]) => {
      if (count) {
        console.log(`  - ${collection}: ${count}`);
      }
    });
    
    if (results.errors.length > 0) {
      console.log(`\n⚠️ Erros encontrados: ${results.errors.length}`);
      results.errors.forEach(e => console.log(`  - ${e.collection}: ${e.error}`));
    }
    
    console.log('\n✨ Limpeza concluída!');
    
  } catch (error) {
    console.error('\n❌ Erro fatal:', error.message);
    process.exit(1);
  } finally {
    await client.close();
    console.log('\n🔌 Conexão fechada');
  }
}

// Executar
console.log('='.repeat(50));
console.log('🧹 SCRIPT DE LIMPEZA - DADOS DE TESTE');
console.log('='.repeat(50));
console.log('\n⚠️  ATENÇÃO: Este script irá remover permanentemente:');
console.log('   - Paciente: ANA TESTE');
console.log('   - Doutor: DOUTOR TEST');
console.log('   - Todos os agendamentos relacionados');
console.log('   - Todos os pagamentos relacionados');
console.log('   - Todas as sessões relacionadas');
console.log('   - Todos os convênios relacionados');
console.log('   - Eventos e projections\n');

// Verificar flag de confirmação
if (process.argv.includes('--confirm')) {
  cleanupTestData();
} else {
  console.log('💡 Para executar a limpeza, rode:');
  console.log('   node scripts/cleanup-test-data.js --confirm\n');
  console.log('🛑 Execução cancelada (flag --confirm não encontrada)');
  process.exit(0);
}
