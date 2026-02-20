#!/usr/bin/env node
/**
 * 🔍 AUDITORIA DE CONVÊNIO - NICOLAS LUCCA (Unimed Anápolis)
 * 
 * Este script audita o fluxo completo de convênio para um paciente específico,
 * verificando se os dados estão corretos e se estão alimentando o Financial Dashboard.
 * 
 * Uso:
 *   node auditoria_convenio_nicolas_lucca.js
 * 
 * Saída:
 *   - Relatório completo no console
 *   - Arquivo auditoria_nicolas_lucca.json com os dados brutos
 */

import mongoose from 'mongoose';
import moment from 'moment-timezone';
import dotenv from 'dotenv';
import fs from 'fs';

// Models
import Patient from './models/Patient.js';
import InsuranceGuide from './models/InsuranceGuide.js';
import Package from './models/Package.js';
import Session from './models/Session.js';
import Appointment from './models/Appointment.js';
import Payment from './models/Payment.js';

dotenv.config();

const TIMEZONE = 'America/Sao_Paulo';

// ============================================
// CONFIGURAÇÃO
// ============================================
const PACIENTE_NOME_BUSCA = /nicolas.*lucca|lucca.*nicolas/i;
const CONVENIO_BUSCA = /unimed/i;

// ============================================
// UTILITÁRIOS
// ============================================
const formatCurrency = (value) => {
    return new Intl.NumberFormat('pt-BR', {
        style: 'currency',
        currency: 'BRL'
    }).format(value || 0);
};

const formatDate = (date) => {
    if (!date) return 'N/A';
    return moment(date).tz(TIMEZONE).format('DD/MM/YYYY HH:mm');
};

// ============================================
// FUNÇÕES DE AUDITORIA
// ============================================

/**
 * 1. Busca o paciente Nicolas Lucca
 */
async function auditarPaciente() {
    console.log('\n' + '='.repeat(80));
    console.log('1️⃣  PACIENTE');
    console.log('='.repeat(80));

    const pacientes = await Patient.find({
        fullName: { $regex: PACIENTE_NOME_BUSCA }
    }).lean();

    if (pacientes.length === 0) {
        console.log('❌ Paciente não encontrado com o nome "Nicolas Lucca"');
        
        // Busca por aproximação
        console.log('\n🔍 Buscando pacientes com "Nicolas" ou "Lucca" no nome...');
        const pacientesAprox = await Patient.find({
            $or: [
                { fullName: { $regex: /nicolas/i } },
                { fullName: { $regex: /lucca/i } }
            ]
        }).select('fullName phoneNumber').lean();
        
        if (pacientesAprox.length > 0) {
            console.log('\nPacientes encontrados:');
            pacientesAprox.forEach((p, i) => {
                console.log(`  ${i + 1}. ${p.fullName} (Tel: ${p.phoneNumber || 'N/A'})`);
            });
        }
        return null;
    }

    const paciente = pacientes[0];
    console.log(`✅ Paciente encontrado:`);
    console.log(`   Nome: ${paciente.fullName}`);
    console.log(`   ID: ${paciente._id}`);
    console.log(`   Telefone: ${paciente.phoneNumber || 'N/A'}`);
    console.log(`   CPF: ${paciente.cpf || 'N/A'}`);
    
    return paciente;
}

/**
 * 2. Busca guias de convênio do paciente
 */
