// auditoria_provisionamento.js
// Verifica os valores do provisionamento para Fevereiro/2026

import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import moment from 'moment-timezone';
import Payment from './models/Payment.js';
import Appointment from './models/Appointment.js';
import Package from './models/Package.js';
import Expense from './models/Expense.js';
import Lead from './models/Leads.js';

const TIMEZONE = 'America/Sao_Paulo';

const auditoria = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('🔍 AUDITORIA DO PROVISIONAMENTO - Fevereiro/2026\n');

  const periodo = { inicio: '2026-02-01', fim: '2026-02-28' };
  const agora = moment().tz(TIMEZONE);

  // ========== 1. GARANTIDO (Caixa do Mês) ==========
  console.log('💰 CAMADA 1: GARANTIDO (Caixa do Mês)');
  console.log('─'.repeat(50));
  
  const payments = await Payment.find({
    status: 'paid',
    paymentDate: { $gte: periodo.inicio, $lte: periodo.fim }
  });
  
  const totalPayments = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
  console.log(`   Pagamentos do mês: ${payments.length}`);
  console.log(`   Total em Caixa: R$ ${totalPayments.toFixed(2)}`);
  console.log();

  // ========== CRÉDITO EM PACOTES (Separado) ==========
  console.log('📦 CRÉDITO EM PACOTES (Dinheiro "Preso")');
  console.log('─'.repeat(50));
  
  const pacotes = await Package.find({
    financialStatus: { $in: ['paid', 'partially_paid'] },
    status: { $in: ['active', 'in-progress'] }
  }).populate('patient', 'fullName');
  
  let creditoPacotes = 0;
  pacotes.forEach(pkg => {
    const sessoesPagas = pkg.paidSessions || 0;
    const sessoesFeitas = pkg.sessionsDone || 0;
    const sessoesRemanescentes = Math.max(0, sessoesPagas - sessoesFeitas);
    const valor = sessoesRemanescentes * (pkg.sessionValue || 0);
    creditoPacotes += valor;
    if (valor > 0) {
      console.log(`   ${pkg.patient?.fullName || 'N/A'}: ${sessoesRemanescentes} sessões × R$ ${pkg.sessionValue} = R$ ${valor.toFixed(2)}`);
    }
  });
  
  console.log(`   TOTAL CRÉDITO PACOTES: R$ ${creditoPacotes.toFixed(2)}`);
  console.log();

  // ========== 2. AGENDADO CONFIRMADO ==========
  console.log('✅ CAMADA 2: AGENDADO CONFIRMADO');
  console.log('─'.repeat(50));
  
  const confirmados = await Appointment.find({
    date: { $gte: periodo.inicio, $lte: periodo.fim },
    operationalStatus: { $in: ['confirmed', 'scheduled'] },
    paymentStatus: { $nin: ['paid', 'package_paid'] }
  });
  
  const totalConfirmados = confirmados.reduce((sum, a) => sum + (a.sessionValue || 0), 0);
  console.log(`   Quantidade: ${confirmados.length}`);
  console.log(`   Valor Bruto: R$ ${totalConfirmados.toFixed(2)}`);
  console.log(`   Valor c/ risco (85%): R$ ${(totalConfirmados * 0.85).toFixed(2)}`);
  console.log();

  // ========== 3. AGENDADO PENDENTE ==========
  console.log('⏳ CAMADA 3: AGENDADO PENDENTE (PROBLEMA AQUI!)');
  console.log('─'.repeat(50));
  
  const pendentes = await Appointment.find({
    date: { $gte: periodo.inicio, $lte: periodo.fim },
    $or: [
      { operationalStatus: 'pending' },
      { operationalStatus: { $exists: false } }
    ],
    clinicalStatus: { $nin: ['completed', 'cancelled'] }
  });
  
  console.log(`   Total encontrados: ${pendentes.length}`);
  
  // Separar por data
  const noFuturo = [];
  const noPassado = [];
  
  pendentes.forEach(apt => {
    const dataApt = moment(apt.date);
    const horasRestantes = dataApt.diff(agora, 'hours');
    const info = {
      id: apt._id.toString(),
      data: apt.date,
      hora: apt.time,
      paciente: apt.patient?.toString(),
      valor: apt.sessionValue || 0,
      horasRestantes
    };
    
    if (horasRestantes >= 0) {
      noFuturo.push(info);
    } else {
      noPassado.push(info);
    }
  });
  
  console.log(`   ✅ No futuro: ${noFuturo.length}`);
  console.log(`   ❌ No passado (BUG!): ${noPassado.length}`);
  
  const valorPendentes = pendentes.reduce((sum, a) => sum + (a.sessionValue || 0), 0);
  console.log(`   Valor Bruto Total: R$ ${valorPendentes.toFixed(2)}`);
  console.log(`   Valor c/ risco (40%): R$ ${(valorPendentes * 0.40).toFixed(2)}`);
  
  if (noPassado.length > 0) {
    console.log(`\n   ⚠️  Exemplos de agendamentos no passado que estão contaminando o cálculo:`);
    noPassado.slice(0, 5).forEach(p => {
      console.log(`      - ${p.data} ${p.hora}: R$ ${p.valor} (${p.horasRestantes}h atrás)`);
    });
  }
  console.log();

  // ========== 4. PIPELINE ==========
  console.log('📈 CAMADA 4: PIPELINE');
  console.log('─'.repeat(50));
  
  const leads = await Lead.find({
    status: { $in: ['interessado_agendamento', 'triagem_agendamento', 'agendado'] },
    createdAt: { $gte: new Date(periodo.inicio) }
  });
  
  console.log(`   Leads em estágio avançado: ${leads.length}`);
  console.log(`   Ticket médio estimado: R$ 180`);
  console.log(`   Valor estimado: R$ ${(leads.length * 180 * 0.30).toFixed(2)}`);
  console.log();

  // ========== 5. SOBREPOSIÇÕES ==========
  console.log('🔍 VERIFICANDO SOBREPOSIÇÕES (DUPLA CONTAGEM)');
  console.log('─'.repeat(50));
  
  // Verificar se há overlap entre confirmados e pendentes
  const confirmadosIds = new Set(confirmados.map(a => a._id.toString()));
  const pendentesIds = new Set(pendentes.map(a => a._id.toString()));
  
  const overlap = [...confirmadosIds].filter(id => pendentesIds.has(id));
  console.log(`   IDs em ambos (confirmado + pendente): ${overlap.length}`);
  
  if (overlap.length > 0) {
    console.log(`   ❌ ERRO: ${overlap.length} agendamentos estão sendo contados 2x!`);
  }
  console.log();

  // ========== 6. RESUMO ==========
  console.log('📊 RESUMO DA AUDITORIA');
  console.log('═'.repeat(50));
  const garantido = totalPayments;
  const agendadoAltoRisco = totalConfirmados * 0.85;
  const agendadoMedioRisco = valorPendentes * 0.40;
  const pipeline = leads.length * 180 * 0.30;
  const totalProvisionado = garantido + agendadoAltoRisco + agendadoMedioRisco + pipeline;
  
  console.log(`   💰 Caixa do Mês:      R$ ${garantido.toFixed(2)}`);
  console.log(`   📦 Crédito Pacotes:   R$ ${creditoPacotes.toFixed(2)}`);
  console.log(`   ─────────────────────────────────`);
  console.log(`   💵 Garantido Total:   R$ ${(garantido + creditoPacotes).toFixed(2)}`);
  console.log();
  console.log(`   📅 Agend. Confirmado: R$ ${agendadoAltoRisco.toFixed(2)} (de R$ ${totalConfirmados.toFixed(2)})`);
  console.log(`   ⏳ Agend. Pendente:   R$ ${agendadoMedioRisco.toFixed(2)} (de R$ ${valorPendentes.toFixed(2)})`);
  console.log(`   📈 Pipeline:          R$ ${pipeline.toFixed(2)}`);
  console.log(`   ─────────────────────────────────`);
  console.log(`   📊 TOTAL PROVISIONADO: R$ ${totalProvisionado.toFixed(2)}`);
  console.log();
  console.log('❗ PROBLEMAS ENCONTRADOS:');
  console.log(`   1. ${noPassado.length} agendamentos do PASSADO estão em "pendente"`);
  console.log(`   2. ${overlap.length} agendamentos podem estar duplicados`);
  if (noPassado.length > 0) {
    console.log(`   3. Valor "pendente" inflado em R$ ${(noPassado.reduce((s, p) => s + p.valor, 0) * 0.40).toFixed(2)} devido a agendamentos antigos`);
  }

  await mongoose.disconnect();
};

auditoria().catch(console.error);
