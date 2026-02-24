#!/usr/bin/env node
/**
 * 🔍 DIAGNÓSTICO: Davi Felipe Araújo + Bug do "Indefinido"
 * 
 * Este script investiga:
 * 1. Por que os dados do Davi não estão condizentes
 * 2. Por que a sessão fica como "Indefinido" no frontend
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

// Models
import Package from './models/Package.js';
import Session from './models/Session.js';
import Appointment from './models/Appointment.js';
import Payment from './models/Payment.js';

async function diagnosticarDavi() {
    console.log('\n' + '='.repeat(80));
    console.log('📋 DIAGNÓSTICO: Davi Felipe Araújo');
    console.log('='.repeat(80));

    const pacienteId = '692da1e37a66901c8975db66';

    // Buscar todos os pacotes do Davi
    const pacotes = await Package.find({ patient: pacienteId }).lean();
    
    console.log(`\nTotal de pacotes: ${pacotes.length}`);
    
    for (const pacote of pacotes) {
        console.log(`\n📦 ${pacote.specialty.toUpperCase()}`);
        console.log(`   ID: ${pacote._id}`);
        console.log(`   Total Sessões: ${pacote.totalSessions}`);
        console.log(`   Sessions Done (no pacote): ${pacote.sessionsDone}`);
        console.log(`   Valor: R$ ${pacote.insuranceGrossAmount}`);
        
        // Buscar sessões deste pacote
        const sessoes = await Session.find({ package: pacote._id }).lean();
        
        const completed = sessoes.filter(s => s.status === 'completed').length;
        const confirmed = sessoes.filter(s => s.status === 'confirmed').length;
        const scheduled = sessoes.filter(s => s.status === 'scheduled').length;
        const canceled = sessoes.filter(s => s.status === 'canceled').length;
        
        console.log(`\n   Sessões no banco: ${sessoes.length}`);
        console.log(`   - Completed: ${completed}`);
        console.log(`   - Confirmed: ${confirmed}`);
        console.log(`   - Scheduled: ${scheduled}`);
        console.log(`   - Canceled: ${canceled}`);
        
        // Verificar se há divergência
        if (pacote.sessionsDone !== completed) {
            console.log(`\n   ⚠️  DIVERGÊNCIA! sessionsDone=${pacote.sessionsDone} vs completed=${completed}`);
        }
        
        // Mostrar cada sessão
        console.log('\n   Detalhe das sessões:');
        for (const sessao of sessoes.sort((a,b) => a.date.localeCompare(b.date))) {
            const icon = 
                sessao.status === 'completed' ? '✅' :
                sessao.status === 'confirmed' ? '✓' :
                sessao.status === 'scheduled' ? '📅' :
                sessao.status === 'canceled' ? '❌' : '?';
            console.log(`   ${icon} ${sessao.date} ${sessao.time} - ${sessao.status}`);
        }
    }
}

async function diagnosticarBugIndefinido() {
    console.log('\n' + '='.repeat(80));
    console.log('🐛 DIAGNÓSTICO: Bug do "Indefinido" no complete');
    console.log('='.repeat(80));
    
    console.log(`
Análise do problema:

Quando o usuário clica em "Complete" no appointment:

1. O backend atualiza o Appointment para:
   - operationalStatus: 'confirmed'
   - clinicalStatus: 'completed'

2. O backend atualiza a Session para:
   - status: 'completed'
   - isPaid: true (se não for saldo devedor)

3. O frontend espera que session.status seja uma string válida

PROBLEMA POSSÍVEL:
- O appointment tem a session vinculada, mas quando retorna para o frontend,
  o populate da session pode estar falhando
- Ou o appointment.session pode estar null/undefined

Vou verificar appointments recentes completados com pacotes de convênio:
`);

    // Buscar appointments completados recentemente com pacotes
    const appointments = await Appointment.find({
        package: { $exists: true, $ne: null },
        clinicalStatus: 'completed'
    })
    .sort({ updatedAt: -1 })
    .limit(5)
    .populate('session')
    .lean();

    console.log(`\nÚltimos ${appointments.length} appointments completados com pacote:`);
    
    for (const apt of appointments) {
        console.log(`\n📅 ${apt.date} ${apt.time}`);
        console.log(`   ID: ${apt._id}`);
        console.log(`   Pacote: ${apt.package}`);
        console.log(`   Session ID: ${apt.session?._id || apt.session || 'N/A'}`);
        console.log(`   Session Status: ${apt.session?.status || 'N/A (session não populada)'}`);
        
        // Se a session não veio populada, buscar manualmente
        if (!apt.session && apt.session) {
            const sessao = await Session.findById(apt.session).lean();
            console.log(`   Session (busca manual): ${sessao?.status || 'N/A'}`);
        }
    }
}

async function corrigirSessionsDone() {
    console.log('\n' + '='.repeat(80));
    console.log('🔧 CORRIGINDO sessionsDone dos pacotes do Davi');
    console.log('='.repeat(80));

    const pacienteId = '692da1e37a66901c8975db66';
    const pacotes = await Package.find({ patient: pacienteId });

    for (const pacote of pacotes) {
        const sessoesCompleted = await Session.countDocuments({
            package: pacote._id,
            status: 'completed'
        });
        
        if (pacote.sessionsDone !== sessoesCompleted) {
            console.log(`\n📦 ${pacote.specialty}:`);
            console.log(`   sessionsDone atual: ${pacote.sessionsDone}`);
            console.log(`   Real (completed): ${sessoesCompleted}`);
            
            pacote.sessionsDone = sessoesCompleted;
            await pacote.save();
            
            console.log(`   ✅ Corrigido para: ${sessoesCompleted}`);
        } else {
            console.log(`\n✅ ${pacote.specialty}: correto (${sessoesCompleted})`);
        }
    }
}

async function main() {
    console.log('\n╔══════════════════════════════════════════════════════════════════════════════╗');
    console.log('║     🔍 DIAGNÓSTICO: Davi + Bug "Indefinido"                                 ║');
    console.log('╚══════════════════════════════════════════════════════════════════════════════╝');

    try {
        console.log('\n📡 Conectando ao MongoDB...');
        await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
        console.log('✅ Conectado!\n');

        await diagnosticarDavi();
        await diagnosticarBugIndefinido();
        
        // Perguntar se quer corrigir
        console.log('\n' + '='.repeat(80));
        console.log('Deseja corrigir o sessionsDone dos pacotes do Davi?');
        console.log('Execute: node diagnosticar_davi_e_bug_complete.js --fix');
        console.log('='.repeat(80));
        
        if (process.argv.includes('--fix')) {
            await corrigirSessionsDone();
        }

    } catch (error) {
        console.error('\n❌ Erro:', error.message);
        console.error(error.stack);
    } finally {
        await mongoose.disconnect();
        console.log('\n👋 Desconectado\n');
    }
}

main();
