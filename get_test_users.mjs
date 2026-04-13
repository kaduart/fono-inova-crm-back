import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

async function getUsers() {
  try {
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    await mongoose.connect(mongoUri);
    
    const db = mongoose.connection.db;
    
    console.log('🔍 Usuários para teste de login:\n');
    
    // Admin
    const admins = await db.collection('admins').find({}, { projection: { email: 1, fullName: 1 } }).limit(2).toArray();
    console.log('📋 Admins:');
    admins.forEach(u => console.log(`  ${u.email} (${u.fullName})`));
    
    // Doctors
    const doctors = await db.collection('doctors').find({}, { projection: { email: 1, fullName: 1 } }).limit(2).toArray();
    console.log('\n📋 Doctors:');
    doctors.forEach(u => console.log(`  ${u.email} (${u.fullName})`));
    
    // Users
    const users = await db.collection('users').find({}, { projection: { email: 1, fullName: 1, role: 1 } }).limit(3).toArray();
    console.log('\n📋 Users:');
    users.forEach(u => console.log(`  ${u.email} | role: ${u.role} (${u.fullName})`));
    
  } catch (e) {
    console.error('Erro:', e.message);
  } finally {
    await mongoose.disconnect();
  }
}

getUsers();
