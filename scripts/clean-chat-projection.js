/**
 * Limpa registros ChatProjection criados pelo worker com dados incompletos
 * Preserva registros do backfill (que têm phone preenchido)
 */
import mongoose from 'mongoose';
import ChatProjection from '../models/ChatProjection.js';

async function main() {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  
  const cutoff = new Date('2026-04-24T00:00:00Z');
  
  // Remove registros criados hoje sem phone (bagunça do worker)
  const result = await ChatProjection.deleteMany({
    createdAt: { $gte: cutoff },
    $or: [
      { phone: null },
      { phone: '' },
      { phone: { $exists: false } }
    ]
  });
  
  console.log(`Removidos ${result.deletedCount} registros sem phone`);
  
  // Atualiza registros sem contactName para ter pelo menos o phone visível
  const updated = await ChatProjection.updateMany(
    { 
      $or: [
        { contactName: null },
        { contactName: '' }
      ]
    },
    [
      {
        $set: {
          contactName: {
            $cond: {
              if: { $or: [{ $eq: ['$phone', null] }, { $eq: ['$phone', ''] }] },
              then: 'Sem nome',
              else: '$phone'
            }
          }
        }
      }
    ]
  );
  
  console.log(`Atualizados ${updated.modifiedCount} registros sem nome`);
  
  await mongoose.disconnect();
}

main().catch(console.error);
