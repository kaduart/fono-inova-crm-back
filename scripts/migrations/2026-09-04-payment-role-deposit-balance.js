#!/usr/bin/env node
/**
 * 🔧 MIGRAÇÃO OPERACIONAL: Payment.paymentRole + índice único por papel
 *
 * Contexto: feature "sinal + saldo" (2026-09-04) — consulta particular
 * parcelada em 2 Payments (deposit + balance) em vez de 1. O índice único
 * existente (`unique_active_payment_per_appt_billingtype`, em
 * {appointment,billingType}) permitia só 1 Payment ativo por consulta; o novo
 * desenho precisa de exatamente 2, um por papel. Esta migração:
 *
 *   1. Backfill: todo Payment existente (papel implícito, sempre "cobre a
 *      consulta inteira") ganha paymentRole='standard' — preserva 100% do
 *      comportamento atual, sem mudar nenhum dado financeiro.
 *   2. Valida que nenhum grupo {appointment,billingType,paymentRole} ativo
 *      tem mais de 1 documento (deveria ser impossível — o índice antigo já
 *      garantia no máximo 1 por {appointment,billingType}, e todo mundo vira
 *      'standard' — mas valida antes de confiar cegamente).
 *   3. Cria o novo índice único {appointment,billingType,paymentRole}.
 *   4. SÓ DEPOIS de confirmar o novo índice, remove o índice antigo.
 *   5. Relatório final.
 *
 * Modo padrão: DRY-RUN (só leitura — conta e valida, não escreve nada).
 * Uso:
 *   node scripts/migrations/2026-09-04-payment-role-deposit-balance.js
 *   node scripts/migrations/2026-09-04-payment-role-deposit-balance.js --execute
 *   node scripts/migrations/2026-09-04-payment-role-deposit-balance.js --rollback
 *
 * Ordem segura (sem janela de duplicação):
 *   - O índice antigo continua ativo durante todo o backfill e a criação do
 *     novo índice — nenhum código passa a criar um 2º Payment por consulta
 *     antes desta migração ser aplicada em produção (a feature lê o índice
 *     via domain/payment/depositBalance.js, que só é exercitado pelos fluxos
 *     de sinal, não pelo legado). O índice antigo só é removido no passo 4,
 *     depois do novo já estar confirmado — nunca há um momento em que nenhum
 *     dos dois índices está protegendo contra duplicidade.
 */

import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Payment from '../../models/Payment.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

const ARGS = process.argv.slice(2);
const EXECUTE = ARGS.includes('--execute');
const ROLLBACK = ARGS.includes('--rollback');

// ⚠️ Dois problemas confirmados rodando esta migração contra um mongod real
// (não só lidos em documentação — reproduzidos com erro código 67
// CannotCreateIndex):
//   1. `sparse` + `partialFilterExpression` juntos são REJEITADOS pelo MongoDB.
//   2. `$ne`/`$nin` NÃO são operadores suportados em partialFilterExpression
//      (só $eq, $exists, $gt/$gte/$lt/$lte, $type e $and no topo).
// O índice antigo tal como estava declarado em models/Payment.js tinha AMBOS
// os problemas — ou seja, é bem provável que nunca tenha sido criado de fato
// em produção, só existia no schema (mesma classe de risco documentada em
// scripts/migrations/2026-08-26-financial-ledger-reversal-index.js). As specs
// abaixo usam o mesmo padrão já funcional do índice irmão
// `unique_active_convenio_payment_per_session` (models/Payment.js): `$type`
// em vez de `$exists+$ne`, `$in` (allowlist positiva) em vez de `$nin`, sem
// `sparse`. ACTIVE_STATUSES precisa continuar em sincronia com o enum
// Payment.status em models/Payment.js.
const ACTIVE_STATUSES = ['pending', 'pending_billing', 'billed', 'partial', 'paid', 'refunded', 'converted_to_package', 'recognized', 'consumed'];

const OLD_INDEX_NAME = 'unique_active_payment_per_appt_billingtype';
const OLD_INDEX_SPEC = { appointment: 1, billingType: 1 };
const OLD_INDEX_OPTIONS = {
  name: OLD_INDEX_NAME,
  unique: true,
  partialFilterExpression: {
    appointment: { $type: 'objectId' },
    status: { $in: ACTIVE_STATUSES },
  },
};

const NEW_INDEX_NAME = 'unique_active_payment_per_appt_billingtype_role';
const NEW_INDEX_SPEC = { appointment: 1, billingType: 1, paymentRole: 1 };
const NEW_INDEX_OPTIONS = {
  name: NEW_INDEX_NAME,
  unique: true,
  partialFilterExpression: {
    appointment: { $type: 'objectId' },
    status: { $in: ACTIVE_STATUSES },
  },
};

async function countMissingRole() {
  return Payment.collection.countDocuments({
    $or: [{ paymentRole: { $exists: false } }, { paymentRole: null }],
  });
}

