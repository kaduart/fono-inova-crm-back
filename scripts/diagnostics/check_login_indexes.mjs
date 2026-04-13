import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

async function checkIndexes() {
  try {
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!mongoUri) {
      console.log('❌ MONGO_URI não encontrado no .env');
      return;
    }
    
    await mongoose.connect(mongoUri);
    console.log('✅ Conectado ao MongoDB\n');

    const db = mongoose.connection.db;

    // Collections usadas no login
    const collections = ['admins', 'doctors', 'users'];
    
    for (const collName of collections) {
      console.log(`\n📊 Collection: ${collName}`);
      console.log('='.repeat(50));
      
      try {
        const collection = db.collection(collName);
        const indexes = await collection.indexes();
        
        if (indexes.length <= 1) {  // _id index always exists
          console.log('  ⚠️  Apenas índice _id (padrão) - FALTA ÍNDICE EM EMAIL!');
        } else {
          indexes.forEach(idx => {
            const fields = Object.keys(idx.key).map(k => `${k}:${idx.key[k]}`).join(', ');
            const type = idx.unique ? 'UNIQUE' : (idx.sparse ? 'SPARSE' : 'INDEX');
            const warning = fields.includes('email') ? ' ✅' : '';
            console.log(`  ${idx.name.padEnd(25)} | ${type.padEnd(8)} | {${fields}}${warning}`);
          });
        }
      } catch (e) {
        console.log(`  ⚠️  Collection não existe: ${e.message}`);
      }
    }

    // Verificar tamanho das collections
    console.log('\n\n📈 Estatísticas das Collections');
    console.log('='.repeat(50));
    
    for (const collName of collections) {
      try {
        const collection = db.collection(collName);
        const count = await collection.countDocuments();
        console.log(`  ${collName.padEnd(15)}: ${count} documentos`);
      } catch (e) {
        console.log(`  ${collName.padEnd(15)}: erro ao contar`);
      }
    }

  } catch (error) {
    console.error('❌ Erro:', error.message);
  } finally {
    await mongoose.disconnect();
    console.log('\n✅ Disconnected');
  }
}

checkIndexes();
