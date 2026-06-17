/**
 * Explica a query de histórico de pacientes usada no by-type
 * para validar se o índice composto { patient: 1, createdAt: -1, operationalStatus: 1 }
 * está sendo utilizado.
 *
 * Run: node back/scripts/explain-appointment-history.js
 */
import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url) });

import mongoose from 'mongoose';
import Appointment from '../models/Appointment.js';

const TIMEZONE = 'America/Sao_Paulo';

async function main() {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!uri) {
        console.error('❌ MONGODB_URI ou MONGO_URI não configurado');
        process.exit(1);
    }

    await mongoose.connect(uri);
    console.log('✅ MongoDB conectado:', uri.replace(/\/\/.*@/, '//***@'));

    // Pega uma amostra de pacientes que têm agendamentos recentes
    const sample = await Appointment.aggregate([
        { $match: { operationalStatus: { $nin: ['canceled', 'cancelled'] } } },
        { $group: { _id: '$patient', count: { $sum: 1 } } },
        { $match: { _id: { $ne: null } } },
        { $sort: { count: -1 } },
        { $limit: 20 }
    ]);

    const patientIds = sample.map(s => s._id).filter(Boolean);
    if (patientIds.length === 0) {
        console.log('⚠️ Nenhum paciente encontrado');
        await mongoose.disconnect();
        process.exit(0);
    }

    console.log(`\n🧪 Amostra: ${patientIds.length} pacientes`);

    // Simula a query de history do by-type
    const historyLookback = new Date();
    historyLookback.setFullYear(historyLookback.getFullYear() - 3);

    const explain = await Appointment.find({
        patient: { $in: patientIds },
        operationalStatus: { $nin: ['canceled', 'cancelled'] },
        createdAt: { $gte: historyLookback }
    })
        .select('patient date specialty createdAt operationalStatus')
        .explain('executionStats');

    const stats = explain.executionStats || {};
    const winningPlan = explain.queryPlanner?.winningPlan || {};

    console.log('\n📊 Execution Stats');
    console.log('  totalDocsExamined :', stats.totalDocsExamined);
    console.log('  totalKeysExamined :', stats.totalKeysExamined);
    console.log('  nReturned         :', stats.nReturned);
    console.log('  executionTimeMillis:', stats.executionTimeMillis);
    console.log('  executionStages   :', winningPlan.stage || winningPlan.inputStage?.stage);

    // Navega no plano para achar o estágio de busca por índice
    let stage = winningPlan;
    while (stage && stage.inputStage) {
        stage = stage.inputStage;
    }
    console.log('\n🔍 Estágio folha do winningPlan:');
    console.log('  stage :', stage?.stage);
    console.log('  indexName:', stage?.indexName);
    console.log('  keyPattern:', JSON.stringify(stage?.keyPattern || {}));

    const usedIndex = stage?.indexName || 'NENHUM (COLLSCAN provável)';
    const isIndexScan = stage?.stage === 'IXSCAN';

    console.log('\n' + (isIndexScan ? '✅ Índice sendo usado:' : '⚠️ COLLSCAN detectado:'));
    console.log('  ', usedIndex);

    await mongoose.disconnect();
    process.exit(isIndexScan ? 0 : 1);
}

main().catch(err => {
    console.error('❌ Erro:', err);
    process.exit(1);
});
