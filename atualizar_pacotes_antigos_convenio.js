#!/usr/bin/env node
/**
 * 🔄 ATUALIZAÇÃO DE PACOTES ANTIGOS - CONVÊNIO
 * 
 * Este script cria pagamentos para sessões de convênio "completed" 
 * que foram criadas antes da lógica de pagamento existir.
 */

import mongoose from 'mongoose';
import moment from 'moment-timezone';
import dotenv from 'dotenv';
import fs from 'fs';

// Models
import Patient from './models/Patient.js';
import Package from './models/Package.js';
import Session from './models/Session.js';
import Appointment from './models/Appointment.js';
import Payment from './models/Payment.js';

dotenv.config();

const TIMEZONE = 'America/Sao_Paulo';

// ============================================
// CONFIGURAÇÃO
// ============================================
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const patientFilter = args.find(a => a.startsWith('--patient='))?.split('=')[1];

// ============================================
// UTILITÁRIOS
// ============================================
const formatCurrency = (value) => {
    return new Intl.NumberFormat('pt-BR', {
        style: 'currency',
        currency: 'BRL'
    }).format(value || 0);
};

// ============================================
// FUNÇÕES PRINCIPAIS
// ============================================

async function buscarSessoesSemPagamento() {
    console.log('\n' + '='.repeat(80));
    console.log('🔍 BUSCANDO SESSÕES DE CONVÊNIO SEM PAGAMENTO');
    console.log('='.repeat(80));

    const filtroPacote = patientFilter 
        ? { type: 'convenio', patient: patientFilter }
        : { type: 'convenio' };
    
    const pacotes = await Package.find(filtroPacote)
        .populate('patient', 'fullName')
        .populate('doctor', 'fullName')
        .lean();

    console.log(`Total de pacotes de convênio: ${pacotes.length}`);
    
    const sessoesParaCriarPagamento = [];
    
    for (const pacote of pacotes) {
        const sessoes = await Session.find({
            package: pacote._id,
            status: 'completed'
        }).lean();
        
        let semPagamento = 0;
        
        for (const sessao of sessoes) {
            const pagamentoExistente = await Payment.findOne({
                $or: [
                    { session: sessao._id },
                    { appointment: sessao.appointmentId }
                ],
                billingType: 'convenio'
            }).lean();
            
            if (!pagamentoExistente) {
                semPagamento++;
                sessoesParaCriarPagamento.push({
                    sessao,
                    pacote,
                    paciente: pacote.patient,
                    doctor: pacote.doctor
                });
            }
        }
        
        if (semPagamento > 0) {
            console.log(`\n📦 ${pacote.patient?.fullName || 'N/A'}`);
            console.log(`   Pacote: ${pacote.specialty}`);
            console.log(`   Sessões sem pagamento: ${semPagamento}`);
        }
    }
    
    return sessoesParaCriarPagamento;
}

async function criarPagamentos(sessoesParaCriar) {
    console.log('\n' + '='.repeat(80));
    console.log(dryRun ? '🔍 SIMULAÇÃO' : '💰 CRIANDO PAGAMENTOS');
    console.log('='.repeat(80));
    
    const criados = [];
    const erros = [];
    
    for (const item of sessoesParaCriar) {
        const { sessao, pacote, paciente, doctor } = item;
        
        const dadosPagamento = {
            patient: paciente?._id || sessao.patient,
            doctor: doctor?._id || sessao.doctor,
            serviceType: 'package_session',
            amount: 0,
            paymentMethod: 'convenio',
            status: 'paid',
            package: pacote._id,
            session: sessao._id,
            appointment: sessao.appointmentId || null,
            serviceDate: sessao.date,
            paymentDate: sessao.date,
            billingType: 'convenio',
            insurance: {
                provider: pacote.insuranceProvider || 'Unimed',
                status: 'pending_billing',
                grossAmount: pacote.insuranceGrossAmount || 80
            },
            notes: `Criado automaticamente - sessão ${sessao.date}`
        };
        
        console.log(`${dryRun ? '🔍' : '💰'} ${sessao.date} - ${paciente?.fullName} - ${pacote.specialty}`);
        
        if (!dryRun) {
            try {
                const novoPagamento = await Payment.create(dadosPagamento);
                criados.push({
                    pagamentoId: novoPagamento._id,
                    sessaoId: sessao._id,
                    paciente: paciente?.fullName
                });
                console.log(`   ✅ ${novoPagamento._id}`);
            } catch (error) {
                erros.push({ sessaoId: sessao._id, erro: error.message });
                console.log(`   ❌ ${error.message}`);
            }
        }
    }
    
    return { criados, erros };
}

// ============================================
// MAIN
// ============================================
async function main() {
    console.log('\n╔══════════════════════════════════════════════════════════════════════════════╗');
    console.log('║     🔄 ATUALIZAÇÃO DE PACOTES ANTIGOS - CONVÊNIO                            ║');
    console.log('╚══════════════════════════════════════════════════════════════════════════════╝');
    console.log(`\nModo: ${dryRun ? '🔍 SIMULAÇÃO' : '💰 APLICAR'}`);

    try {
        console.log('\n📡 Conectando...');
        await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
        console.log('✅ Conectado!\n');

        const sessoesParaCriar = await buscarSessoesSemPagamento();
        
        if (sessoesParaCriar.length === 0) {
            console.log('\n✅ Todas as sessões já têm pagamentos!');
            process.exit(0);
        }
        
        const resultado = await criarPagamentos(sessoesParaCriar);
        
        console.log('\n' + '='.repeat(80));
        console.log('📊 RESUMO');
        console.log('='.repeat(80));
        console.log(`Total de sessões: ${sessoesParaCriar.length}`);
        
        if (!dryRun) {
            console.log(`Criados: ${resultado.criados.length}`);
            console.log(`Erros: ${resultado.erros.length}`);
        } else {
            console.log('\n⚠️ MODO SIMULAÇÃO - Execute sem --dry-run para aplicar');
        }

    } catch (error) {
        console.error('\n❌ Erro:', error.message);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
        console.log('\n👋 Desconectado\n');
    }
}

main();