async function auditarGuias(pacienteId) {
    console.log('\n' + '='.repeat(80));
    console.log('2️⃣  GUIAS DE CONVÊNIO');
    console.log('='.repeat(80));

    const guias = await InsuranceGuide.find({
        patientId: pacienteId
    }).sort({ createdAt: -1 }).lean();

    if (guias.length === 0) {
        console.log('❌ Nenhuma guia encontrada para este paciente');
        return [];
    }

    console.log(`✅ ${guias.length} guia(s) encontrada(s):\n`);

    const guiasDetalhadas = [];

    for (const guia of guias) {
        const convenioMatch = CONVENIO_BUSCA.test(guia.insurance);
        const statusIcon = guia.status === 'active' ? '🟢' : 
                          guia.status === 'exhausted' ? '🔴' : '🟡';
        
        console.log(`${statusIcon} Guia #${guia.number}`);
        console.log(`   Convênio: ${guia.insurance} ${convenioMatch ? '✅' : '⚠️'}`);
        console.log(`   Especialidade: ${guia.specialty}`);
        console.log(`   Sessões: ${guia.usedSessions}/${guia.totalSessions} (Restantes: ${guia.totalSessions - guia.usedSessions})`);
        console.log(`   Status: ${guia.status}`);
        console.log(`   Expira em: ${formatDate(guia.expiresAt)}`);
        console.log(`   Convertida em pacote: ${guia.packageId ? 'Sim ✅' : 'Não'}`);
        console.log(`   Criada em: ${formatDate(guia.createdAt)}`);
        console.log('');

        guiasDetalhadas.push({
            ...guia,
            isUnimed: convenioMatch
        });
    }

    return guiasDetalhadas;
}

/**
 * 3. Busca pacotes de convênio do paciente
 */
async function auditarPacotes(pacienteId) {
    console.log('\n' + '='.repeat(80));
    console.log('3️⃣  PACOTES DE CONVÊNIO');
    console.log('='.repeat(80));

    const pacotes = await Package.find({
        patient: pacienteId,
        type: 'convenio'
    }).sort({ createdAt: -1 }).lean();

    if (pacotes.length === 0) {
        console.log('❌ Nenhum pacote de convênio encontrado para este paciente');
        return [];
    }

    console.log(`✅ ${pacotes.length} pacote(s) de convênio encontrado(s):\n`);

    for (const pacote of pacotes) {
        const statusIcon = pacote.status === 'active' ? '🟢' : 
                          pacote.status === 'finished' ? '🔴' : '🟡';
        
        console.log(`${statusIcon} Pacote ${pacote._id}`);
        console.log(`   Convênio: ${pacote.insuranceProvider || 'N/A'}`);
        console.log(`   Especialidade: ${pacote.specialty}`);
        console.log(`   Sessões: ${pacote.sessionsDone}/${pacote.totalSessions}`);
        console.log(`   Status: ${pacote.status}`);
        console.log(`   Status Faturamento: ${pacote.insuranceBillingStatus || 'N/A'}`);
        console.log(`   Valor Bruto Convênio: ${formatCurrency(pacote.insuranceGrossAmount)}`);
        console.log(`   Guia vinculada: ${pacote.insuranceGuide || 'N/A'}`);
        console.log(`   Criado em: ${formatDate(pacote.createdAt)}`);
        console.log('');
    }

    return pacotes;
}

/**
 * 4. Busca sessões do paciente (convênio)
 */
async function auditarSessoes(pacienteId, pacotesIds) {
    console.log('\n' + '='.repeat(80));
    console.log('4️⃣  SESSÕES DE CONVÊNIO');
    console.log('='.repeat(80));

    // Sessões vinculadas aos pacotes de convênio
    const sessoes = await Session.find({
        patient: pacienteId,
        $or: [
            { package: { $in: pacotesIds } },
            { paymentMethod: 'convenio' },
            { insuranceGuide: { $exists: true, $ne: null } }
        ]
    }).sort({ date: -1, time: -1 }).lean();

    if (sessoes.length === 0) {
        console.log('❌ Nenhuma sessão de convênio encontrada');
        return [];
    }

    console.log(`✅ ${sessoes.length} sessão(ões) encontrada(s):\n`);

    const sessoesPorStatus = {
        completed: [],
        scheduled: [],
        canceled: [],
        pending: []
    };

    for (const sessao of sessoes) {
        const statusIcon = 
            sessao.status === 'completed' ? '✅' :
            sessao.status === 'scheduled' ? '📅' :
            sessao.status === 'canceled' ? '❌' : '⏳';
        
        const pagoIcon = sessao.isPaid ? '💰' : 
                        sessao.paymentStatus === 'pending_receipt' ? '⏳' : '❓';

        console.log(`${statusIcon} ${pagoIcon} Sessão ${sessao._id}`);
        console.log(`   Data: ${sessao.date} às ${sessao.time}`);
        console.log(`   Status: ${sessao.status}`);
        console.log(`   Pagamento: ${sessao.paymentStatus} (isPaid: ${sessao.isPaid})`);
        console.log(`   Valor: ${formatCurrency(sessao.sessionValue)}`);
        console.log(`   Guia consumida: ${sessao.guideConsumed ? 'Sim ✅' : 'Não'}`);
        console.log(`   Pacote: ${sessao.package || 'N/A'}`);
        console.log('');

        if (sessoesPorStatus[sessao.status]) {
            sessoesPorStatus[sessao.status].push(sessao);
        }
    }

    // Resumo
    console.log('\n📊 RESUMO DAS SESSÕES:');
    console.log(`   Realizadas (completed): ${sessoesPorStatus.completed.length}`);
    console.log(`   Agendadas (scheduled): ${sessoesPorStatus.scheduled.length}`);
    console.log(`   Canceladas (canceled): ${sessoesPorStatus.canceled.length}`);
    console.log(`   Pendentes (pending): ${sessoesPorStatus.pending.length}`);

    return sessoes;
}

