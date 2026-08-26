#!/usr/bin/env node
/**
 * 🔧 MIGRAÇÃO OPERACIONAL: índice único parcial reversalOfEntryId
 *
 * Contexto: o redesenho de idempotência do FinancialLedger (BO 2026-08-26,
 * duplicidade de crédito em recordPaymentReceived) depende de um índice
 * único parcial em `reversalOfEntryId` (models/FinancialLedger.js) — garante
 * que um crédito específico nunca seja revertido duas vezes, mesmo sob
 * concorrência. Confirmado via `listIndexes()` no banco real: esse índice
 * AINDA NÃO EXISTE em produção — só está declarado no schema local. Não
 * depender de `autoIndex` (produção pode rodar com autoIndex desabilitado, e
 * mesmo quando habilitado o build em background não é observável/auditável
 * por este processo). Esta migration cria o índice explicitamente, com
 * preflight de conflito.
 *
 * Modo padrão: DRY-RUN / PREFLIGHT (só leitura, verifica se pode aplicar).
 * Uso:
 *   node scripts/migrations/2026-08-26-financial-ledger-reversal-index.js
 *   node scripts/migrations/2026-08-26-financial-ledger-reversal-index.js --apply
 *
 * Passos:
 *   1. Preflight: conta documentos com reversalOfEntryId já setado e procura
 *      grupos duplicados (violariam o índice único). Se houver QUALQUER
 *      duplicata, ABORTA sem aplicar — precisa de decisão humana sobre qual
 *      registro é o correto antes de criar o índice.
 *   2. Apply (só com --apply): cria o índice explicitamente via
 *      `createIndex`, fora do ciclo de autoIndex do Mongoose.
 *   3. Pós-validação: reconfirma via `listIndexes()` que o índice foi criado
 *      com as opções corretas (unique + partialFilterExpression).
 */

import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import FinancialLedger from '../../models/FinancialLedger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

const ARGS = process.argv.slice(2);
const APPLY = ARGS.includes('--apply');

const INDEX_NAME = 'reversalOfEntryId_1';
const INDEX_SPEC = { reversalOfEntryId: 1 };
const INDEX_OPTIONS = {
  name: INDEX_NAME,
  unique: true,
  partialFilterExpression: { reversalOfEntryId: { $exists: true } },
};

async function preflight() {
  const existingIndexes = await FinancialLedger.collection.listIndexes().toArray();
  const alreadyExists = existingIndexes.some(ix => ix.name === INDEX_NAME);
  if (alreadyExists) {
    console.log(`✅ Índice '${INDEX_NAME}' já existe em produção — nada a fazer.`);
    return { canApply: false, alreadyExists: true, conflicts: [] };
  }

  const totalWithField = await FinancialLedger.collection.countDocuments({ reversalOfEntryId: { $exists: true } });
  const conflicts = await FinancialLedger.collection.aggregate([
    { $match: { reversalOfEntryId: { $exists: true } } },
    { $group: { _id: '$reversalOfEntryId', count: { $sum: 1 }, entryIds: { $push: '$_id' } } },
    { $match: { count: { $gt: 1 } } }
  ]).toArray();

  console.log(`Documentos com reversalOfEntryId setado: ${totalWithField}`);
  console.log(`Grupos duplicados (bloqueiam o índice único): ${conflicts.length}`);
  if (conflicts.length > 0) {
    console.error('❌ CONFLITOS ENCONTRADOS — não é seguro criar o índice único agora:');
    console.error(JSON.stringify(conflicts, null, 2));
  }

  return { canApply: conflicts.length === 0, alreadyExists: false, conflicts, totalWithField };
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  console.log(`\n=== MIGRATION: índice único reversalOfEntryId (FinancialLedger) ===`);
  console.log(`Modo: ${APPLY ? '⚠️  APPLY' : 'DRY-RUN / PREFLIGHT (só leitura)'}`);

  const result = await preflight();

  if (result.alreadyExists) {
    await mongoose.disconnect();
    return;
  }

  if (!result.canApply) {
    console.error('\n❌ ABORTADO — resolva os conflitos antes de tentar aplicar novamente.');
    await mongoose.disconnect();
    process.exit(1);
  }

  if (!APPLY) {
    console.log(`\nℹ️  Preflight OK — sem conflitos. Rode com --apply para criar o índice.`);
    await mongoose.disconnect();
    return;
  }

  console.log('\n⚙️  Criando índice explicitamente (fora do ciclo de autoIndex)...');
  await FinancialLedger.collection.createIndex(INDEX_SPEC, INDEX_OPTIONS);

  const afterIndexes = await FinancialLedger.collection.listIndexes().toArray();
  const created = afterIndexes.find(ix => ix.name === INDEX_NAME);
  if (!created || !created.unique || !created.partialFilterExpression) {
    console.error('❌ Pós-validação falhou — índice não ficou com as opções esperadas:', JSON.stringify(created));
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log('✅ Índice criado e validado:', JSON.stringify(created, null, 2));

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('❌ ERRO FATAL:', err);
  process.exit(1);
});
