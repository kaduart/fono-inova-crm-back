#!/usr/bin/env node
/**
 * Profile detalhado do login - isola cada etapa
 */

import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

dotenv.config();

const EMAIL = 'clinicafonoinova@gmail.com';
const PASSWORD = 'admin1234';
const ROLE = 'admin';

async function profile() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  
  console.log('🔬 PROFILE DETALHADO DO LOGIN');
  console.log('='.repeat(60));
  console.log(`Usuário: ${EMAIL} (${ROLE})\n`);
  
  // ETAPA 1: Conexão MongoDB
  const t0 = performance.now();
  await mongoose.connect(mongoUri);
  const connTime = performance.now() - t0;
  console.log(`1️⃣  Conexão MongoDB: ${connTime.toFixed(1)}ms`);
  
  const db = mongoose.connection.db;
  
  // ETAPA 2: Query no banco
  const t1 = performance.now();
  const user = await db.collection('admins').findOne({ email: EMAIL });
  const queryTime = performance.now() - t1;
  console.log(`2️⃣  Query no DB: ${queryTime.toFixed(1)}ms`);
  
  if (!user) {
    console.log('❌ Usuário não encontrado');
    return;
  }
  
  // ETAPA 3: bcrypt.compare
  const t2 = performance.now();
  const isMatch = await bcrypt.compare(PASSWORD, user.password);
  const bcryptTime = performance.now() - t2;
  console.log(`3️⃣  bcrypt.compare: ${bcryptTime.toFixed(1)}ms`);
  
  if (!isMatch) {
    console.log('❌ Senha incorreta');
    return;
  }
  
  // ETAPA 4: Preparar dados
  const t3 = performance.now();
  const userData = {
    id: user._id.toString(),
    name: user.fullName,
    email: user.email,
    role: user.role
  };
  const prepTime = performance.now() - t3;
  console.log(`4️⃣  Preparar dados: ${prepTime.toFixed(1)}ms`);
  
  // ETAPA 5: JWT sign
  const t4 = performance.now();
  const token = jwt.sign(
    { id: user._id.toString(), role: user.role, name: user.fullName },
    process.env.JWT_SECRET,
    { expiresIn: '24h' }
  );
  const jwtTime = performance.now() - t4;
  console.log(`5️⃣  JWT sign: ${jwtTime.toFixed(1)}ms`);
  
  const total = connTime + queryTime + bcryptTime + prepTime + jwtTime;
  
  console.log(`\n📊 TOTAL ESTIMADO: ${total.toFixed(1)}ms`);
  console.log('-'.repeat(60));
  
  // Identificar gargalo
  const times = [
    { name: 'Conexão MongoDB', time: connTime },
    { name: 'Query DB', time: queryTime },
    { name: 'bcrypt', time: bcryptTime },
    { name: 'Preparar dados', time: prepTime },
    { name: 'JWT', time: jwtTime },
  ];
  
  const slowest = times.reduce((a, b) => a.time > b.time ? a : b);
  console.log(`🔥 GARGALO: ${slowest.name} (${slowest.time.toFixed(1)}ms)`);
  
  await mongoose.disconnect();
}

profile().catch(console.error);
