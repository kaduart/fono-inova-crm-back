/**
 * Corrige o serviceType do appointment da Liz Caldas Rabellatto
 * de 'evaluation' para 'joint_session'
 *
 * Appointment ID: 6a27277f857a29ad236d32d6
 *
 *   node scripts/fix-liz-joint-session.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env') });

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!MONGO_URI) { console.error('❌ MONGODB_URI não encontrado'); process.exit(1); }

const APPOINTMENT_ID = '6a27277f857a29ad236d32d6';

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log('✅ Conectado ao MongoDB');

  const db = mongoose.connection.db;
  const col = db.collection('appointments');

  const before = await col.findOne({ _id: new mongoose.Types.ObjectId(APPOINTMENT_ID) });
  if (!before) { console.error('❌ Appointment não encontrado'); process.exit(1); }

  console.log(`📋 Antes: serviceType=${before.serviceType}, patient=${before.patientInfo?.fullName}`);

  const result = await col.updateOne(
    { _id: new mongoose.Types.ObjectId(APPOINTMENT_ID) },
    { $set: { serviceType: 'joint_session', isJointSession: true } }
  );

  console.log(`✅ Atualizado: ${result.modifiedCount} documento`);

  const after = await col.findOne({ _id: new mongoose.Types.ObjectId(APPOINTMENT_ID) });
  console.log(`📋 Depois: serviceType=${after.serviceType}, isJointSession=${after.isJointSession}`);

  await mongoose.disconnect();
}

run().catch(err => { console.error('💥', err.message); process.exit(1); });
