#!/usr/bin/env node
/**
 * 🔥 MIGRAÇÃO: Backfill de patientInfo a partir do patient populado
 *
 * Contexto:
 *   - patientInfo virou campo legado/duplicado
 *   - Appointments antigos criados sem snapshot ficaram com patientInfo vazio
 *   - Isso causava bug onde nome sumia ao trocar operationalStatus
 *
 * Objetivo:
 *   - Preencher patientInfo nos appointments onde falta ou está vazio
 *   - Garantir consistência para consumidores que ainda leem patientInfo
 *
 * Características:
 *   - Idempotente: pode rodar várias vezes
 *   - Batch processing: não sobrecarrega o MongoDB
 *   - Dry-run por padrão: use --commit para aplicar
 *   - Resume: pode ser interrompido e reiniciado
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
    const totalMissing = await collection.countDocuments({
        patient: { $exists: true, $ne: null },
        $or: [
            { patientInfo: { $exists: false } },
            { patientInfo: null },
            { 'patientInfo.fullName': { $in: ['', null] } }
        ]
    });

    console.log(`📊 Appointments com patientInfo vazio/missing: ${totalMissing}`);

    if (totalMissing === 0) {
        console.log('🎉 Nada para fazer.');
        await mongoose.disconnect();
        return;
    }

    if (!COMMIT) {
        console.log('\n⚠️  DRY-RUN: nenhuma alteração será aplicada.');
        console.log('   Rode com --commit para aplicar.\n');
    }

    let processed = 0;
    let updated = 0;
    let skipped = 0;
    let cursor = null;

    // Busca appointments que precisam de backfill
    const pipeline = [
        {
            $match: {
                patient: { $exists: true, $ne: null },
                $or: [
                    { patientInfo: { $exists: false } },
                    { patientInfo: null },
                    { 'patientInfo.fullName': { $in: ['', null] } }
                ]
            }
        },
        {
            $lookup: {
                from: 'patients',
                localField: 'patient',
                foreignField: '_id',
                as: 'patientDoc'
            }
        },
        { $unwind: { path: '$patientDoc', preserveNullAndEmptyArrays: true } }
    ];

    const aggCursor = collection.aggregate(pipeline, { allowDiskUse: true });

    let batch = [];

    for await (const doc of aggCursor) {
        processed++;
        cursor = doc._id;

        const patientDoc = doc.patientDoc;
        if (!patientDoc || !patientDoc.fullName) {
            skipped++;
            continue;
        }

        const updateOp = {
            updateOne: {
                filter: { _id: doc._id },
                update: {
                    $set: {
                        patientInfo: {
                            fullName: patientDoc.fullName || patientDoc.name || '',
                            phone: patientDoc.phone || '',
                            email: patientDoc.email || null,
                            birthDate: patientDoc.dateOfBirth || patientDoc.birthDate || null
                        }
                    }
                }
            }
        };

        batch.push(updateOp);

        if (batch.length >= BATCH_SIZE) {
            if (COMMIT) {
                await collection.bulkWrite(batch);
            }
            updated += batch.length;
            batch = [];
            console.log(`⏳ Progresso: ${processed}/${totalMissing} processados, ${updated} atualizados, ${skipped} skipped (last _id: ${cursor})`);
        }
    }

    if (batch.length > 0) {
        if (COMMIT) {
            await collection.bulkWrite(batch);
        }
        updated += batch.length;
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📋 RESUMO');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`Total processado: ${processed}`);
    console.log(`Atualizados:      ${updated}`);
    console.log(`Skipped (sem patient): ${skipped}`);
    console.log(`Modo:             ${COMMIT ? 'COMMIT' : 'DRY-RUN'}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    await mongoose.disconnect();
}

run().catch(err => {
    console.error('💥 Erro fatal:', err);
    process.exit(1);
});
