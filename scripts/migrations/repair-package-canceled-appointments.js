#!/usr/bin/env node
/**
 * 🔥 MIGRAÇÃO: Repara appointments órfãos de packages já cancelados
 *
 * Contexto:
 *   - POST /v2/packages/:id/inactivate escrevia `status: 'canceled'` no
 *     Appointment.updateMany, mas o schema do Appointment não tem campo `status`
 *     (só operationalStatus/clinicalStatus) — Mongoose descartava o valor
 *     silenciosamente (strict mode). Corrigido no PR2 (domain/appointment/cancelAppointments.js
 *     agora usa operationalStatus). Este script repara o dado histórico gerado pelo bug
 *     antes da correção.
 *   - Diagnóstico (2026-07-17): dos 4 packages já cancelados em produção, 2 têm 1
 *     appointment cada ainda preso em operationalStatus não-terminal.
 *
 * Objetivo:
 *   - Para todo Package com status='canceled', encontrar Appointments vinculados
 *     (Appointment.package) cujo operationalStatus não seja 'completed' nem 'canceled',
 *     e marcá-los como operationalStatus='canceled' (soft-cancel — nunca delete,
 *     Appointment é dono do histórico da agenda).
 *
 * Características:
 *   - Idempotente: pode rodar várias vezes
 *   - Try/catch por registro (volume esperado é pequeno, não precisa de batch bulkWrite)
 *   - Dry-run por padrão: use --commit para aplicar
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const COMMIT = process.argv.includes('--commit');
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
    const packagesCol = db.collection('packages');
    const appointmentsCol = db.collection('appointments');

    const canceledPackages = await packagesCol
        .find({ status: 'canceled' })
        .project({ _id: 1 })
        .toArray();

    console.log(`📊 Packages com status='canceled': ${canceledPackages.length}`);

    if (canceledPackages.length === 0) {
        console.log('🎉 Nada para fazer.');
        await mongoose.disconnect();
        return;
    }

    const packageIds = canceledPackages.map(p => p._id);

    const affected = await appointmentsCol
        .find({
            package: { $in: packageIds },
            operationalStatus: { $nin: ['completed', 'canceled'] }
        })
        .toArray();

    console.log(`📊 Appointments órfãos encontrados: ${affected.length}`);

    if (affected.length === 0) {
        console.log('🎉 Nada para fazer.');
        await mongoose.disconnect();
        return;
    }

    if (!COMMIT) {
        console.log('\n⚠️  DRY-RUN: nenhuma alteração será aplicada.\n');
        for (const a of affected) {
            console.log(`   - ${a._id} | package: ${a.package} | operationalStatus atual: ${a.operationalStatus} | date: ${a.date?.toISOString?.() || a.date}`);
        }
        console.log('\n   Rode com --commit para aplicar.\n');
        await mongoose.disconnect();
        return;
    }

    let repaired = 0;
    let errors = 0;

    for (const a of affected) {
        try {
            const result = await appointmentsCol.updateOne(
                { _id: a._id },
                {
                    $set: {
                        operationalStatus: 'canceled',
                        cancelReason: 'package_inactivation_repair',
                        updatedAt: new Date()
                    }
                }
            );
            if (result.modifiedCount > 0) {
                repaired++;
                console.log(`   ✅ ${a._id}: ${a.operationalStatus} → canceled`);
            }
        } catch (err) {
            console.error(`   ❌ Erro no appointment ${a._id}:`, err.message);
            errors++;
        }
    }

    console.log(`\n=== Repair Package Canceled Appointments ===`);
    console.log(`Packages scanned: ${canceledPackages.length}`);
    console.log(`Appointments checked: ${affected.length}`);
    console.log(`Appointments repaired: ${repaired}`);
    console.log(`Errors: ${errors}`);

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