/**
 * 5. Busca appointments do paciente (convênio)
 */
async function auditarAppointments(pacienteId) {
    console.log('\n' + '='.repeat(80));
    console.log('5️⃣  APPOINTMENTS (AGENDAMENTOS)');
    console.log('='.repeat(80));

    const appointments = await Appointment.find({
        patient: pacienteId,
        $or: [
            { billingType: 'convenio' },
            { paymentMethod: 'convenio' },
            { serviceType: 'convenio_session' }
        ]
    }).sort({ date: -1, time: -1 }).lean();

    if (appointments.length === 0) {
        console.log('❌ Nenhum appointment de convênio encontrado');
        return [];
    }

    console.log(`✅ ${appointments.length} appointment(s) encontrado(s):\n`);

    for (const apt of appointments) {
        const statusIcon = 
            apt.clinicalStatus === 'completed' ? '✅' :
            apt.operationalStatus === 'scheduled' ? '📅' :
            apt.operationalStatus === 'canceled' ? '❌' : '⏳';

        console.log(`${statusIcon} Appointment ${apt._id}`);
        console.log(`   Data: ${apt.date} às ${apt.time}`);
        console.log(`   Status Operacional: ${apt.operationalStatus}`);
        console.log(`   Status Clínico: ${apt.clinicalStatus}`);
        console.log(`   Status Pagamento: ${apt.paymentStatus}`);
        console.log(`   Tipo Serviço: ${apt.serviceType}`);
        console.log(`   Tipo Faturamento: ${apt.billingType}`);
        console.log(`   Convênio: ${apt.insuranceProvider || 'N/A'}`);
        console.log(`   Valor Convênio: ${formatCurrency(apt.insuranceValue)}`);
        console.log('');
    }

    return appointments;
}

/**
 * 6. Busca pagamentos do paciente (convênio)
 */
