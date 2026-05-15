import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  const isDryRun = !process.argv.includes('--apply');
  console.log(`Modo: ${isDryRun ? 'DRY-RUN (use --apply para executar)' : 'APLICAR'}\n`);

  const guides = await db.collection('insuranceguides').find({}).toArray();
  let fixed = 0;
  let skipped = 0;

  for (const guide of guides) {
    const completedCount = await db.collection('sessions').countDocuments({
      insuranceGuide: guide._id,
      status: 'completed'
    });

    if (completedCount !== guide.usedSessions) {
      const relatedPkg = await db.collection('packages').findOne({ insuranceGuide: guide._id });
      
      // Só sanitizar guias de packages inativos ou sem package (órfãs)
      const shouldFix = !relatedPkg || ['finished', 'cancelled', 'superseded'].includes(relatedPkg?.status);
      
      if (!shouldFix) {
        console.log(`SKIP Guia #${guide.number} (${guide.specialty}) — package ativo/in-progress, requer investigacao manual`);
        skipped++;
        continue;
      }

      console.log(`FIX Guia #${guide.number} (${guide.specialty}) — used: ${guide.usedSessions} → ${completedCount} (delta: ${completedCount - guide.usedSessions})`);
      
      if (!isDryRun) {
        await db.collection('insuranceguides').updateOne(
          { _id: guide._id },
          { $set: { usedSessions: completedCount } }
        );
      }
      fixed++;
    }
  }

  console.log(`\n${isDryRun ? '[DRY-RUN] ' : ''}Resumo: ${fixed} guias corrigidas, ${skipped} puladas`);
  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
