#!/usr/bin/env node
/**
 * Script simples de réplica - sem confirmação
 */

import { execSync } from 'child_process';

const ORIGEM = 'test';
const DESTINO = 'crm_development';
const URI = 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net';

console.log('🔄 Iniciando réplica...\n');
console.log(`Origem: ${ORIGEM}`);
console.log(`Destino: ${DESTINO}\n`);

try {
  // Verificar se mongodump existe
  try {
    execSync('mongodump --version', { stdio: 'ignore' });
  } catch (e) {
    console.error('❌ ERRO: mongodump não encontrado');
    console.log('Instale: sudo apt-get install mongodb-database-tools');
    process.exit(1);
  }

  const timestamp = Date.now();
  const dumpDir = `/tmp/mongodump_${timestamp}`;

  // 1. Dump
  console.log('📥 Passo 1/3: Exportando dados...');
  execSync(`mongodump --uri "${URI}/${ORIGEM}" --out ${dumpDir}`, { stdio: 'inherit' });
  console.log('✅ Exportado\n');

  // 2. Dropar destino
  console.log('🗑️  Passo 2/3: Limpando banco de destino...');
  try {
    execSync(`mongosh "${URI}/${DESTINO}" --eval "db.dropDatabase()"`, { stdio: 'ignore' });
    console.log('✅ Limpo\n');
  } catch (e) {
    console.log('⚠️  Banco não existia ou erro ao dropar (continuando)...\n');
  }

  // 3. Restore
  console.log('📤 Passo 3/3: Importando dados...');
  execSync(`mongorestore --uri "${URI}/${DESTINO}" --nsFrom "${ORIGEM}.*" --nsTo "${DESTINO}.*" ${dumpDir}/${ORIGEM}`, { stdio: 'inherit' });
  console.log('✅ Importado\n');

  // Limpar
  execSync(`rm -rf ${dumpDir}`);

  console.log('═══════════════════════════════════════');
  console.log('✅ RÉPLICA CONCLUÍDA COM SUCESSO!');
  console.log('═══════════════════════════════════════');
  console.log(`\nBanco "${DESTINO}" agora é cópia de "${ORIGEM}"`);

} catch (error) {
  console.error('\n❌ ERRO:', error.message);
  console.log('\nVerifique:');
  console.log('1. MongoDB Database Tools instalado');
  console.log('2. Conexão com internet');
  console.log('3. Permissões no MongoDB Atlas');
  process.exit(1);
}