async function auditarPagamentos(pacienteId) {
    console.log('\n' + '='.repeat(80));
    console.log('6️⃣  PAGAMENTOS (RECEITA)');
    console.log('='.repeat(80));

    const pagamentos = await Payment.find({
        patient: pacienteId,
        $or: [
            { billingType: 'convenio' },
            { paymentMethod: 'convenio' }
        ]
    }).sort({ paymentDate: -1 }).lean();

    if (pagamentos.length === 0) {
        console.log('❌ Nenhum pagamento de convênio encontrado');
        return [];
    }

    console.log(`✅ ${pagamentos.length} pagamento(s) encontrado(s):\n`);

    let totalRecebido = 0;
    let totalAFaturar = 0;
    let totalFaturado = 0;

    for (const pag of pagamentos) {
        const statusIcon = 
            pag.status === 'paid' ? '💰' :
            pag.status === 'pending' ? '⏳' :
            pag.status === 'billed' ? '📄' : '❓';

        console.log(`${statusIcon} Pagamento ${pag._id}`);
        console.log(`   Data Serviço: ${pag.serviceDate}`);
        console.log(`   Data Pagamento: ${pag.paymentDate}`);
        console.log(`   Status: ${pag.status}`);
        console.log(`   Valor: ${formatCurrency(pag.amount)}`);
        console.log(`   Tipo Faturamento: ${pag.billingType}`);
        
        if (pag.insurance) {
            console.log(`   Convênio: ${pag.insurance.provider || 'N/A'}`);
            console.log(`   Status Convênio: ${pag.insurance.status || 'N/A'}`);
            console.log(`   Valor Bruto: ${formatCurrency(pag.insurance.grossAmount)}`);
            console.log(`   Valor Recebido: ${formatCurrency(pag.insurance.receivedAmount)}`);
            console.log(`   Faturado em: ${formatDate(pag.insurance.billedAt)}`);
            console.log(`   Recebido em: ${formatDate(pag.insurance.receivedAt)}`);
            
            if (pag.insurance.status === 'received') {
                totalRecebido += pag.insurance.receivedAmount || pag.amount || 0;
            } else if (pag.insurance.status === 'billed') {
                totalFaturado += pag.insurance.grossAmount || pag.amount || 0;
            } else if (pag.insurance.status === 'pending_billing') {
                totalAFaturar += pag.insurance.grossAmount || pag.amount || 0;
            }
        }
        console.log('');
    }

    console.log('\n💵 RESUMO FINANCEIRO:');
    console.log(`   A Faturar (pending_billing): ${formatCurrency(totalAFaturar)}`);
    console.log(`   Faturado (billed): ${formatCurrency(totalFaturado)}`);
    console.log(`   Recebido (received): ${formatCurrency(totalRecebido)}`);
    console.log(`   TOTAL: ${formatCurrency(totalAFaturar + totalFaturado + totalRecebido)}`);

    return pagamentos;
}

/**
 * 7. Verifica impacto no Financial Dashboard
 */
