#!/usr/bin/env node
/**
 * 💰 SCRIPT: Criar Pagamentos de Convênio Pendentes
 * 
 * Este script busca todas as sessões de convênio que foram realizadas (completed)
 * mas não têm pagamento vinculado, e cria os pagamentos automaticamente.
 * 
 * Uso:
 *   node scripts/criar_pagamentos_convenio.js [--dry-run] [--patient-id=ID]
 * 
 * Opções:
 *   --dry-run         Simula a execução sem criar nada
 *   --patient-id=ID   Processa apenas um paciente específico
 *   --fix-values      Atualiza insuranceGrossAmount nos pacotes (pergunta o valor)
 */

import mongoose from 'mongoose';
import moment from 'moment-timezone';
import dotenv from 'dotenv';
import readline from 'readline';

dotenv.config();

const TIMEZONE = 'America/Sao_Paulo';

// Models
import Patient from '../models/Patient.js';
import Package from '../models/Package.js';
import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import Payment from '../models/Payment.js';
import InsuranceGuide from '../models/InsuranceGuide.js';

// ============================================
// CONFIGURAÇÃO
// ============================================
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FIX_VALUES = args.includes('--fix-values');
const PATIENT_ID_ARG = args.find(arg => arg.startsWith('--patient-id='));
const SPECIFIC_PATIENT_ID = PATIENT_ID_ARG ? PATIENT_ID_ARG.split('=')[1] : null;

// ============================================
// UTILITÁRIOS
// ============================================
const formatCurrency = (value) => {
    return new Intl.NumberFormat('pt-BR', {
        style: 'currency',
        currency: 'BRL'
    }).format(value || 0);
};

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function question(query) {
    return new Promise(resolve => rl.question(query, resolve));
}

// ============================================
// FUNÇÕES PRINCIPAIS
// ============================================

/**
 * Busca sessões de convênio realizadas sem pagamento
 */
async function buscarSessoesSemPagamento() {
    console.log('\n🔍 Buscando sessões de convênio realizadas sem pagamento...\n');

    const matchStage = {
        status: 'completed',
        $or: [
            { paymentMethod: 'convenio' },
            { insuranceGuide: { $exists: true, $ne: null } }
        ]
    };

    if (SPECIFIC_PATIENT_ID) {
        matchStage.patient = new mongoose.Types.ObjectId(SPECIFIC_PATIENT_ID);
    }

    // Busca sessões que não têm payment vinculado
    const sessoes = await Session.aggregate([
        { $match: matchStage },
        {
            $lookup: {
                from: 'payments',
                localField: '_id',
                foreignField: 'session',
                as: 'payments'
            }
        },
        {
            $match: {
                'payments.0': { $exists: false } // Sem pagamentos
            }
        },
        {
            $lookup: {
                from: 'patients',
                localField: 'patient',
                foreignField: '_id',
                as: 'patientInfo'
            }
        },
        {
            $lookup: {
                from: 'packages',
                localField: 'package',
                foreignField: '_id',
                as: 'packageInfo'
            }
        },
        {
            $lookup: {
                from: 'insuranceguides',
                localField: 'insuranceGuide',
                foreignField: '_id',
                as: 'guideInfo'
            }
        },
        {
            $lookup: {
                from: 'appointments',
                localField: 'appointmentId',
                foreignField: '_id',
                as: 'appointmentInfo'
            }
        }
    ]);

    return sessoes;
}

/**
 * Busca pacotes de convênio sem valor definido
 */
async function buscarPacotesSemValor() {
    console.log('\n🔍 Buscando pacotes de convênio sem valor definido...\n');

    const matchStage = {
        type: 'convenio',
        $or: [
            { insuranceGrossAmount: { $exists: false } },
            { insuranceGrossAmount: 0 },
            { insuranceGrossAmount: null }
        ]
    };

    if (SPECIFIC_PATIENT_ID) {
        matchStage.patient = new mongoose.Types.ObjectId(SPECIFIC_PATIENT_ID);
    }

    const pacotes = await Package.find(matchStage)
        .populate('patient', 'fullName')
        .populate('insuranceGuide', 'number insurance')
        .lean();

    return pacotes;
}

/**
 * Cria pagamento para uma sessão de convênio
 */
