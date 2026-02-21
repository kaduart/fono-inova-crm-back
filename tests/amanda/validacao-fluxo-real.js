#!/usr/bin/env node
/**
 * 🧪 VALIDAÇÃO DE FLUXO REAL - 5 TURNOS
 * 
 * Fluxo: quero agendar fono → joao paulo matos → ele tem 7 anos → aceita Unimed? → prefiro de manhã
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { getOptimizedAmandaResponse } from '../../orchestrators/AmandaOrchestrator.js';
import Leads from '../../models/Leads.js';

const PHONE_TESTE = '5562999999996';

function pass(msg) { console.log(`✅ ${msg}`); }
function fail(msg) { console.log(`❌ ${msg}`); process.exitCode = 1; }
function info(msg) { console.log(`ℹ️  ${msg}`); }

async function limparLead() {
  await Leads.deleteOne({ 'contact.phone': PHONE_TESTE });
}

async function criarLead() {
  await limparLead();
  const lead = new Leads({
    contact: { phone: PHONE_TESTE },
    name: 'Lead Teste',
    patientInfo: {},
    stage: 'novo',
    createdAt: new Date()
  });
  await lead.save();
  return lead;
}

async function enviarMensagem(lead, texto, historico = []) {
  const leadAtual = await Leads.findById(lead._id);
  
  const context = {
    stage: leadAtual?.stage || 'novo',
    messageCount: historico.length,
    conversationHistory: historico.map(h => ({
      role: h.autor === 'Cliente' ? 'user' : 'assistant',
      content: h.texto
    })),
    phone: PHONE_TESTE
  };

  try {
    const resposta = await getOptimizedAmandaResponse({
      content: texto,
      userText: texto,
      lead: leadAtual,
      context: context
    });
    
    await new Promise(r => setTimeout(r, 500));
    
    return {
      texto: resposta.text || resposta,
      lead: await Leads.findById(lead._id)
    };
  } catch (error) {
    console.error('❌ Erro:', error.message);
    return { texto: '[ERRO]', error: true, lead };
  }
}

async function main() {
  console.log('\n🧪 VALIDAÇÃO DE FLUXO REAL\n');
  
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ MongoDB conectado\n');
  
  let lead = await criarLead();
  let historico = [];
  
  const turnos = [
    { msg: 'quero agendar fono', teste: 'TURNO 1: Agendamento fono' },
    { msg: 'joao paulo matos', teste: 'TURNO 2: Nome em minúsculas' },
    { msg: 'ele tem 7 anos', teste: 'TURNO 3: Idade' },
    { msg: 'aceita Unimed?', teste: 'TURNO 4: Pergunta plano (bypass)' },
    { msg: 'prefiro de manhã', teste: 'TURNO 5: Período com de' }
  ];
  
  for (const turno of turnos) {
    console.log(`\n${'═'.repeat(50)}`);
    console.log(turno.teste);
    console.log('═'.repeat(50));
    console.log(`👤 Cliente: ${turno.msg}`);
    
    const resposta = await enviarMensagem(lead, turno.msg, historico);
    
    historico.push({ autor: 'Cliente', texto: turno.msg });
    historico.push({ autor: 'Amanda', texto: resposta.texto });
    
    console.log(`\n🤖 Amanda: ${resposta.texto.substring(0, 200)}...\n`);
    
    // Validações específicas por turno
    if (turno.msg === 'joao paulo matos') {
      const nomeSalvo = resposta.lead?.patientInfo?.fullName;
      if (nomeSalvo) {
        pass(`Nome salvo: "${nomeSalvo}"`);
        if (resposta.texto.toLowerCase().includes('nome')) {
          info('⚠️ Amanda ainda mencionou "nome" na resposta - verificar se pediu de novo');
        }
      } else {
        fail('Nome NÃO foi salvo');
      }
    }
    
    if (turno.msg === 'ele tem 7 anos') {
      const idadeSalva = resposta.lead?.patientInfo?.age;
      if (idadeSalva === 7) {
        pass(`Idade salva: ${idadeSalva}`);
      } else {
        fail(`Idade incorreta: ${idadeSalva} (esperado: 7)`);
      }
    }
    
    if (turno.msg === 'aceita Unimed?') {
      const respostaLower = resposta.texto.toLowerCase();
      const sobrePlano = respostaLower.includes('unimed') || 
                         respostaLower.includes('reembolso') || 
                         respostaLower.includes('plano') ||
                         respostaLower.includes('convênio');
      const pediuQueixa = respostaLower.includes('queixa');
      
      if (sobrePlano && !pediuQueixa) {
        pass('Respondeu sobre plano sem pedir queixa');
      } else if (pediuQueixa) {
        fail('Pediu queixa no meio da resposta sobre plano');
      } else {
        info('Resposta não clara sobre plano');
      }
    }
    
    if (turno.msg === 'prefiro de manhã') {
      const periodoSalvo = resposta.lead?.pendingPreferredPeriod;
      if (periodoSalvo === 'manha') {
        pass(`Período salvo: ${periodoSalvo}`);
      } else {
        fail(`Período incorreto: ${periodoSalvo} (esperado: manha)`);
      }
    }
    
    lead = resposta.lead;
    await new Promise(r => setTimeout(r, 1000));
  }
  
  console.log(`\n${'═'.repeat(50)}`);
  console.log('RESUMO FINAL');
  console.log('═'.repeat(50));
  console.log(`Nome: ${lead?.patientInfo?.fullName || 'NÃO SALVO'}`);
  console.log(`Idade: ${lead?.patientInfo?.age || 'NÃO SALVA'}`);
  console.log(`Período: ${lead?.pendingPreferredPeriod || 'NÃO SALVO'}`);
  console.log(`Área: ${lead?.therapyArea || 'NÃO SALVA'}`);
  
  await mongoose.disconnect();
  console.log('\n🔌 Desconectado');
}

main().catch(err => {
  console.error('❌ Erro:', err);
  process.exit(1);
});
