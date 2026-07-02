#!/usr/bin/env node
/**
 * Corrige guidePolicy do convênio unimed-anapolis para until_consumed.
 *
 * Uso:
 *   node scripts/corrigir-guidePolicy-unimed-anapolis.js           # dry-run
 *   node scripts/corrigir-guidePolicy-unimed-anapolis.js --confirm # aplica
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const isConfirm = process.argv.includes('--confirm');

const NOVA_POLITICA = {
  renewalType: 'until_consumed',
  renewalDay: 'last_day',
  expirationWarningDays: 5,
  autoSuggestRenewal: true,
  defaultMigrationStrategy: 'eligible'
};

async function main() {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI ou MONGO_URI não configurado no .env');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log('Conectado ao MongoDB');

  const db = mongoose.connection.db;

  try {
    const convenio = await db.collection('convenios').findOne({ code: 'unimed-anapolis' });

    if (!convenio) {
      console.log('Convênio unimed-anapolis não encontrado.');
      return;
    }

    console.log('Convênio encontrado:');
    console.log(`  Código: ${convenio.code}`);
    console.log(`  Nome: ${convenio.name}`);
    console.log(`  Política atual: ${JSON.stringify(convenio.guidePolicy)}`);
    console.log(`  Nova política: ${JSON.stringify(NOVA_POLITICA)}`);

    if (!isConfirm) {
      console.log('\n>>> MODO DRY-RUN: nenhuma alteração aplicada <<<');
      console.log('Para aplicar, rode com --confirm');
      return;
    }

    await db.collection('convenios').updateOne(
      { _id: convenio._id },
      { $set: { guidePolicy: NOVA_POLITICA, updatedAt: new Date() } }
    );

    console.log('\n✅ Política atualizada com sucesso.');

  } finally {
    await mongoose.disconnect();
    console.log('\nDesconectado do MongoDB');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
