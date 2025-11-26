// scripts/debugLeads.js - DIAGNÓSTICO COMPLETO

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Lead from '../models/Leads.js';
dotenv.config();

async function debugLeads() {
    console.log('🔍 [DEBUG] Iniciando diagnóstico...\n');

    try {
        // 1. MOSTRA CONEXÃO
        console.log('📡 MONGO_URI:', process.env.MONGO_URI?.replace(/:[^:@]+@/, ':***@'));

        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Conectado ao MongoDB\n');

        // 2. MOSTRA DATABASE ATUAL
        const dbName = mongoose.connection.db.databaseName;
        console.log('💾 Database atual:', dbName);
        console.log('📦 Collection:', Lead.collection.name, '\n');

        // 3. TOTAL DE LEADS
        const totalLeads = await Lead.countDocuments({});
        console.log('📊 TOTAL de leads:', totalLeads, '\n');

        // 4. DISTRIBUIÇÃO POR STATUS
        const byStatus = await Lead.aggregate([
            { $group: { _id: "$status", count: { $sum: 1 } } },
            { $sort: { count: -1 } }
        ]);

        console.log('📈 Distribuição por status:');
        byStatus.forEach(s => {
            console.log(`   ${s._id || 'null'}: ${s.count}`);
        });
        console.log('');

        // 5. BUSCA "virou_paciente" (EXATA)
        const convertedExact = await Lead.countDocuments({
            status: 'virou_paciente'
        });
        console.log('✅ Leads com status = "virou_paciente":', convertedExact);

        // 6. BUSCA CASE-INSENSITIVE
        const convertedRegex = await Lead.countDocuments({
            status: /virou_paciente/i
        });
        console.log('✅ Leads com status (case-insensitive):', convertedRegex);

        // 7. LEADS HISTÓRICOS
        const historicos = await Lead.countDocuments({
            name: 'Lead Histórico'
        });
        console.log('✅ Leads históricos importados:', historicos, '\n');

        const historicoTag = await Lead.countDocuments({
            tags: 'historico_importado'
        });
        const importadoTag = await Lead.countDocuments({
            tags: 'importado'
        });

        console.log('🏷️ Leads com tag "historico_importado":', historicoTag);
        console.log('🏷️ Leads com tag "importado":', importadoTag, '\n');

        // 8. EXEMPLOS DE LEADS "virou_paciente"
        const examples = await Lead.find({
            status: 'virou_paciente'
        })
            .limit(3)
            .select('name status contact.phone createdAt')
            .lean();

        console.log('💡 Exemplos de leads convertidos:');
        if (examples.length > 0) {
            examples.forEach((lead, i) => {
                console.log(`   ${i + 1}. ${lead.name} (${lead.contact?.phone}) - ${lead.status}`);
            });
        } else {
            console.log('   ⚠️ NENHUM encontrado!\n');

            // 9. MOSTRA TODOS OS STATUS ÚNICOS
            const allStatuses = await Lead.distinct('status');
            console.log('📋 Status únicos no banco:');
            allStatuses.forEach(s => console.log(`   - "${s}"`));
        }

        console.log('\n');

        // 10. VERIFICA QUERY DO LEARNING SERVICE
        console.log('🔍 Testando query do amandaLearningService.js:');
        const testQuery = await Lead.find({
            status: 'virou_paciente'
        }).lean();
        console.log(`   Resultado: ${testQuery.length} leads encontrados\n`);

        // 11. MOSTRA CAMINHO DO MODEL
        console.log('📂 Model de Lead:');
        console.log(`   File: ${import.meta.url}`);
        console.log(`   Collection: ${Lead.collection.name}`);
        console.log(`   Database: ${mongoose.connection.db.databaseName}\n`);

    } catch (error) {
        console.error('❌ Erro:', error);
    } finally {
        console.log('✅ Diagnóstico concluído!\n');
        process.exit(0);
    }
}

debugLeads();