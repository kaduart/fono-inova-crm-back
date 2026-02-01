#!/usr/bin/env node
/**
 * 🔧 Script de Correção: convertedToPatient
 * 
 * Corrige leads que têm convertedToPatient = true (boolean)
 * em vez de um ObjectId ou null
 */

import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

async function fixConvertedToPatient() {
    let client;
    try {
        console.log('🔗 Conectando ao MongoDB...');
        client = new MongoClient(MONGODB_URI);
        await client.connect();
        console.log('✅ Conectado!\n');

        const db = client.db();
        const leadsCollection = db.collection('leads');

        // Busca leads com convertedToPatient = true (boolean)
        const leadsToFix = await leadsCollection.find({
            convertedToPatient: true
        }).project({ _id: 1, name: 1 }).toArray();

        console.log(`🔍 Encontrados ${leadsToFix.length} leads com convertedToPatient = true\n`);

        if (leadsToFix.length === 0) {
            console.log('✅ Nenhum lead precisa ser corrigido!');
            return;
        }

        // Mostra os leads encontrados
        console.log('📋 Leads a corrigir:');
        leadsToFix.forEach(lead => {
            console.log(`   - ${lead._id}: ${lead.name || 'Sem nome'}`);
        });
        console.log('');

        // Corrige os leads - remove o campo convertedToPatient
        const result = await leadsCollection.updateMany(
            { convertedToPatient: true },
            { 
                $unset: { convertedToPatient: "" }
            }
        );

        console.log('✅ Correção aplicada!');
        console.log(`   - ${result.modifiedCount} leads corrigidos`);
        console.log(`   - ${result.matchedCount} leads encontrados\n`);

    } catch (error) {
        console.error('❌ Erro:', error.message);
    } finally {
        if (client) {
            await client.close();
            console.log('👋 Desconectado');
        }
    }
}

fixConvertedToPatient();