async function auditarImpactoFinancialDashboard(pacienteId, pagamentos) {
    console.log('\n' + '='.repeat(80));
    console.log('7️⃣  IMPACTO NO FINANCIAL DASHBOARD');
    console.log('='.repeat(80));

    // Simula o cálculo do FinancialOverviewService
    const hoje = moment().tz(TIMEZONE);
    const mesAtual = hoje.month() + 1;
    const anoAtual = hoje.year();
    
    const startOfMonth = `${anoAtual}-${String(mesAtual).padStart(2, '0')}-01`;
    const endOfMonth = hoje.endOf('month').format('YYYY-MM-DD');

    console.log(`📅 Período analisado: ${startOfMonth} a ${endOfMonth}\n`);

    // Pagamentos do paciente no período
    const pagamentosPeriodo = pagamentos.filter(p => {
        const dataPagamento = p.paymentDate || p.serviceDate;
        return dataPagamento >= startOfMonth && dataPagamento <= endOfMonth;
    });

    console.log(`Pagamentos do paciente no período: ${pagamentosPeriodo.length}`);

    // Verifica como cada pagamento é contabilizado
    let contaComoReceita = 0;
    let naoContaComoReceita = 0;

    for (const pag of pagamentosPeriodo) {
        // Regra do FinancialOverviewService._calculateMetrics
        const ehReceita = pag.status === 'paid' && pag.paymentDate >= startOfMonth && pag.paymentDate <= endOfMonth;
        
        // Regra do "A Receber" (convênios pending_billing)
        const ehAReceber = pag.status === 'paid' && 
                          pag.billingType === 'convenio' && 
                          pag.insurance?.status === 'pending_billing';

        if (ehReceita) {
            contaComoReceita++;
            console.log(`  ✅ Conta como RECEITA: ${pag._id} - ${formatCurrency(pag.amount)}`);
        } else if (ehAReceber) {
            naoContaComoReceita++;
            console.log(`  ⏳ Conta como A RECEBER (não entra no caixa ainda): ${pag._id} - ${formatCurrency(pag.insurance?.grossAmount || pag.amount)}`);
        } else {
            naoContaComoReceita++;
            console.log(`  ❌ NÃO conta no Financial Dashboard: ${pag._id} - Status: ${pag.status}`);
        }
    }

    console.log(`\n📊 RESUMO:`);
    console.log(`   Contam como receita: ${contaComoReceita}`);
    console.log(`   Não contam (pendentes/a receber): ${naoContaComoReceita}`);

    // Verifica se há problema na contabilização
    console.log('\n⚠️  ANÁLISE DE PROBLEMAS:');
    
    const problemas = [];
    
    // Problema 1: Pagamentos de convênio com status 'paid' mas insurance.status 'pending_billing'
    const problema1 = pagamentosPeriodo.filter(p => 
        p.status === 'paid' && 
        p.billingType === 'convenio' && 
        p.insurance?.status === 'pending_billing'
    );
    
    if (problema1.length > 0) {
        problemas.push({
            tipo: 'CONVENIO_NAO_RECEBIDO_CONTA_COMO_RECEITA',
            descricao: 'Pagamentos de convênio marcados como paid mas ainda não recebidos do convênio',
            quantidade: problema1.length,
            valorTotal: problema1.reduce((sum, p) => sum + (p.amount || 0), 0),
            impacto: 'ESTES VALORES ESTÃO ENTRANDO NO CAIXA DO MÊS, MAS O CONVÊNIO AINDA NÃO PAGOU!'
        });
    }

    // Problema 2: Sessões realizadas mas sem pagamento vinculado
    const sessoesSemPagamento = await Session.find({
        patient: pacienteId,
        status: 'completed',
        paymentMethod: 'convenio',
        $or: [
            { isPaid: false },
            { paymentStatus: { $in: ['pending', 'pending_receipt'] } }
        ]
    }).lean();

    if (sessoesSemPagamento.length > 0) {
        problemas.push({
            tipo: 'SESSOES_REALIZADAS_SEM_PAGAMENTO',
            descricao: 'Sessões de convênio realizadas mas não faturadas/recebidas',
            quantidade: sessoesSemPagamento.length,
            valorTotal: 0, // Não sabemos o valor ainda
            impacto: 'ESTAS SESSÕES NÃO ESTÃO GERANDO RECEITA NO SISTEMA!'
        });
    }

    if (problemas.length === 0) {
        console.log('   ✅ Nenhum problema identificado');
    } else {
        for (const prob of problemas) {
            console.log(`\n   🚨 ${prob.tipo}`);
            console.log(`      Descrição: ${prob.descricao}`);
            console.log(`      Quantidade: ${prob.quantidade}`);
            console.log(`      Valor Total: ${formatCurrency(prob.valorTotal)}`);
            console.log(`      Impacto: ${prob.impacto}`);
        }
    }

    return problemas;
}

/**
 * 8. Gera recomendações
 */
function gerarRecomendacoes(auditoria) {
    console.log('\n' + '='.repeat(80));
    console.log('8️⃣  RECOMENDAÇÕES');
    console.log('='.repeat(80));

    const recomendacoes = [];

    // Verifica se há pacotes de convênio
    if (auditoria.pacotes.length > 0) {
        recomendacoes.push({
            prioridade: 'ALTA',
            acao: 'Implementar valor da sessão de convênio no pacote',
            descricao: 'O pacote de convênio precisa ter o insuranceGrossAmount preenchido para gerar receita',
            detalhes: 'Atualizar Package.insuranceGrossAmount com o valor que a Unimed paga por sessão'
        });
    }

    // Verifica sessões sem pagamento
    const sessoesSemPagamento = auditoria.sessoes.filter(s => 
        s.status === 'completed' && !s.isPaid
    );

    if (sessoesSemPagamento.length > 0) {
        recomendacoes.push({
            prioridade: 'ALTA',
            acao: 'Criar pagamentos para sessões realizadas',
            descricao: `${sessoesSemPagamento.length} sessões realizadas não têm pagamento vinculado`,
            detalhes: 'Usar insuranceBilling.js para criar os pagamentos pendentes'
        });
    }

    // Verifica fluxo de caixa de convênios
    recomendacoes.push({
        prioridade: 'MEDIA',
        acao: 'Separar receita de convênio no Financial Dashboard',
        descricao: 'Criar métrica específica para "Receita a Receber de Convênios"',
        detalhes: 'Modificar FinancialOverviewService._calculateMetrics para separar convênios'
    });

    // Verifica visão estratégica
    recomendacoes.push({
        prioridade: 'MEDIA',
        acao: 'Incluir sessões de convênio na Visão Geral Estratégica',
        descricao: 'As sessões de convênio realizadas devem aparecer como receita realizada',
        detalhes: 'Mesmo que o dinheiro só entre mês que vem, a receita foi gerada'
    });

    for (const rec of recomendacoes) {
        const icon = rec.prioridade === 'ALTA' ? '🔴' : rec.prioridade === 'MEDIA' ? '🟡' : '🟢';
        console.log(`${icon} [${rec.prioridade}] ${rec.acao}`);
        console.log(`   ${rec.descricao}`);
        console.log(`   → ${rec.detalhes}\n`);
    }

    return recomendacoes;
}

