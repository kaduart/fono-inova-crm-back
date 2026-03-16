/**
 * 🚀 Master Migration Script
 * 
 * Executa todas as migrations financeiras em ordem:
 * 1. sessionValue
 * 2. commissionRate/commissionValue
 * 3. sessionConsumed/statusHistory
 * 4. paidAt (já existe)
 * 
 * Uso: node scripts/migrate-all-financial.js [--dry-run]
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const isDryRun = process.argv.includes('--dry-run');

const migrations = [
  { name: 'Session Values', file: 'migrate-session-values.js' },
  { name: 'Commissions', file: 'migrate-commissions.js' },
  { name: 'Session Consumed', file: 'migrate-session-consumed.js' },
  { name: 'Paid Dates', file: 'migrate-session-paidat.js' }
];

async function runMigration(name, file) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🔄 Executando: ${name}`);
  console.log(`${'='.repeat(60)}\n`);

  return new Promise((resolve, reject) => {
    const args = [join(__dirname, file)];
    if (isDryRun) args.push('--dry-run');

    const child = spawn('node', args, {
      stdio: 'inherit',
      cwd: process.cwd()
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${name} falhou com código ${code}`));
      }
    });
  });
}

async function main() {
  console.log(`🚀 Master Migration ${isDryRun ? '(DRY RUN)' : ''}`);
  console.log('Iniciando em 3 segundos...');
  await new Promise(r => setTimeout(r, 3000));

  try {
    for (const migration of migrations) {
      await runMigration(migration.name, migration.file);
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log('✅ Todas as migrations concluídas!');
    console.log(`${'='.repeat(60)}`);

    if (isDryRun) {
      console.log('\n⚠️  Isso foi um DRY RUN.');
      console.log('   Para executar de verdade, rode:');
      console.log('   node scripts/migrate-all-financial.js');
    }

  } catch (error) {
    console.error('\n❌ Migration interrompida:', error.message);
    process.exit(1);
  }
}

main();