async function criarPagamento(sessao, valorSessao, session) {
    const patientId = sessao.patient;
    const doctorId = sessao.doctor;
    const sessionId = sessao._id;
    const appointmentId = sessao.appointmentId;
    
    const guide = sessao.guideInfo?.[0];
    const pkg = sessao.packageInfo?.[0];
    
    const insuranceProvider = guide?.insurance || pkg?.insuranceProvider || 'unimed-anapolis';
    const guideNumber = guide?.number || 'N/A';
    
    const paymentData = {
        patient: patientId,
        doctor: doctorId,
        session: sessionId,
        appointment: appointmentId,
        serviceType: 'convenio_session',
        amount: 0, // Paciente não paga
        paymentMethod: 'convenio',
        status: 'paid', // Consideramos "pago" pois o paciente não deve
        billingType: 'convenio',
        insurance: {
            provider: insuranceProvider,
            authorizationCode: guideNumber,
            status: 'pending_billing',
            grossAmount: valorSessao,
            expectedReceiptDate: moment(sessao.date).add(30, 'days').toDate()
        },
        serviceDate: sessao.date,
        paymentDate: sessao.date,
        notes: `Sessão de convênio realizada em ${sessao.date}. Aguardando faturamento.`
    };

    if (DRY_RUN) {
        console.log(`   [DRY-RUN] Simulando criação de Payment:`);
        console.log(`   - Patient: ${patientId}`);
        console.log(`   - Session: ${sessionId}`);
        console.log(`   - Valor: ${formatCurrency(valorSessao)}`);
        console.log(`   - Convênio: ${insuranceProvider}`);
        return { _id: 'DRY-RUN-ID', ...paymentData };
    }

    const payment = new Payment(paymentData);
    await payment.save({ session: session });
    
    return payment;
}

/**
 * Processa as sessões encontradas
 */
async function processarSessoes(sessoes) {
    if (sessoes.length === 0) {
        console.log('✅ Nenhuma sessão sem pagamento encontrada!');
        return { criados: 0, erros: 0 };
    }

    console.log(`\n📋 ${sessoes.length} sessão(ões) encontrada(s) sem pagamento:\n`);

    // Agrupa por pacote para perguntar o valor uma vez por pacote
    const pacotesMap = new Map();
    
    for (const sessao of sessoes) {
        const pkg = sessao.packageInfo?.[0];
        if (pkg && !pacotesMap.has(pkg._id.toString())) {
            pacotesMap.set(pkg._id.toString(), {
                ...pkg,
                sessoes: []
            });
        }
        if (pkg) {
            pacotesMap.get(pkg._id.toString()).sessoes.push(sessao);
        }
    }

    // Pergunta os valores dos pacotes
    const valoresPacotes = new Map();
    
    if (!DRY_RUN && FIX_VALUES) {
        console.log('💰 Configuração de valores por pacote:\n');
        
        for (const [pkgId, pkg] of pacotesMap) {
            console.log(`Pacote: ${pkg._id}`);
            console.log(`  Paciente: ${pkg.patient?.fullName || 'N/A'}`);
            console.log(`  Especialidade: ${pkg.specialty}`);
            console.log(`  Convênio: ${pkg.insuranceProvider || 'N/A'}`);
            console.log(`  Sessões a processar: ${pkg.sessoes.length}`);
            
            const valor = await question(`\n  Digite o valor por sessão (R$) [ex: 180.00]: `);
            const valorNumerico = parseFloat(valor.replace(',', '.'));
            
            if (isNaN(valorNumerico) || valorNumerico <= 0) {
                console.log('  ⚠️ Valor inválido, usando R$ 0,00');
                valoresPacotes.set(pkgId, 0);
            } else {
                valoresPacotes.set(pkgId, valorNumerico);
                
                // Atualiza o pacote com o valor
                await Package.findByIdAndUpdate(pkgId, {
                    insuranceGrossAmount: valorNumerico
                });
                console.log(`  ✅ Pacote atualizado com valor: ${formatCurrency(valorNumerico)}`);
            }
            console.log('');
        }
    } else if (!FIX_VALUES) {
        // Usa valor padrão ou existente
        for (const [pkgId, pkg] of pacotesMap) {
            const valorExistente = pkg.insuranceGrossAmount || 0;
            valoresPacotes.set(pkgId, valorExistente);
        }
    }

    // Confirmação
    if (!DRY_RUN) {
        const confirmacao = await question(`\n⚠️  Deseja criar ${sessoes.length} pagamento(s)? (s/N): `);
        if (confirmacao.toLowerCase() !== 's') {
            console.log('❌ Operação cancelada pelo usuário.');
            return { criados: 0, erros: 0, cancelado: true };
        }
    }

    // Processa as sessões
    let criados = 0;
    let erros = 0;
    const mongoSession = await mongoose.startSession();

    try {
        await mongoSession.startTransaction();

        for (const sessao of sessoes) {
            try {
                const pkg = sessao.packageInfo?.[0];
                const pkgId = pkg?._id?.toString();
                const valorSessao = valoresPacotes.get(pkgId) || 0;

                console.log(`\n📝 Processando sessão ${sessao._id}:`);
                console.log(`   Data: ${sessao.date} às ${sessao.time}`);
                console.log(`   Paciente: ${sessao.patientInfo?.[0]?.fullName || 'N/A'}`);
                console.log(`   Valor: ${formatCurrency(valorSessao)}`);

                const payment = await criarPagamento(sessao, valorSessao, mongoSession);
                
                // Atualiza a sessão com referência ao payment
                if (!DRY_RUN) {
                    await Session.findByIdAndUpdate(
                        sessao._id,
                        { 
                            isPaid: true,
                            paymentStatus: 'paid',
                            sessionValue: valorSessao
                        },
                        { session: mongoSession }
                    );

                    // Atualiza o appointment também
                    if (sessao.appointmentId) {
                        await Appointment.findByIdAndUpdate(
                            sessao.appointmentId,
                            {
                                paymentStatus: 'pending_receipt',
                                insuranceValue: valorSessao
                            },
                            { session: mongoSession }
                        );
                    }
                }

                console.log(`   ✅ Payment criado: ${payment._id}`);
                criados++;

            } catch (error) {
                console.error(`   ❌ Erro ao processar sessão ${sessao._id}:`, error.message);
                erros++;
            }
        }

        if (!DRY_RUN) {
            await mongoSession.commitTransaction();
            console.log('\n✅ Transação commitada com sucesso!');
        } else {
            await mongoSession.abortTransaction();
            console.log('\n[DRY-RUN] Transação abortada (simulação)');
        }

    } catch (error) {
        await mongoSession.abortTransaction();
        console.error('\n❌ Erro na transação:', error);
        throw error;
    } finally {
        await mongoSession.endSession();
    }

    return { criados, erros };
}

