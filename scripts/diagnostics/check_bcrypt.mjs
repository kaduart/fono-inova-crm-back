import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config();

async function check() {
  try {
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    await mongoose.connect(mongoUri);
    
    const db = mongoose.connection.db;
    const admin = await db.collection('admins').findOne({ email: 'clinicafonoinova@gmail.com' });
    
    if (!admin) {
      console.log('Admin não encontrado');
      return;
    }
    
    console.log('📊 Análise do hash de senha:');
    console.log('-'.repeat(50));
    console.log(`Hash: ${admin.password.substring(0, 30)}...`);
    
    // Detectar rounds do bcrypt
    // Formato: $2a$10$... (10 = cost factor)
    const match = admin.password.match(/^\$2[aby]\$(\d+)\$/);
    if (match) {
      const rounds = parseInt(match[1]);
      console.log(`Rounds: ${rounds}`);
      
      if (rounds >= 12) {
        console.log('⚠️  ROUNDS MUITO ALTO! Recomendado: 10-11');
        console.log('   Cada +1 round = 2x mais lento');
      } else if (rounds >= 10) {
        console.log('✅ Rounds aceitável (poderia ser 10)');
      } else {
        console.log('⚠️  Rounds baixo (segurança comprometida)');
      }
    }
    
    // Testar tempo local do bcrypt
    console.log('\n🧪 Teste local bcrypt.compare:');
    const testPassword = 'admin1234';
    
    const times = [];
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      await bcrypt.compare(testPassword, admin.password);
      times.push(performance.now() - start);
    }
    
    console.log(`  Tentativa 1: ${times[0].toFixed(1)}ms`);
    console.log(`  Tentativa 2: ${times[1].toFixed(1)}ms`);
    console.log(`  Tentativa 3: ${times[2].toFixed(1)}ms`);
    console.log(`  Média: ${(times.reduce((a,b) => a+b)/times.length).toFixed(1)}ms`);
    
  } catch (e) {
    console.error('Erro:', e.message);
  } finally {
    await mongoose.disconnect();
  }
}

check();
