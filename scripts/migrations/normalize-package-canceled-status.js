#!/usr/bin/env node
/**
 * 🔥 MIGRAÇÃO: Normaliza Package.status de "cancelled" para "canceled"
 *
 * Contexto:
 *   - POST /v2/packages/:id/inactivate gravava status: 'cancelled' (duplo L) via
 *     Package.findByIdAndUpdate sem runValidators — o enum do model Package só aceita
 *     'canceled' (L simples), então o valor era persistido fora do enum sem erro.
 *   - A rota foi corrigida para gravar 'canceled'. Este script normaliza os registros
 *     já gravados com o valor antigo, para que qualquer consumidor que filtre por
 *     status === 'canceled' (grafia do enum) também encontre esses pacotes.
 *
 * Objetivo:
 *   - Migrar todos os Package com status === 'cancelled' para status === 'canceled'
 *
 * Características:
 *   - Idempotente: pode rodar várias vezes
 *   - Batch processing: não sobrecarrega o MongoDB
 *   - Dry-run por padrão: use --commit para aplicar
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const COMMIT = process.argv.includes('--commit');
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '200', 10);
const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

if (!MONGO_URI) {
    console.error('❌ MONGODB_URI não configurado');
    process.exit(1);
}

async function run() {
    console.log(`🔌 Conectando ao MongoDB...`);
    await mongoose.connect(MONGO_URI);
    console.log(`✅ Conectado`);

    const db = mongoose.connection.db;
    const collection = db.collection('packages');

    const totalCancelled = await collection.countDocuments({ status: 'cancelled' });
    const totalCanceledBefore = await collection.countDocuments({ status: 'canceled' });

    console.log(`📊 Package com status='cancelled' (a migrar): ${totalCancelled}`);
    console.log(`📊 Package com status='canceled' (já correto): ${totalCanceledBefore}`);

    if (totalCancelled === 0) {
        console.log('🎉 Nada para fazer.');
        await mongoose.disconnect();
        return;
    }

    if (!COMMIT) {
        console.log('\n⚠️  DRY-RUN: nenhuma alteração será aplicada.');
        console.log('   Exemplos dos primeiros registros:');

        const examples = await collection
            .find({ status: 'cancelled' })
            .limit(5)
            .project({ patient: 1, type: 1, updatedAt: 1 })
            .toArray();

        for (const ex of examples) {
            console.log(`     - _id: ${ex._id} | patient: ${ex.patient} | type: ${ex.type} | updatedAt: ${ex.updatedAt}`);
        }

        console.log('\n   Rode com --commit para aplicar.\n');
        await mongoose.disconnect();
        return;
    }

    let processed = 0;
    let updated = 0;
    let errors = 0;

    const cursor = collection.find({ status: 'cancelled' }).batchSize(BATCH_SIZE);
    let batch = [];

    async function flushBatch() {
        if (batch.length === 0) return;

        const bulkOps = batch.map(doc => ({
            updateOne: {
                filter: { _id: doc._id },
                update: { $set: { status: 'canceled' } }
            }
        }));

        try {
            const result = await collection.bulkWrite(bulkOps, { ordered: false });
            updated += result.modifiedCount || 0;
            console.log(`   ✅ Batch ${Math.ceil(processed / BATCH_SIZE)}: ${result.modifiedCount} atualizados`);
        } catch (err) {
            console.error(`   ❌ Batch error:`, err.message);
            errors += batch.length;
        }

        batch = [];
    }

    console.log(`🚀 Iniciando migração...`);

    for await (const doc of cursor) {
        batch.push(doc);
        processed++;

        if (batch.length >= BATCH_SIZE) {
            await flushBatch();
        }
    }

    await flushBatch();

    const totalCancelledAfter = await collection.countDocuments({ status: 'cancelled' });
    const totalCanceledAfter = await collection.countDocuments({ status: 'canceled' });

    console.log(`\n📊 Resumo:`);
    console.log(`   Processados: ${processed}`);
    console.log(`   Atualizados: ${updated}`);
    console.log(`   Erros: ${errors}`);
    console.log(`\n📊 Auditoria pós-migração:`);
    console.log(`   status='cancelled' restantes: ${totalCancelledAfter} (esperado: 0)`);
    console.log(`   status='canceled' total: ${totalCanceledAfter}`);

    if (errors === 0 && totalCancelledAfter === 0) {
        console.log(`\n🎉 Migração concluída com sucesso.`);
    } else {
        console.log(`\n⚠️  Migração concluída com pendências — revisar.`);
    }

    await mongoose.disconnect();
}

run().catch(err => {
    console.error('💥 Erro fatal:', err);
    process.exit(1);
});
