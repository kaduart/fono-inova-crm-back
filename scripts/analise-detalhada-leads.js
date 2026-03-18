/**
 * 📊 ANÁLISE DETALHADA DOS LEADS
 * Investigando "Agenda Direta" e WhatsApp
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const hoje = new Date();
const inicioSemana = new Date(hoje);
inicioSemana.setDate(hoje.getDate() - 7);
inicioSemana.setHours(0, 0, 0, 0);

const leadSchema = new mongoose.Schema({
  name: String,
  contact: { phone: String, email: String },
  origin: String,
  status: String,
  therapyArea: String,
  appointment: {
    seekingFor: String,
    modality: String
  },
  interactions: [{
    message: String,
    channel: String,
    date: Date
  }],
  metaTracking: {
    source: String,
    campaign: String,
    specialty: String,
    firstMessage: String,
    utmSource: String,
    utmCampaign: String
  },
  notes: String,
  createdAt: Date
}, { collection: 'leads' });

const Lead = mongoose.model('Lead', leadSchema);

async function analisar() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Conectado ao MongoDB\n');

    const leadsSemana = await Lead.find({
      createdAt: { $gte: inicioSemana, $lte: hoje }
    }).sort({ createdAt: -1 }).lean();

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('📋 DETALHAMENTO DOS 15 LEADS DA SEMANA');
    console.log('═══════════════════════════════════════════════════════════════\n');

    leadsSemana.forEach((l, i) => {
      const data = new Date(l.createdAt).toLocaleDateString('pt-BR');
      const hora = new Date(l.createdAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      
      console.log(`─`.repeat(60));
      console.log(`#${i + 1} - ${data} às ${hora}`);
      console.log(`   Nome: ${l.name || 'Não informado'}`);
      console.log(`   Origem: ${l.origin || 'N/A'}`);
      console.log(`   Status: ${l.status || 'novo'}`);
      console.log(`   Área Terapêutica: ${l.therapyArea || 'N/A'}`);
      
      if (l.metaTracking) {
        console.log(`   Meta Source: ${l.metaTracking.source || 'N/A'}`);
        console.log(`   Campaign: ${l.metaTracking.campaign || 'N/A'}`);
        console.log(`   Specialty: ${l.metaTracking.specialty || 'N/A'}`);
        console.log(`   UTM Source: ${l.metaTracking.utmSource || 'N/A'}`);
        console.log(`   UTM Campaign: ${l.metaTracking.utmCampaign || 'N/A'}`);
      }
      
      if (l.appointment) {
        console.log(`   Busca: ${l.appointment.seekingFor || 'N/A'} | Mod: ${l.appointment.modality || 'N/A'}`);
      }
      
      if (l.interactions && l.interactions.length > 0) {
        const primeiraMsg = l.interactions[0].message;
        if (primeiraMsg) {
          console.log(`   Primeira mensagem: "${primeiraMsg.substring(0, 80)}..."`);
        }
      }
      
      if (l.notes) {
        console.log(`   Notas: ${l.notes.substring(0, 100)}...`);
      }
      
      console.log('');
    });

    // Análise de campanhas históricas (últimos 30 dias)
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('📊 ÚLTIMOS 30 DIAS - TENDÊNCIA');
    console.log('═══════════════════════════════════════════════════════════════\n');

    const inicioMes = new Date(hoje);
    inicioMes.setDate(hoje.getDate() - 30);

    const leadsMes = await Lead.find({
      createdAt: { $gte: inicioMes, $lte: hoje }
    }).lean();

    console.log(`Total leads (30 dias): ${leadsMes.length}`);

    // Origem nos últimos 30 dias
    const porOrigem30 = {};
    leadsMes.forEach(l => {
      const origem = l.origin || 'Não informado';
      porOrigem30[origem] = (porOrigem30[origem] || 0) + 1;
    });

    console.log('\n📍 Por Origem (30 dias):');
    Object.entries(porOrigem30)
      .sort((a, b) => b[1] - a[1])
      .forEach(([origem, count]) => {
        console.log(`   ${origem}: ${count}`);
      });

    // Verificar leads com Meta tracking
    const comMetaTracking = leadsMes.filter(l => l.metaTracking && l.metaTracking.source);
    console.log(`\n🎯 Leads com Meta Tracking: ${comMetaTracking.length}`);
    
    if (comMetaTracking.length > 0) {
      console.log('   Sources:');
      const sources = {};
      comMetaTracking.forEach(l => {
        const s = l.metaTracking.source;
        sources[s] = (sources[s] || 0) + 1;
      });
      Object.entries(sources).forEach(([s, c]) => console.log(`     ${s}: ${c}`));
    }

    // Semana anterior (comparativo)
    const inicioSemanaPassada = new Date(inicioSemana);
    inicioSemanaPassada.setDate(inicioSemanaPassada.getDate() - 7);
    const fimSemanaPassada = new Date(inicioSemana);

    const leadsSemanaPassada = await Lead.find({
      createdAt: { $gte: inicioSemanaPassada, $lt: inicioSemana }
    }).lean();

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('📊 COMPARATIVO SEMANAL');
    console.log('═══════════════════════════════════════════════════════════════\n');
    
    console.log(`Semana atual (11-18/03): ${leadsSemana.length} leads`);
    console.log(`Semana anterior (04-11/03): ${leadsSemanaPassada.length} leads`);
    
    const variacao = leadsSemana.length - leadsSemanaPassada.length;
    const pctVariacao = leadsSemanaPassada.length > 0 
      ? ((variacao / leadsSemanaPassada.length) * 100).toFixed(1)
      : 0;
    
    if (variacao > 0) {
      console.log(`📈 Variação: +${variacao} leads (+${pctVariacao}%)`);
    } else if (variacao < 0) {
      console.log(`📉 Variação: ${variacao} leads (${pctVariacao}%)`);
    } else {
      console.log(`➡️  Variação: estável`);
    }

    // Análise de conversão
    const convertidosMes = leadsMes.filter(l => l.status === 'virou_paciente' || l.status === 'agendado');
    const taxaConversao = leadsMes.length > 0 
      ? ((convertidosMes.length / leadsMes.length) * 100).toFixed(1)
      : 0;
    
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('📊 TAXA DE CONVERSÃO (30 dias)');
    console.log('═══════════════════════════════════════════════════════════════\n');
    console.log(`Total: ${leadsMes.length} leads`);
    console.log(`Convertidos/Agendados: ${convertidosMes.length}`);
    console.log(`Taxa de conversão: ${taxaConversao}%`);

  } catch (err) {
    console.error('❌ Erro:', err.message);
  } finally {
    await mongoose.disconnect();
  }
}

analisar();