async function findDuplicateRoleGroups() {
  return Payment.collection
    .aggregate([
      {
        $match: {
          appointment: { $exists: true, $ne: null },
          status: { $nin: ['cancelled', 'canceled'] },
        },
      },
      {
        $group: {
          _id: {
            appointment: '$appointment',
            billingType: '$billingType',
            paymentRole: { $ifNull: ['$paymentRole', 'standard'] },
          },
          count: { $sum: 1 },
          paymentIds: { $push: '$_id' },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();
}

async function listIndexNames() {
  const indexes = await Payment.collection.listIndexes().toArray();
  return indexes.map((ix) => ix.name);
}

async function report(label, data) {
  console.log(`\n--- ${label} ---`);
  console.log(JSON.stringify(data, null, 2));
}

async function runBackfillAndIndexSwap() {
  const missingBefore = await countMissingRole();
  console.log(`Payments sem paymentRole (backfill necessário): ${missingBefore}`);

  if (!EXECUTE) {
    const duplicates = await findDuplicateRoleGroups();
    await report('Preflight — grupos duplicados (simulando paymentRole=standard p/ ausentes)', {
      totalMissingRole: missingBefore,
      duplicateGroups: duplicates.length,
      duplicates,
    });
    console.log('\nℹ️  DRY-RUN — nenhuma escrita foi feita. Rode com --execute para aplicar.');
    return;
  }

  // 1. Backfill
  const backfillResult = await Payment.collection.updateMany(
    { $or: [{ paymentRole: { $exists: false } }, { paymentRole: null }] },
    { $set: { paymentRole: 'standard' } }
  );
  console.log(`✅ Backfill aplicado: ${backfillResult.modifiedCount} Payments atualizados para paymentRole='standard'.`);

  // 2. Validação de duplicidade — ABORTA se encontrar (índice antigo já deveria
  // ter impedido isso estruturalmente, mas nunca confia cegamente em dado histórico).
  const duplicates = await findDuplicateRoleGroups();
  if (duplicates.length > 0) {
    console.error('❌ CONFLITOS ENCONTRADOS — não é seguro criar o índice novo agora:');
    console.error(JSON.stringify(duplicates, null, 2));
    console.error('\n❌ ABORTADO antes de tocar nos índices. Resolva os conflitos manualmente e rode de novo.');
    process.exit(1);
  }
  console.log('✅ Nenhum grupo duplicado — seguro para criar o índice novo.');

  // 3. Cria o índice novo (o antigo continua ativo em paralelo até o passo 4)
  const indexNamesBefore = await listIndexNames();
  if (indexNamesBefore.includes(NEW_INDEX_NAME)) {
    console.log(`ℹ️  Índice '${NEW_INDEX_NAME}' já existe — pulando criação.`);
  } else {
    console.log('\n⚙️  Criando novo índice único {appointment,billingType,paymentRole}...');
    await Payment.collection.createIndex(NEW_INDEX_SPEC, NEW_INDEX_OPTIONS);
  }

  const indexNamesAfterNew = await listIndexNames();
  const newIndexCreated = indexNamesAfterNew.includes(NEW_INDEX_NAME);
  if (!newIndexCreated) {
    console.error('❌ Pós-validação falhou — índice novo não foi criado. Índice antigo permanece intacto.');
    process.exit(1);
  }
  console.log('✅ Índice novo criado e confirmado via listIndexes().');

  // 4. Remove o índice antigo — SÓ AGORA, com o novo já confirmado.
  if (indexNamesAfterNew.includes(OLD_INDEX_NAME)) {
    console.log('\n⚙️  Removendo índice antigo {appointment,billingType}...');
    await Payment.collection.dropIndex(OLD_INDEX_NAME);
    console.log('✅ Índice antigo removido.');
  } else {
    console.log(`ℹ️  Índice antigo '${OLD_INDEX_NAME}' já não existia — nada a remover.`);
  }

  const finalIndexes = await listIndexNames();
  await report('Relatório final', {
    backfilled: backfillResult.modifiedCount,
    duplicateGroupsFound: 0,
    newIndexPresent: finalIndexes.includes(NEW_INDEX_NAME),
    oldIndexPresent: finalIndexes.includes(OLD_INDEX_NAME),
    allIndexes: finalIndexes,
  });
}

async function runRollback() {
  console.log('\n⚠️  ROLLBACK — restaura o índice antigo {appointment,billingType} e remove o novo.');
  const indexNames = await listIndexNames();

  if (!indexNames.includes(OLD_INDEX_NAME)) {
    console.log('⚙️  Recriando índice antigo...');
    await Payment.collection.createIndex(OLD_INDEX_SPEC, OLD_INDEX_OPTIONS);
    console.log('✅ Índice antigo recriado.');
  } else {
    console.log('ℹ️  Índice antigo já existe — nada a recriar.');
  }

  if (indexNames.includes(NEW_INDEX_NAME)) {
    console.log('⚙️  Removendo índice novo...');
    await Payment.collection.dropIndex(NEW_INDEX_NAME);
    console.log('✅ Índice novo removido.');
  } else {
    console.log('ℹ️  Índice novo já não existia — nada a remover.');
  }

  // Nota: o rollback NÃO reverte paymentRole='standard' de volta pra ausente —
  // é um campo aditivo e inofensivo para o índice antigo (que nunca leu
  // paymentRole). Reverter os dados não é necessário para o rollback ser seguro.
  console.log('\nℹ️  paymentRole permanece nos documentos (campo aditivo, inofensivo pro índice antigo).');

  const finalIndexes = await listIndexNames();
  await report('Relatório do rollback', { allIndexes: finalIndexes });
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  console.log('\n=== MIGRATION: Payment.paymentRole (sinal + saldo) ===');
  console.log(`Modo: ${ROLLBACK ? '⚠️  ROLLBACK' : EXECUTE ? '⚠️  EXECUTE' : 'DRY-RUN (só leitura)'}`);

  if (ROLLBACK) {
    await runRollback();
  } else {
    await runBackfillAndIndexSwap();
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('❌ ERRO FATAL:', err);
  process.exit(1);
});
