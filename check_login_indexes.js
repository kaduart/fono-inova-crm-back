import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

async function checkIndexes() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Conectado ao MongoDB\n');

    const db = mongoose.connection.db;

    // Collections usadas no login
    const collections = ['admins', 'doctors', 'users'];
    
    for (const collName of collections) {
      console.log(`\n📊 Collection: ${collName}`);
      console.log('='.repeat(50));
      
      const collection = db.collection(collName);
      const indexes = await collection.indexes();
      
      if (indexes.length === 0) {
        console.log('  ⚠️  Nenhum índice encontrado!');
      } else {
        indexes.forEach(idx => {
          const fields = Object.keys(idx.key).map(k => `${k}:${idx.key[k]}`).join(', ');
          const type = idx.unique ? 'UNIQUE' : (idx.sparse ? 'SPARSE' : 'INDEX');
          console.log(`  ${idx.name.padEnd(20)} | ${type.padEnd(8)} | {${fields}}`);
        });
      }
    }

    // Simular query de login para verificar executionStats
    console.log('\n\n🔍 Análise de Queries de Login');
    console.log('='.repeat(50));
    
    const testEmail = 'admin@fono.com'; // email de teste
    
    // Doctor query analysis
    console.log('\n👨‍⚕️  Doctor.findOne({ email }):');
    const doctorExplain = await db.collection('doctors').findOne(
      { email: testEmail },
      { explain: 'executionStats' }
    ).catch(() => null);
    
    if (doctorExplain?.executionStats) {
      const stats = doctorExplain.executionStats;
      console.log(`  docsExamined: ${stats.totalDocsExamined}`);
      console.log(`  executionTime: ${stats.executionTimeMillis}ms`);
      console.log(`  stage: ${doctorExplain.queryPlanner.winningPlan.stage}`);
    } else {
      console.log('  (collection vazia ou erro)');
    }

    // User query analysis
    console.log('\n👤 User.findOne({ email, role }):');
    const userExplain = await db.collection('users').findOne(
      { email: testEmail, role: 'secretary' },
      { explain: 'executionStats' }
    ).catch(() => null);
    
    if (userExplain?.executionStats) {
      const stats = userExplain.executionStats;
      console.log(`  docsExamined: ${stats.totalDocsExamined}`);
      console.log(`  executionTime: ${stats.executionTimeMillis}ms`);
      console.log(`  stage: ${userExplain.queryPlanner.winningPlan.stage}`);
    } else {
      console.log('  (collection vazia ou erro)');
    }

  } catch (error) {
    console.error('❌ Erro:', error.message);
  } finally {
    await mongoose.disconnect();
    console.log('\n✅ Disconnected');
  }
}

checkIndexes();
