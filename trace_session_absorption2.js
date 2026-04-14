import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { ObjectId } from 'mongodb';
dotenv.config();

try {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  const sessionIds = [
    '69d45032b6ba0a5ae58563b2', // 06/04
    '69d45085d89fb5d1dc8563b1', // 30/03
    '69d45153c842a5a7291b5fb5', // 13/04
    '69d45153c842a5a7291b5fb6', // 20/04
  ];

  for (const sid of sessionIds) {
    const s = await db.collection('sessions').findOne({ _id: new ObjectId(sid) });
    console.log(`\nSession ${sid}`);
    console.log(`  date: ${s?.date}`);
    console.log(`  status: ${s?.status}`);
    console.log(`  isDeleted: ${s?.isDeleted}`);
    console.log(`  deletedAt: ${s?.deletedAt}`);
    console.log(`  deleteReason: ${s?.deleteReason}`);
    console.log(`  package: ${s?.package}`);
    console.log(`  appointmentId: ${s?.appointmentId}`);
  }

  // Buscar scripts/workers com cleanup-orphan
  console.log('\n--- Buscando cleanup-orphan no código ---');
  const { execSync } = await import('child_process');
  try {
    const grep = execSync('grep -r "cleanup-orphan" /home/user/projetos/crm/back --include="*.js" -l', { encoding: 'utf8' });
    console.log('Arquivos:', grep.trim().split('\n'));
  } catch (e) {
    console.log('Nenhum arquivo encontrado com "cleanup-orphan"');
  }

  try {
    const grep2 = execSync('grep -r "orphan" /home/user/projetos/crm/back --include="*.js" -l', { encoding: 'utf8' });
    console.log('Arquivos com "orphan":', grep2.trim().split('\n').slice(0, 20));
  } catch (e) {
    console.log('Nenhum arquivo encontrado com "orphan"');
  }

} finally {
  await mongoose.disconnect();
  process.exit(0);
}
