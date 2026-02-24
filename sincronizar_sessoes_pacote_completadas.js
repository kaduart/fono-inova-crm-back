#!/usr/bin/env node
/**
 * 🔄 SINCRONIZAR SESSÕES DE PACOTE COM APPOINTMENTS COMPLETED
 * 
 * Problema: Appointment está "completed" mas a sessão do pacote
 * não está com status "completed"
 * 
 * Este script encontra e corrige essas divergências.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

import Appointment from './models/Appointment.js';
import Session from './models/Session.js';
import Package from './models/Package.js';

async function encontrarDivergencias() {
    console.log('\n' + '='.repeat(80));
    console.log('🔍 BUSCANDO DIVERGÊNCIAS');
    console.log('='.repeat(80));

    // Buscar appointments completados que têm pacote e sessão
    const appointments = await Appointment.find({
        clinicalStatus: 'completed',
        package: { $exists: true, $ne: null },
        session: { $exists: true, $ne: null }
    }).populate('session package patient').lean();

    console.log(`Total de appointments completed com pacote: ${appointments.length}`);

    const divergencias = [];

    for (const apt of appointments) {
        const sessao = apt.session;
        
        if (!sessao) continue;
        
        // Verificar se a sessão está com status diferente de completed
        if (sessao.status !== 'completed') {
            divergencias.push({
                appointmentId: apt._id,
                sessionId: sessao._id,
                pacoteId: apt.package?._id,
                paciente: apt.patient?.fullName,
                especialidade: apt.package?.specialty,
                data: apt.date,
                hora: apt.time,
                statusAtualSessao: sessao.status,
                deveriaSer: 'completed'
            });
        }
    }

    return divergencias;
}

async function corrigirDivergencias(divergencias, dryRun = true) {
    console.log('\n' + '='.repeat(80));
    console.log(dryRun ? '🔍 SIMULAÇÃO DE CORREÇÃO' : '🔧 CORRIGINDO');
    console.log('='.repeat(80));

    const corrigidos = [];
    const erros = [];

    for (const div of divergencias) {
        console.log(`\n${dryRun ? '🔍' : '🔧'} ${div.paciente} - ${div.especialidade}`);
        console.log(`   Data: ${div.data} ${div.hora}`);
        console.log(`   Status atual: ${div.statusAtualSessao}`);
        console.log(`   Deveria ser: ${div.deveriaSer}`);

        if (!dryRun) {
            try {
                // Atualizar sessão
                await Session.findByIdAndUpdate(div.sessionId, {
                    status: 'completed',
                    isPaid: true,
                    paymentStatus: 'paid',
                    visualFlag: 'ok',
                    updatedAt: new Date()
                });

                // Atualizar sessionsDone no pacote
                const pacote = await Package.findById(div.pacoteId);
                if (pacote) {
                    // Recalcular sessionsDone baseado em sessões completed
                    const completedCount = await Session.countDocuments({
                        package: div.pacoteId,
                        status: 'completed'
                    });
                    
                    pacote.sessionsDone = completedCount;
                    await pacote.save();
                    
                    console.log(`   ✅ Sessão corrigida + Pacote atualizado (${completedCount} completed)`);
                }

                corrigidos.push(div);
            } catch (error) {
                console.log(`   ❌ Erro: ${error.message}`);
                erros.push({ ...div, erro: error.message });
            }
        }
    }

    return { corrigidos, erros };
}

async function main() {
    const dryRun = !process.argv.includes('--fix');

    console.log('\n╔══════════════════════════════════════════════════════════════════════════════╗');
    console.log('║     🔄 SINCRONIZAR SESSÕES DE PACOTE                                        ║');
    console.log('╚══════════════════════════════════════════════════════════════════════════════╝');
    console.log(`\nModo: ${dryRun ? '🔍 APENAS VERIFICAÇÃO' : '🔧 CORREÇÃO'}`);

    try {
        await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
        console.log('✅ Conectado!\n');

        const divergencias = await encontrarDivergencias();

        if (divergencias.length === 0) {
            console.log('\n✅ Nenhuma divergência encontrada!');
            console.log('Todas as sessões de pacote estão sincronizadas com os appointments.');
            process.exit(0);
        }

        console.log(`\n⚠️  ENCONTRADAS ${divergencias.length} DIVERGÊNCIAS:`);
        
        for (const div of divergencias) {
            console.log(`\n   📅 ${div.paciente}`);
            console.log(`      ${div.especialidade} - ${div.data} ${div.hora}`);
            console.log(`      Sessão: ${div.statusAtualSessao} → deveria ser: ${div.deveriaSer}`);
        }

        const resultado = await corrigirDivergencias(divergencias, dryRun);

        console.log('\n' + '='.repeat(80));
        console.log('📊 RESUMO');
        console.log('='.repeat(80));
        console.log(`Total de divergências: ${divergencias.length}`);
        
        if (!dryRun) {
            console.log(`Corrigidas: ${resultado.corrigidos.length}`);
            console.log(`Erros: ${resultado.erros.length}`);
        } else {
            console.log('\n⚠️  Execute com --fix para aplicar as correções');
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