/**
 * Mostra resumo dos pacotes sem valor
 */
async function mostrarResumoPacotes(pacotes) {
    if (pacotes.length === 0) {
        console.log('✅ Todos os pacotes têm valor definido!');
        return;
    }

    console.log(`\n📦 ${pacotes.length} pacote(s) sem valor definido:\n`);
    
    for (const pkg of pacotes) {
        console.log(`Pacote: ${pkg._id}`);
        console.log(`  Paciente: ${pkg.patient?.fullName || 'N/A'}`);
        console.log(`  Especialidade: ${pkg.specialty}`);
        console.log(`  Convênio: ${pkg.insuranceProvider || 'N/A'}`);
        console.log(`  Guia: ${pkg.insuranceGuide?.number || 'N/A'}`);
        console.log(`  Sessões: ${pkg.sessionsDone}/${pkg.totalSessions}`);
        console.log(`  Valor Atual: ${formatCurrency(pkg.insuranceGrossAmount)}`);
        console.log('');
    }
}

// ============================================
// MAIN
// ============================================
async function main() {
    console.log('\n');
    console.log('╔══════════════════════════════════════════════════════════════════════════════╗');
    console.log('║         💰 CRIAR PAGAMENTOS DE CONVÊNIO PENDENTES                          ║');
    console.log('╚══════════════════════════════════════════════════════════════════════════════╝');
    
    if (DRY_RUN) {
        console.log('\n🧪 MODO SIMULAÇÃO (dry-run): Nenhuma alteração será feita\n');
    }
    
    if (SPECIFIC_PATIENT_ID) {
        console.log(`\n👤 Processando apenas paciente: ${SPECIFIC_PATIENT_ID}\n`);
    }

    try {
        // Conectar ao MongoDB
        console.log('📡 Conectando ao MongoDB...');
        await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
        console.log('✅ Conectado!\n');

        // Etapa 1: Verificar pacotes sem valor
        const pacotesSemValor = await buscarPacotesSemValor();
        await mostrarResumoPacotes(pacotesSemValor);

        // Etapa 2: Buscar sessões sem pagamento
        const sessoes = await buscarSessoesSemPagamento();
        
        // Etapa 3: Processar sessões
        const resultado = await processarSessoes(sessoes);

        // Resumo final
        console.log('\n' + '='.repeat(80));
        console.log('📊 RESUMO');
        console.log('='.repeat(80));
        console.log(`Pacotes sem valor: ${pacotesSemValor.length}`);
        console.log(`Sessões processadas: ${sessoes.length}`);
        console.log(`Pagamentos criados: ${resultado.criados}`);
        console.log(`Erros: ${resultado.erros}`);
        
        if (resultado.cancelado) {
            console.log('Status: ❌ Cancelado pelo usuário');
        } else if (DRY_RUN) {
            console.log('Status: 🧪 Simulação (nenhuma alteração feita)');
        } else {
            console.log('Status: ✅ Executado');
        }
        console.log('='.repeat(80));

    } catch (error) {
        console.error('\n❌ Erro:', error);
        console.error(error.stack);
    } finally {
        await mongoose.disconnect();
        rl.close();
        console.log('\n👋 Desconectado do MongoDB\n');
    }
}

main();
