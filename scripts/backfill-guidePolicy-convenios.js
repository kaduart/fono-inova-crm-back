#!/usr/bin/env node
/**
 * Backfill de guidePolicy para convênios legados.
 *
 * Uso:
 *   node scripts/backfill-guidePolicy-convenios.js [--dry-run]
 *
 * O script atualiza convênios sem guidePolicy com uma política padrão.
 * Recomenda-se rodar com --dry-run primeiro para validar.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const isDryRun = process.argv.includes('--dry-run');

/**
 * Políticas padrão por convênio.
 * Ajuste conforme regra de negócio real de cada convênio.
 */
const DEFAULT_POLICIES = {
  'unimed-anapolis': {
    renewalType: 'end_of_month',
    renewalDay: 'last_day',
    expirationWarningDays: 5,
    autoSuggestRenewal: true,
    defaultMigrationStrategy: 'eligible'
  },
  'unimed-campinas': {
    renewalType: 'end_of_month',
    renewalDay: 'last_day',
    expirationWarningDays: 5,
    autoSuggestRenewal: true,
    defaultMigrationStrategy: 'eligible'
  },
  'unimed-goiania': {
    renewalType: 'end_of_month',
    renewalDay: 'last_day',
    expirationWarningDays: 5,
    autoSuggestRenewal: true,
    defaultMigrationStrategy: 'eligible'
  },
  'unimed-fesp': {
    renewalType: 'end_of_month',
    renewalDay: 'last_day',
    expirationWarningDays: 5,
    autoSuggestRenewal: true,
    defaultMigrationStrategy: 'eligible'
  },
  'bradesco-saude': {
    renewalType: 'end_of_month',
    renewalDay: 'last_day',
    expirationWarningDays: 5,
    autoSuggestRenewal: true,
    defaultMigrationStrategy: 'eligible'
  }
};

const FALLBACK_POLICY = {
  renewalType: 'end_of_month',
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
  if (isDryRun) {
    console.log('>>> MODO DRY-RUN: nenhuma alteração será aplicada <<<\n');
  }

  const db = mongoose.connection.db;

  try {
    const conveniosSemPolicy = await db.collection('convenios').find({
      $or: [
        { guidePolicy: { $exists: false } },
        { guidePolicy: null }
      ]
    }).project({ code: 1, name: 1, guidePolicy: 1 }).toArray();

    console.log(`Convênios sem guidePolicy encontrados: ${conveniosSemPolicy.length}`);

    for (const convenio of conveniosSemPolicy) {
      const policy = DEFAULT_POLICIES[convenio.code] || FALLBACK_POLICY;

      console.log(`\n- ${convenio.code} (${convenio.name || 'sem nome'})`);
      console.log(`  Política a aplicar: ${JSON.stringify(policy)}`);

      if (!isDryRun) {
        await db.collection('convenios').updateOne(
          { _id: convenio._id },
          { $set: { guidePolicy: policy, updatedAt: new Date() } }
        );
        console.log('  ✅ Atualizado');
      } else {
        console.log('  ⏭️  Ignorado (dry-run)');
      }
    }

    console.log('\n=== Resumo ===');
    console.log(`Convênios processados: ${conveniosSemPolicy.length}`);
    if (isDryRun) {
      console.log('Nenhuma alteração foi aplicada. Remova --dry-run para aplicar.');
    } else {
      console.log('Alterações aplicadas com sucesso.');
    }

  } finally {
    await mongoose.disconnect();
    console.log('\nDesconectado do MongoDB');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