// ============================================
// MAIN
// ============================================
async function main() {
    console.log('\n');
    console.log('╔══════════════════════════════════════════════════════════════════════════════╗');
    console.log('║          🔍 AUDITORIA DE CONVÊNIO - NICOLAS LUCCA (Unimed Anápolis)          ║');
    console.log('╚══════════════════════════════════════════════════════════════════════════════╝');

    try {
        // Conectar ao MongoDB
        console.log('\n📡 Conectando ao MongoDB...');
        await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
        console.log('✅ Conectado!\n');

        // Executar auditoria
        const auditoria = {};

        // 1. Paciente
        auditoria.paciente = await auditarPaciente();
        if (!auditoria.paciente) {
            console.log('\n❌ Auditoria encerrada - paciente não encontrado');
            process.exit(1);
        }

        const pacienteId = auditoria.paciente._id;

        // 2. Guias
        auditoria.guias = await auditarGuias(pacienteId);

        // 3. Pacotes
        auditoria.pacotes = await auditarPacotes(pacienteId);
        const pacotesIds = auditoria.pacotes.map(p => p._id);

        // 4. Sessões
        auditoria.sessoes = await auditarSessoes(pacienteId, pacotesIds);

        // 5. Appointments
        auditoria.appointments = await auditarAppointments(pacienteId);

        // 6. Pagamentos
        auditoria.pagamentos = await auditarPagamentos(pacienteId);

        // 7. Impacto no Financial Dashboard
        auditoria.problemas = await auditarImpactoFinancialDashboard(pacienteId, auditoria.pagamentos);

        // 8. Recomendações
        auditoria.recomendacoes = gerarRecomendacoes(auditoria);

        // Salvar relatório
        const filename = `auditoria_nicolas_lucca_${moment().format('YYYY-MM-DD_HH-mm')}.json`;
        fs.writeFileSync(filename, JSON.stringify(auditoria, null, 2));
        console.log(`\n💾 Relatório completo salvo em: ${filename}`);

        // Resumo final
        console.log('\n' + '='.repeat(80));
        console.log('📋 RESUMO DA AUDITORIA');
        console.log('='.repeat(80));
        console.log(`Paciente: ${auditoria.paciente.fullName}`);
        console.log(`Guias: ${auditoria.guias.length}`);
        console.log(`Pacotes Convênio: ${auditoria.pacotes.length}`);
        console.log(`Sessões: ${auditoria.sessoes.length}`);
        console.log(`Appointments: ${auditoria.appointments.length}`);
        console.log(`Pagamentos: ${auditoria.pagamentos.length}`);
        console.log(`Problemas identificados: ${auditoria.problemas.length}`);
        console.log('='.repeat(80));

    } catch (error) {
        console.error('\n❌ Erro na auditoria:', error);
        console.error(error.stack);
    } finally {
        await mongoose.disconnect();
        console.log('\n👋 Desconectado do MongoDB\n');
    }
}

main();
