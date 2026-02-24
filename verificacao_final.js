#!/usr/bin/env node
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

import Package from './models/Package.js';
import Session from './models/Session.js';

async function verificarPaciente(pacienteId, nome) {
    console.log(`\n📋 ${nome}`);
    console.log('=' .repeat(60));
    
    const pacotes = await Package.find({ patient: pacienteId }).lean();
    
    for (const pacote of pacotes) {
        const sessoes = await Session.find({ package: pacote._id }).lean();
        
        const completed = sessoes.filter(s => s.status === 'completed').length;
        const confirmed = sessoes.filter(s => s.status === 'confirmed').length;
        const scheduled = sessoes.filter(s => s.status === 'scheduled').length;
        const canceled = sessoes.filter(s => s.status === 'canceled').length;
        
        console.log(`\n📦 ${pacote.specialty}`);
        console.log(`   Total: ${pacote.totalSessions} | Completed: ${completed} | Confirmed: ${confirmed} | Scheduled: ${scheduled} | Canceled: ${canceled}`);
        console.log(`   sessionsDone no pacote: ${pacote.sessionsDone}`);
        
        if (pacote.sessionsDone !== completed) {
            console.log(`   ⚠️  DIVERGÊNCIA! sessionsDone deveria ser ${completed}`);
            // Corrigir
            await Package.findByIdAndUpdate(pacote._id, { sessionsDone: completed });
            console.log(`   ✅ Corrigido!`);
        } else {
            console.log(`   ✅ OK`);
        }
    }
}

async function main() {
    console.log('╔════════════════════════════════════════════════════════════════╗');
    console.log('║     ✅ VERIFICAÇÃO FINAL                                      ║');
    console.log('╚════════════════════════════════════════════════════════════════╝');

    try {
        await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
        console.log('✅ Conectado!\n');

        await verificarPaciente('692da1e37a66901c8975db66', 'Davi Felipe Araújo');
        await verificarPaciente('69655746dcdf49e2c282800b', 'Nicolas Lucca');
        await verificarPaciente('699869177c92d32c1fd43f86', 'Kauana Queiroz');
        await verificarPaciente('699865f57c92d32c1fd432bc', 'Gabriel Alves Leite');

        console.log('\n' + '='.repeat(60));
        console.log('✅ VERIFICAÇÃO CONCLUÍDA!');
        console.log('='.repeat(60));

    } catch (error) {
        console.error('❌ Erro:', error.message);
    } finally {
        await mongoose.disconnect();
        console.log('\n👋 Desconectado');
    }
}

main();
