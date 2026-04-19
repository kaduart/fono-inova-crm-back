#!/usr/bin/env node
/**
 * 🔥 MIGRAÇÃO: Remove "converted" do domínio de appointments
 *
 * Contexto:
 *   - "converted" era um estado transitório interno usado quando um pré-agendamento
 *     era confirmado — o pré-agendamento original era marcado como "converted"
 *     e um novo appointment "scheduled" era criado.
 *   - Isso criava registros fantasmas no banco e forçava o frontend a deduplicar.
 *   - A arquitetura foi corrigida: pré-agendamentos confirmados agora viram "canceled"
 *     com metadata.convertedToAppointmentId, e o novo appointment é criado separadamente.
 *
 * Objetivo:
 *   - Migrar todos os appointments com operationalStatus === 'converted' para 'canceled'
 *   - Preservar o link de auditoria em metadata.convertedToAppointmentId
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
    const collection = db.collection('appointments');

    // Contagem inicial
    const totalConverted = await collection.countDocuments({
        operationalStatus: 'converted'
    });

    console.log(`📊 Appointments com operationalStatus='converted': ${totalConverted}`);

    if (totalConverted === 0) {
        console.log('🎉 Nada para fazer.');
        await mongoose.disconnect();
        return;
    }

    if (!COMMIT) {
        console.log('\n⚠️  DRY-RUN: nenhuma alteração será aplicada.');
        console.log('   Exemplos dos primeiros registros:');

        const examples = await collection
            .find({ operationalStatus: 'converted' })
            .limit(5)
            .project({ patientName: 1, patientInfo: 1, date: 1, time: 1, appointmentId: 1, createdAt: 1 })
            .toArray();

        for (const ex of examples) {
            const name = ex.patientInfo?.fullName || ex.patientName || 'Desconhecido';
            console.log(`     - ${name} | ${ex.date?.toISOString()?.split('T')[0]} ${ex.time} → appointmentId: ${ex.appointmentId}`);
        }

        console.log('\n   Rode com --commit para aplicar.\n');
        await mongoose.disconnect();
        return;
    }

    let processed = 0;
    let updated = 0;
    let errors = 0;

    // Cursor para processamento em batch
    const cursor = collection.find({ operationalStatus: 'converted' }).batchSize(BATCH_SIZE);

    let batch = [];

    async function flushBatch() {
        if (batch.length === 0) return;

        const bulkOps = batch.map(doc => ({
            updateOne: {
                filter: { _id: doc._id },
                update: {
                    $set: {
                        operationalStatus: 'canceled',
                        'metadata.convertedToAppointmentId': doc.appointmentId || null,
                        'metadata.convertedAt': doc.importedAt || doc.updatedAt || new Date().toISOString()
                    }
                }
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

    // Flush final
    await flushBatch();

    console.log(`\n📊 Resumo:`);
    console.log(`   Processados: ${processed}`);
    console.log(`   Atualizados: ${updated}`);
    console.log(`   Erros: ${errors}`);

    if (errors === 0) {
        console.log(`\n🎉 Migração concluída com sucesso.`);
    } else {
        console.log(`\n⚠️  Migração concluída com ${errors} erros.`);
    }

    await mongoose.disconnect();
}

run().catch(err => {
    console.error('💥 Erro fatal:', err);
    process.exit(1);
});
